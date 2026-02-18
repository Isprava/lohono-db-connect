#!/usr/bin/env tsx
/**
 * Migration script: Migrate tool_acls from acl.yml to MongoDB
 * 
 * This script reads the old acl.yml file with tool_acls definitions and
 * populates the MongoDB acl_configs collection.
 * 
 * Usage:
 *   npx tsx database/scripts/migrate-tool-acls-to-mongo.ts
 * 
 * Or with custom YAML path:
 *   ACL_CONFIG_PATH=/path/to/old-acl.yml npx tsx database/scripts/migrate-tool-acls-to-mongo.ts
 */

import { MongoClient } from "mongodb";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";

interface AclYamlConfig {
  default_policy?: "open" | "deny";
  superuser_acls?: string[];
  public_tools?: string[];
  disabled_tools?: string[];
  tool_acls?: Record<string, string[]>;
}

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "mcp_client";
const ACL_CONFIG_PATH = process.env.ACL_CONFIG_PATH || resolve(process.cwd(), "database/schema/acl.yml");

async function migrate() {
  console.log("🔄 Starting tool_acls migration to MongoDB...\n");

  // 1. Read YAML file
  if (!existsSync(ACL_CONFIG_PATH)) {
    console.error(`❌ ACL YAML file not found at: ${ACL_CONFIG_PATH}`);
    process.exit(1);
  }

  let yamlConfig: AclYamlConfig;
  try {
    const raw = readFileSync(ACL_CONFIG_PATH, "utf8");
    yamlConfig = yaml.load(raw) as AclYamlConfig;
    console.log(`✅ Loaded YAML from: ${ACL_CONFIG_PATH}`);
  } catch (err) {
    console.error(`❌ Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!yamlConfig.tool_acls || Object.keys(yamlConfig.tool_acls).length === 0) {
    console.log("⚠️  No tool_acls found in YAML file. Nothing to migrate.");
    process.exit(0);
  }

  console.log(`📋 Found ${Object.keys(yamlConfig.tool_acls).length} tool(s) with ACL configs:\n`);
  for (const [toolName, acls] of Object.entries(yamlConfig.tool_acls)) {
    console.log(`   - ${toolName}: [${acls.join(", ")}]`);
  }
  console.log("");

  // 2. Connect to MongoDB
  let client: MongoClient;
  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    console.log(`✅ Connected to MongoDB: ${MONGODB_URI}/${MONGODB_DB_NAME}\n`);
  } catch (err) {
    console.error(`❌ Failed to connect to MongoDB: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const db = client.db(MONGODB_DB_NAME);
  const aclConfigs = db.collection("acl_configs");

  // 3. Migrate tool_acls to MongoDB
  console.log("💾 Migrating tool_acls to MongoDB...\n");
  
  let insertedCount = 0;
  let updatedCount = 0;
  
  for (const [toolName, acls] of Object.entries(yamlConfig.tool_acls)) {
    try {
      const result = await aclConfigs.updateOne(
        { toolName },
        {
          $set: {
            acls,
            updatedAt: new Date(),
            updatedBy: "migration-script",
          },
        },
        { upsert: true }
      );

      if (result.upsertedCount > 0) {
        console.log(`   ✅ Inserted: ${toolName}`);
        insertedCount++;
      } else if (result.modifiedCount > 0) {
        console.log(`   ✅ Updated: ${toolName}`);
        updatedCount++;
      } else {
        console.log(`   ℹ️  No changes: ${toolName} (already exists with same config)`);
      }
    } catch (err) {
      console.error(`   ❌ Failed to migrate ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Optionally migrate global config too
  console.log("\n📋 Checking global ACL config...\n");
  
  const aclGlobalConfig = db.collection("acl_global_config");
  const existingGlobal = await aclGlobalConfig.findOne({});
  
  if (!existingGlobal) {
    console.log("   No global config found in MongoDB. Creating from YAML...");
    await aclGlobalConfig.insertOne({
      default_policy: yamlConfig.default_policy || "open",
      superuser_acls: yamlConfig.superuser_acls || ["STAFF_EDIT"],
      public_tools: yamlConfig.public_tools || [],
      disabled_tools: yamlConfig.disabled_tools || [],
      updatedAt: new Date(),
      updatedBy: "migration-script",
    });
    console.log("   ✅ Global config created in MongoDB");
  } else {
    console.log("   ℹ️  Global config already exists in MongoDB (not overwriting)");
    console.log(`      default_policy: ${existingGlobal.default_policy}`);
    console.log(`      superuser_acls: [${existingGlobal.superuser_acls?.join(", ") || ""}]`);
    console.log(`      public_tools: [${existingGlobal.public_tools?.join(", ") || ""}]`);
    console.log(`      disabled_tools: [${existingGlobal.disabled_tools?.join(", ") || ""}]`);
  }

  // 5. Close connection
  await client.close();

  console.log("\n✅ Migration complete!");
  console.log(`   📊 Summary:`);
  console.log(`      - Inserted: ${insertedCount} tool(s)`);
  console.log(`      - Updated: ${updatedCount} tool(s)`);
  console.log(`      - Total in YAML: ${Object.keys(yamlConfig.tool_acls).length} tool(s)`);
  console.log("\n💡 Next steps:");
  console.log("   1. Restart your MCP server to pick up MongoDB configs");
  console.log("   2. Verify ACL configs via: GET /api/admin/acl/tools");
  console.log("   3. You can now manage tool ACLs via the Admin UI or API");
  console.log("   4. The acl.yml file is now only used for global settings\n");
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
