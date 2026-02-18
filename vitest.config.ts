import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "lohono-mcp-server/src/__tests__/**/*.test.ts",
      "lohono-mcp-client/src/__tests__/**/*.test.ts",
    ],
    exclude: [
      "node_modules/**",
      "dist/**",
      "lohono-chat-client/**",
      // Pre-existing Jest test files (use @jest/globals, not yet migrated)
      "lohono-mcp-server/src/nlq-resolver/__tests__/**",
      "lohono-mcp-server/src/time-range/__tests__/**",
    ],
    environment: "node",
    globals: true,
  },
});
