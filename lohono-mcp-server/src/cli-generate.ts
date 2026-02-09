#!/usr/bin/env node
/**
 * CLI: SQL Query Analyzer & Rule Generator
 *
 * Usage:
 *   # From a local SQL file
 *   npm run generate -- query.sql [options]
 *
 *   # From a single Redash query ID
 *   npm run generate -- --redash 42 [options]
 *
 *   # From multiple comma-separated Redash query IDs
 *   npm run generate -- --redash 42,99,103 [options]
 *
 *   # From a CSV file containing Redash query IDs (one per line or comma-separated)
 *   npm run generate -- --redash ids.csv [options]
 *
 * Options:
 *   --redash                     Treat input as Redash query ID(s) or a CSV file of IDs
 *   --name <pattern_name>        Machine-readable name (default: derived from file/query name)
 *   --description <text>         Description (default: auto-derived)
 *   --category <cat>             Category (default: "custom")
 *   --keywords <k1,k2,...>       Comma-separated intent keywords
 *   --out-dir <dir>              Write per-query YAML + code files to this directory
 *   --out-yaml <path>            Write YAML rules to file (single-query mode, default: stdout)
 *   --out-code <path>            Write handler code to file (single-query mode, default: stdout)
 *   --analyze-only               Only run the analyzer, skip rule generation
 */

import fs from "node:fs";
import path from "node:path";
import { analyzeQuery } from "./query-analyzer.js";
import { generateRules, type GenerateOutput } from "./rule-generator.js";
import { RedashClient, parseQueryIds } from "./redash-client.js";

// ── Parse CLI args ─────────────────────────────────────────────────────────

interface CliFlags {
  [key: string]: string;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: CliFlags = {};
  let i = 2; // skip node + script

  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // Boolean flags (no value)
      if (key === "analyze-only" || key === "redash") {
        flags[key] = "true";
        i++;
      } else {
        flags[key] = argv[i + 1] || "";
        i += 2;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }

  return { positional, flags };
}

// ── Types ──────────────────────────────────────────────────────────────────

interface SqlInput {
  /** Identifier (file basename or redash query ID) */
  label: string;
  /** The SQL text */
  sql: string;
  /** Redash query name if applicable */
  redashName?: string;
  /** Redash query description if applicable */
  redashDescription?: string;
}

// ── Resolve inputs ─────────────────────────────────────────────────────────

async function resolveInputs(
  positional: string[],
  flags: CliFlags
): Promise<SqlInput[]> {
  // ── Redash mode ──
  if (flags["redash"] === "true") {
    if (positional.length === 0) {
      console.error("Error: --redash requires query ID(s) or a CSV file path as argument.");
      process.exit(1);
    }

    const raw = positional.join(",");
    let ids: number[];

    // Check if the argument is a file (CSV)
    const maybePath = path.resolve(positional[0]);
    if (positional.length === 1 && fs.existsSync(maybePath) && !isNumericish(positional[0])) {
      const fileContent = fs.readFileSync(maybePath, "utf-8");
      console.error(`📄 Reading query IDs from CSV: ${maybePath}\n`);
      ids = parseQueryIds(fileContent);
    } else {
      ids = parseQueryIds(raw);
    }

    if (ids.length === 0) {
      console.error("Error: no valid query IDs found.");
      process.exit(1);
    }

    console.error(`🌐 Fetching ${ids.length} quer${ids.length === 1 ? "y" : "ies"} from Redash...\n`);
    const client = new RedashClient();
    const results = await client.fetchQueries(ids);

    const inputs: SqlInput[] = [];
    for (const r of results) {
      if (!r.success || !r.query) {
        console.error(`  ❌ Query #${r.id}: ${r.error}`);
        continue;
      }
      console.error(`  ✅ Query #${r.id}: ${r.query.name}`);
      inputs.push({
        label: `redash_${r.id}`,
        sql: r.query.query,
        redashName: r.query.name,
        redashDescription: r.query.description,
      });
    }

    if (inputs.length === 0) {
      console.error("\nNo queries could be fetched. Exiting.");
      process.exit(1);
    }

    console.error("");
    return inputs;
  }

  // ── File mode ──
  if (positional.length === 0) {
    console.error("Usage: cli-generate <sql-file> [options]");
    console.error("       cli-generate --redash <id|ids|csv-file> [options]");
    console.error("");
    console.error("Options:");
    console.error("  --redash              Treat input as Redash query ID(s) or CSV file");
    console.error("  --analyze-only        Only show analysis, skip rule generation");
    console.error("  --name <name>         Pattern name (snake_case)");
    console.error("  --description <text>  Description");
    console.error("  --category <cat>      Category (default: custom)");
    console.error("  --keywords <k1,k2>    Intent keywords (comma-separated)");
    console.error("  --out-dir <dir>       Output directory for batch results");
    console.error("  --out-yaml <path>     Write YAML to file");
    console.error("  --out-code <path>     Write handler code to file");
    process.exit(1);
  }

  const sqlFile = path.resolve(positional[0]);
  if (!fs.existsSync(sqlFile)) {
    console.error(`File not found: ${sqlFile}`);
    process.exit(1);
  }

  return [
    {
      label: path.basename(sqlFile, path.extname(sqlFile)),
      sql: fs.readFileSync(sqlFile, "utf-8"),
    },
  ];
}

