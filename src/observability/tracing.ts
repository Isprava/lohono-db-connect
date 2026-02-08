/**
 * OpenTelemetry SDK bootstrap — MUST be imported before any other module.
 *
 * Usage:  import "./observability/tracing.js";   // first line of entrypoint
 *
 * Auto-instruments: Express, HTTP, pg, mongodb, dns, net
 * Exports traces + logs via OTLP/gRPC to the OpenTelemetry Collector.
 *
 * When the collector is not available (e.g. observability stack not running),
 * the SDK is either disabled entirely or silently drops export errors —
 * it will never crash the application.
 *
 * Set OTEL_SDK_DISABLED=true to skip initialization completely.
 */

import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
} from "@opentelemetry/api";

// ── Determine if OTel should be enabled ────────────────────────────────────

const otelDisabled =
  process.env.OTEL_SDK_DISABLED === "true" ||
  process.env.OTEL_SDK_DISABLED === "1";

const serviceName = process.env.OTEL_SERVICE_NAME || "lohono-unknown";
const collectorUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4317";

// Set diag level — default to WARN so gRPC export failures don't flood logs
const diagLevel =
  process.env.OTEL_LOG_LEVEL === "debug"
    ? DiagLogLevel.DEBUG
    : process.env.OTEL_LOG_LEVEL === "info"
      ? DiagLogLevel.INFO
      : DiagLogLevel.WARN;
diag.setLogger(new DiagConsoleLogger(), diagLevel);

if (otelDisabled) {
  console.log(`[OTel] SDK disabled for ${serviceName} (OTEL_SDK_DISABLED=true)`);
}

// ── Conditional SDK init ───────────────────────────────────────────────────

let sdk: import("@opentelemetry/sdk-node").NodeSDK | null = null;
let loggerProvider: import("@opentelemetry/sdk-logs").LoggerProvider | null = null;

if (!otelDisabled) {
  // Dynamic imports so the gRPC modules are only loaded when needed
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
  const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-grpc");
  const { Resource } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import("@opentelemetry/semantic-conventions");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const { BatchLogRecordProcessor, LoggerProvider } = await import("@opentelemetry/sdk-logs");

  // ── Resource (identifies this service in SigNoz) ─────────────────────────

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "1.0.0",
    "deployment.environment": process.env.NODE_ENV || "development",
    "service.namespace": "lohono-ai",
    "host.timezone": "Asia/Kolkata",
  });

  // ── Exporters ────────────────────────────────────────────────────────────

  const traceExporter = new OTLPTraceExporter({ url: collectorUrl });
  const logExporter = new OTLPLogExporter({ url: collectorUrl });

  loggerProvider = new LoggerProvider({ resource });
  loggerProvider.addLogRecordProcessor(new BatchLogRecordProcessor(logExporter));

  // ── Auto-instrumentation config ──────────────────────────────────────────

  const instrumentations = getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-express": { enabled: true },
    "@opentelemetry/instrumentation-http": {
      enabled: true,
      headersToSpanAttributes: {
        client: { requestHeaders: ["x-correlation-id", "x-user-email"] },
        server: { requestHeaders: ["x-correlation-id", "x-user-email"] },
      },
    },
    "@opentelemetry/instrumentation-pg": {
      enabled: true,
      enhancedDatabaseReporting: false,
    },
    "@opentelemetry/instrumentation-mongodb": {
      enabled: true,
      enhancedDatabaseReporting: false,
    },
    "@opentelemetry/instrumentation-fs": { enabled: false },
  });

  // ── SDK init ─────────────────────────────────────────────────────────────

  sdk = new NodeSDK({
    resource,
    traceExporter,
    logRecordProcessor: new BatchLogRecordProcessor(logExporter),
    instrumentations,
  });

  sdk.start();
  console.log(`[OTel] ${serviceName} → ${collectorUrl}`);
}

// ── Graceful shutdown ──────────────────────────────────────────────────────

const shutdown = async () => {
  try {
    if (sdk) await sdk.shutdown();
    if (loggerProvider) await loggerProvider.shutdown();
  } catch {
    // Swallow shutdown errors — collector may already be gone
  }
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

export { sdk, loggerProvider, serviceName };
