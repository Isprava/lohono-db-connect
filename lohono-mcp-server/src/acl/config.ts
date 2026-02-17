import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { logger } from "../../../shared/observability/src/logger.js";
import type { AclConfig } from "./types.js";

const DEFAULT_ACL_CONFIG_PATH = path.resolve(
  process.env.ACL_CONFIG_PATH || path.join(process.cwd(), "config", "acl.yml")
);

let aclConfig: AclConfig | null = null;

export function loadAclConfig(configPath?: string): AclConfig {
  if (aclConfig) return aclConfig;

  const filePath = configPath || DEFAULT_ACL_CONFIG_PATH;

  if (!fs.existsSync(filePath)) {
    logger.warn(`ACL config not found at ${filePath} — defaulting to open policy`);
    aclConfig = {
      default_policy: "open",
      superuser_acls: [],
      public_tools: [],
      disabled_tools: [],
      tool_acls: {},
    };
    return aclConfig;
  }

  const raw = yaml.load(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;

  aclConfig = {
    default_policy: (raw.default_policy as "open" | "deny") || "deny",
    superuser_acls: (raw.superuser_acls as string[]) || [],
    public_tools: (raw.public_tools as string[]) || [],
    disabled_tools: (raw.disabled_tools as string[]) || [],
    tool_acls: (raw.tool_acls as Record<string, string[]>) || {},
  };

  const toolCount = Object.keys(aclConfig.tool_acls).length;
  logger.info(`ACL config loaded: ${toolCount} tool rules, policy=${aclConfig.default_policy}`);

  return aclConfig;
}

/** Force reload (useful for testing or hot-reload) */
export function reloadAclConfig(configPath?: string): AclConfig {
  aclConfig = null;
  return loadAclConfig(configPath);
}
