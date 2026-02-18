import { describe, it, expect, beforeEach } from "vitest";
import { resolveUserEmail, clearAclConfigCache } from "../acl.js";

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

  describe("clearAclConfigCache", () => {
    it("clears cache without throwing", () => {
      expect(() => clearAclConfigCache()).not.toThrow();
    });
  });
});
