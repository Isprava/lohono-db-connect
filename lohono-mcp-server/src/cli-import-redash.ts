#!/usr/bin/env node
/**
 * CLI: Import Redash Queries and Update Configuration
 *
 * This tool fetches queries from Redash, generates rules, and automatically
 * updates the configuration files and tool definitions.
 *
 * Usage:
 *   npm run import-redash -- <query_ids> [options]
 *
 * Examples:
 *   npm run import-redash -- 42
 *   npm run import-redash -- 42,99,103
 *   npm run import-redash -- 42 --category revenue_analysis
 *   npm run import-redash -- 42,99 --keywords "monthly revenue,sales breakdown"
 *   npm run import-redash -- 42 --dry-run
 *
 * Options:
 *   --category <cat>           Category (default: "custom")
 *   --keywords <k1,k2,...>     Comma-separated intent keywords
 *   --dry-run                  Show what would be updated without making changes
 *   --no-backup                Don't create backup files before updating
 *   --restart                  Restart docker services after update
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { analyzeQuery } from "./query-analyzer.js";
import { generateRules, type GenerateOutput } from "./rule-generator.js";
import { RedashClient, parseQueryIds } from "./redash-client.js";
import { execSync } from "node:child_process";

// ── Types ──────────────────────────────────────────────────────────────────

interface CliFlags {
  category?: string;
  keywords?: string;
  "dry-run"?: boolean;
  "no-backup"?: boolean;
  restart?: boolean;
}

interface ImportResult {
  queryId: number;
  queryName: string;
  patternName: string;
  output: GenerateOutput;
}

// ── Parse CLI args ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { queryIds: string; flags: CliFlags } {
  const args = argv.slice(2);
  if (args.length === 0 || args[0].startsWith("--")) {
    console.error("Usage: cli-import-redash <query_ids> [options]");
    console.error("");
    console.error("Examples:");
    console.error("  npm run import-redash -- 42");
    console.error("  npm run import-redash -- 42,99,103");
    console.error("  npm run import-redash -- 42 --category revenue_analysis");
    console.error("  npm run import-redash -- 42 --keywords \"monthly revenue,sales breakdown\"");
    console.error("  npm run import-redash -- 42 --dry-run");
    console.error("");
    console.error("Options:");
    console.error("  --category <cat>       Category (default: custom)");
    console.error("  --keywords <k1,k2>     Intent keywords (comma-separated)");
    console.error("  --dry-run              Show changes without applying them");
    console.error("  --no-backup            Don't create backup files");
    console.error("  --restart              Restart docker services after update");
    process.exit(1);
  }

  const queryIds = args[0];
  const flags: CliFlags = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key === "dry-run" || key === "no-backup" || key === "restart") {
        flags[key] = true;
      } else if (i + 1 < args.length) {
        flags[key as keyof CliFlags] = args[++i] as any;
      }
    }
  }

  return { queryIds, flags };
}

// ── Fetch and generate ─────────────────────────────────────────────────────

async function fetchAndGenerate(
  queryIds: string,
  flags: CliFlags
): Promise<ImportResult[]> {
  const ids = parseQueryIds(queryIds);
  
  if (ids.length === 0) {
    console.error("❌ No valid query IDs found");
    process.exit(1);
  }

  console.log(`\n🌐 Fetching ${ids.length} quer${ids.length === 1 ? "y" : "ies"} from Redash...\n`);
  
  const client = new RedashClient();
  const results = await client.fetchQueries(ids);

  const importResults: ImportResult[] = [];

  for (const r of results) {
    if (!r.success || !r.query) {
      console.error(`  ❌ Query #${r.id}: ${r.error}`);
      continue;
    }

    console.log(`  ✅ Query #${r.id}: ${r.query.name}`);

    // Generate pattern name from query name
    const patternName = r.query.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");

    // Analyze and generate rules
    const analysis = analyzeQuery(r.query.query);
    const category = flags.category || "custom";
    const keywords = flags.keywords
      ? flags.keywords.split(",").map((k) => k.trim())
      : undefined;

    const output = generateRules({
      sql: r.query.query,
      analysis,
      pattern_name: patternName,
      description: r.query.description || r.query.name,
      category,
      intent_keywords: keywords,
    });

    importResults.push({
      queryId: r.id,
      queryName: r.query.name,
      patternName,
      output,
    });
  }

  console.log("");
  return importResults;
}

// ── Update configuration files ─────────────────────────────────────────────

function updateYamlConfig(
  results: ImportResult[],
  dryRun: boolean,
  noBackup: boolean
): void {
  const configPath = path.resolve(process.cwd(), "config/sales_funnel_rules_v2.yml");

  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config file not found: ${configPath}`);
    process.exit(1);
  }

  // Load existing config
  const rawConfig = fs.readFileSync(configPath, "utf-8");
  const config = yaml.load(rawConfig) as any;

  if (!config.query_patterns) {
    config.query_patterns = {};
  }

  // Add new patterns
  for (const result of results) {
    const patternYaml = yaml.load(result.output.yaml_rules) as any;
    const patternKey = Object.keys(patternYaml.query_patterns)[0];
    const patternData = patternYaml.query_patterns[patternKey];

    if (config.query_patterns[patternKey]) {
      console.log(`  ⚠️  Pattern '${patternKey}' already exists, will be overwritten`);
    }

    config.query_patterns[patternKey] = patternData;
  }

  // Generate new YAML content
  const newYaml = yaml.dump(config, { lineWidth: 120, noRefs: true });

  if (dryRun) {
    console.log("\n📄 [DRY RUN] Would update config/sales_funnel_rules_v2.yml:");
    for (const result of results) {
      console.log(`  + query_patterns.${result.patternName}`);
    }
    return;
  }

  // Create backup
  if (!noBackup) {
    const backupPath = `${configPath}.backup.${Date.now()}`;
    fs.copyFileSync(configPath, backupPath);
    console.log(`\n💾 Backup created: ${path.basename(backupPath)}`);
  }

  // Write updated config
  fs.writeFileSync(configPath, newYaml, "utf-8");
  console.log(`\n✅ Updated: config/sales_funnel_rules_v2.yml`);
  for (const result of results) {
    console.log(`  + query_patterns.${result.patternName}`);
  }
}

function updateToolsFile(
  results: ImportResult[],
  dryRun: boolean,
  noBackup: boolean
): void {
  const toolsPath = path.resolve(process.cwd(), "lohono-mcp-server/src/tools.ts");

  if (!fs.existsSync(toolsPath)) {
    console.error(`❌ Tools file not found: ${toolsPath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(toolsPath, "utf-8");

  // Find the toolDefinitions array
  const toolDefStart = content.indexOf("export const toolDefinitions = [");
  if (toolDefStart === -1) {
    console.error("❌ Could not find toolDefinitions array in tools.ts");
    process.exit(1);
  }

  // Generate tool definitions to add
  const newToolDefs: string[] = [];
  const newHandlers: string[] = [];

  for (const result of results) {
    const toolDef = result.output.tool_definition;
    newToolDefs.push(`  ${JSON.stringify(toolDef, null, 2).replace(/\n/g, "\n  ")},`);
    newHandlers.push(result.output.handler_code);
  }

  if (dryRun) {
    console.log("\n📄 [DRY RUN] Would add to lohono-mcp-server/src/tools.ts:");
    for (const result of results) {
      console.log(`  + Tool definition for '${result.output.tool_definition.name}'`);
      console.log(`  + Handler for '${result.output.tool_definition.name}'`);
    }
    console.log("\n⚠️  Note: Manual integration required for tool definitions and handlers");
    console.log("   The tool will show you the code to add, but won't modify tools.ts automatically");
    console.log("   to avoid breaking existing code.");
    return;
  }

  // Show the code to add manually
  console.log("\n📝 Add these tool definitions to lohono-mcp-server/src/tools.ts:");
  console.log("\n// Add to toolDefinitions array:");
  console.log(newToolDefs.join("\n"));

  console.log("\n// Add these handlers to handleToolCall function:");
  for (const handler of newHandlers) {
    console.log("\n" + handler);
  }

  console.log("\n⚠️  Manual step required: Copy the above code into tools.ts");
}

// ── Restart services ───────────────────────────────────────────────────────

function restartServices(): void {
  console.log("\n🔄 Rebuilding and restarting services...");
  
  try {
    execSync("npm run build", { stdio: "inherit" });
    execSync("docker compose up -d --build mcp-server mcp-client", { stdio: "inherit" });
    console.log("\n✅ Services restarted successfully");
  } catch (error) {
    console.error("\n❌ Failed to restart services:", error);
    process.exit(1);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { queryIds, flags } = parseArgs(process.argv);

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║       Redash Query Import & Configuration Update          ║");
  console.log("╚════════════════════════════════════════════════════════════╝");

  // Fetch and generate
  const results = await fetchAndGenerate(queryIds, flags);

  if (results.length === 0) {
    console.error("❌ No queries could be imported");
    process.exit(1);
  }

  // Show summary
  console.log("\n📊 Import Summary:");
  console.log("═".repeat(60));
  for (const result of results) {
    console.log(`\n  Query #${result.queryId}: ${result.queryName}`);
    console.log(`  → Pattern: ${result.patternName}`);
    console.log(`  → Category: ${result.output.summary.category}`);
    console.log(`  → Tables: ${result.output.summary.tables.join(", ")}`);
    console.log(`  → Structure: ${result.output.summary.structure}`);
  }
  console.log("\n" + "═".repeat(60));

  // Update configuration
  console.log("\n📝 Updating configuration files...");
  updateYamlConfig(results, flags["dry-run"] || false, flags["no-backup"] || false);
  updateToolsFile(results, flags["dry-run"] || false, flags["no-backup"] || false);

  // Restart services if requested and not dry-run
  if (flags.restart && !flags["dry-run"]) {
    restartServices();
  } else if (!flags["dry-run"]) {
    console.log("\n💡 Tip: Run with --restart to automatically rebuild and restart services");
    console.log("   Or manually run: npm run build && docker compose up -d --build mcp-server mcp-client");
  }

  if (flags["dry-run"]) {
    console.log("\n✅ Dry run completed - no changes were made");
  } else {
    console.log("\n✅ Import completed successfully!");
    console.log("\n📋 Next steps:");
    console.log("   1. Review and manually add the tool definitions and handlers shown above");
    console.log("   2. Run: npm run build");
    console.log("   3. Run: docker compose up -d --build mcp-server mcp-client");
  }
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
