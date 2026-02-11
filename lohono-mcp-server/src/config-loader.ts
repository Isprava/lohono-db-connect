import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import yaml from "js-yaml";
import { SalesFunnelConfig } from "./sales-funnel-types.js";

const DEFAULT_CONFIG_PATH = resolve(process.cwd(), "database/schema/sales_funnel_rules_v2.yml");

export function loadSalesFunnelConfig(): SalesFunnelConfig {
    // Use env var if set (Docker), otherwise default to local path
    const configPath = process.env.SALES_FUNNEL_RULES_PATH || DEFAULT_CONFIG_PATH;

    if (!existsSync(configPath)) {
        throw new Error(`Sales funnel config file not found at: ${configPath}`);
    }

    try {
        const fileContents = readFileSync(configPath, "utf8");
        const config = yaml.load(fileContents) as SalesFunnelConfig;
        return config;
    } catch (error) {
        console.error("Error loading sales funnel config:", error);
        throw new Error(`Failed to load sales funnel config: ${error instanceof Error ? error.message : String(error)}`);
    }
}
