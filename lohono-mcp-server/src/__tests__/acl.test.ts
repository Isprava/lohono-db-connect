import { describe, it, expect, beforeEach } from "vitest";
import { resolveUserEmail, reloadAclConfig, loadAclConfig } from "../acl.js";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import yaml from "js-yaml";

describe("acl", () => {
  describe("resolveUserEmail", () => {
    const originalEnv = process.env.MCP_USER_EMAIL;

    beforeEach(() => {
      delete process.env.MCP_USER_EMAIL;
    });

    it("returns _meta.user_email with highest priority", () => {
      const result = resolveUserEmail(
        { user_email: "meta@test.com" },
        "session@test.com"
      );
      expect(result).toBe("meta@test.com");
    });

    it("falls back to session email when meta is absent", () => {
      const result = resolveUserEmail(undefined, "session@test.com");
      expect(result).toBe("session@test.com");
    });

    it("falls back to env var when both meta and session are absent", () => {
      process.env.MCP_USER_EMAIL = "env@test.com";
      const result = resolveUserEmail(undefined, undefined);
      expect(result).toBe("env@test.com");
      process.env.MCP_USER_EMAIL = originalEnv;
    });

    it("returns undefined when no source is available", () => {
      const result = resolveUserEmail(undefined, undefined);
      expect(result).toBeUndefined();
    });

    it("trims whitespace from _meta.user_email", () => {
      const result = resolveUserEmail({ user_email: "  padded@test.com  " });
      expect(result).toBe("padded@test.com");
    });

    it("ignores empty string in _meta.user_email", () => {
      const result = resolveUserEmail(
        { user_email: "  " },
        "session@test.com"
      );
      expect(result).toBe("session@test.com");
    });
  });

  describe("loadAclConfig", () => {
    it("returns open policy when config file is missing", () => {
      // Force reload with a non-existent path
      const config = reloadAclConfig("/tmp/non-existent-acl.yml");
      expect(config.default_policy).toBe("open");
      expect(config.superuser_acls).toEqual([]);
      expect(config.public_tools).toEqual([]);
      expect(config.disabled_tools).toEqual([]);
    });

    it("loads a valid YAML config correctly", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-test-"));
      const tmpFile = path.join(tmpDir, "acl.yml");

      const testConfig = {
        default_policy: "deny",
        superuser_acls: ["ADMIN"],
        public_tools: ["health"],
        disabled_tools: ["dangerous_tool"],
        tool_acls: {
          get_sales: ["SALES_VIEW", "MANAGER"],
        },
      };

      fs.writeFileSync(tmpFile, yaml.dump(testConfig));

      const config = reloadAclConfig(tmpFile);
      expect(config.default_policy).toBe("deny");
      expect(config.superuser_acls).toEqual(["ADMIN"]);
      expect(config.public_tools).toEqual(["health"]);
      expect(config.disabled_tools).toEqual(["dangerous_tool"]);
      expect(config.tool_acls["get_sales"]).toEqual(["SALES_VIEW", "MANAGER"]);

      // Cleanup
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    });
  });
});