// ── Process a single SQL input ─────────────────────────────────────────────

function processSingle(
  input: SqlInput,
  flags: CliFlags
): { analysis: ReturnType<typeof analyzeQuery>; output?: GenerateOutput } {
  console.error(`🔍 Analyzing: ${input.label}\n`);
  const analysis = analyzeQuery(input.sql);

  if (flags["analyze-only"] === "true") {
    return { analysis };
  }

  const patternName =
    flags["name"] ||
    (input.redashName
      ? input.redashName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
      : input.label.replace(/[^a-z0-9_]/gi, "_").toLowerCase());

  const description =
    flags["description"] || input.redashDescription || input.redashName || `Auto-generated from ${input.label}`;

  const category = flags["category"] || "custom";
  const keywords = flags["keywords"]
    ? flags["keywords"].split(",").map((k) => k.trim())
    : undefined;

  console.error(`📝 Generating rules for pattern: ${patternName}\n`);

  const output = generateRules({
    sql: input.sql,
    analysis,
    pattern_name: patternName,
    description,
    category,
    intent_keywords: keywords,
  });

  return { analysis, output };
}

// ── Output helpers ─────────────────────────────────────────────────────────

function printSummary(output: GenerateOutput) {
  console.error("── Summary ──");
  console.error(`  Pattern:    ${output.summary.pattern_name}`);
  console.error(`  Category:   ${output.summary.category}`);
  console.error(`  Tables:     ${output.summary.tables.join(", ")}`);
  console.error(`  Core rules: ${output.summary.core_rules_detected.join(", ") || "(none)"}`);
  console.error(`  Date type:  ${output.summary.date_filter_type}`);
  console.error(`  Structure:  ${output.summary.structure}`);
  console.error("");
}

function writeSingleOutput(output: GenerateOutput, flags: CliFlags) {
  printSummary(output);

  if (flags["out-yaml"]) {
    const dest = path.resolve(flags["out-yaml"]);
    fs.writeFileSync(dest, output.yaml_rules, "utf-8");
    console.error(`✅ YAML rules written to: ${dest}`);
  } else {
    console.log("# ── YAML Rules ──────────────────────────────────────────");
    console.log(output.yaml_rules);
  }

  if (flags["out-code"]) {
    const dest = path.resolve(flags["out-code"]);
    fs.writeFileSync(dest, output.handler_code, "utf-8");
    console.error(`✅ Handler code written to: ${dest}`);
  } else {
    console.log("// ── Handler Code ────────────────────────────────────────");
    console.log(output.handler_code);
  }

  console.log("\n// ── Tool Definition (JSON) ───────────────────────────────");
  console.log(JSON.stringify(output.tool_definition, null, 2));
}

function writeBatchOutput(
  results: { input: SqlInput; output: GenerateOutput }[],
  flags: CliFlags
) {
  const outDir = flags["out-dir"];

  if (outDir) {
    const dir = path.resolve(outDir);
    fs.mkdirSync(dir, { recursive: true });

    for (const { input, output } of results) {
      printSummary(output);

      const yamlPath = path.join(dir, `${output.summary.pattern_name}.yml`);
      fs.writeFileSync(yamlPath, output.yaml_rules, "utf-8");
      console.error(`  ✅ ${yamlPath}`);

      const codePath = path.join(dir, `${output.summary.pattern_name}.handler.ts`);
      fs.writeFileSync(codePath, output.handler_code, "utf-8");
      console.error(`  ✅ ${codePath}`);

      const toolPath = path.join(dir, `${output.summary.pattern_name}.tool.json`);
      fs.writeFileSync(toolPath, JSON.stringify(output.tool_definition, null, 2), "utf-8");
      console.error(`  ✅ ${toolPath}`);
    }

    console.error(`\n✅ ${results.length} quer${results.length === 1 ? "y" : "ies"} processed → ${dir}`);
  } else {
    // Print all to stdout separated by headers
    for (const { input, output } of results) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`# Redash query: ${input.redashName || input.label}`);
      console.log(`${"=".repeat(60)}\n`);
      printSummary(output);

      console.log("# ── YAML Rules ──────────────────────────────────────────");
      console.log(output.yaml_rules);

      console.log("// ── Handler Code ────────────────────────────────────────");
      console.log(output.handler_code);

      console.log("\n// ── Tool Definition (JSON) ───────────────────────────────");
      console.log(JSON.stringify(output.tool_definition, null, 2));
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv);
  const inputs = await resolveInputs(positional, flags);

  // analyze-only mode — just dump analysis JSON
  if (flags["analyze-only"] === "true") {
    for (const input of inputs) {
      const { analysis } = processSingle(input, flags);
      console.log(JSON.stringify({ label: input.label, analysis }, null, 2));
    }
    return;
  }

  // single input → simple output
  if (inputs.length === 1) {
    const { output } = processSingle(inputs[0], flags);
    if (output) writeSingleOutput(output, flags);
    return;
  }

  // batch input → batch output
  const results: { input: SqlInput; output: GenerateOutput }[] = [];
  for (const input of inputs) {
    const { output } = processSingle(input, flags);
    if (output) results.push({ input, output });
  }
  writeBatchOutput(results, flags);
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Check if a string looks like a number or comma-separated numbers */
function isNumericish(s: string): boolean {
  return /^[\d,\s]+$/.test(s);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
