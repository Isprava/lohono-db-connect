import { describe, it, expect } from "vitest";
import { dbMessagesToClaudeMessages, sanitizeAssistantText } from "../agent.js";
import type { Message } from "../db.js";

function msg(overrides: Partial<Message> & Pick<Message, "role" | "content">): Message {
  return {
    sessionId: "test-session",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("dbMessagesToClaudeMessages", () => {
  it("converts a simple user → assistant exchange", () => {
    const dbMsgs: Message[] = [
      msg({ role: "user", content: "Hello" }),
      msg({ role: "assistant", content: "Hi there!" }),
    ];

    const result = dbMessagesToClaudeMessages(dbMsgs);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: [{ type: "text", text: "Hello" }] });
    expect(result[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Hi there!" }] });
  });

  it("groups tool_use blocks into the assistant turn", () => {
    const dbMsgs: Message[] = [
      msg({ role: "user", content: "Get sales" }),
      msg({ role: "assistant", content: "Let me check." }),
      msg({ role: "tool_use", content: "", toolName: "get_sales_funnel", toolInput: { start_date: "2026-01-01", end_date: "2026-01-31" }, toolUseId: "tu_1" }),
    ];

    const result = dbMessagesToClaudeMessages(dbMsgs);
    expect(result).toHaveLength(2);

    // Second message (assistant) should have both text and tool_use
    const assistantMsg = result[1];
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toHaveLength(2);
    expect((assistantMsg.content as any[])[0].type).toBe("text");
    expect((assistantMsg.content as any[])[1].type).toBe("tool_use");
    expect((assistantMsg.content as any[])[1].name).toBe("get_sales_funnel");
  });

  it("groups tool_result blocks into the user turn", () => {
    const dbMsgs: Message[] = [
      msg({ role: "user", content: "Get sales" }),
      msg({ role: "assistant", content: "" }),
      msg({ role: "tool_use", content: "", toolName: "get_sales_funnel", toolInput: {}, toolUseId: "tu_1" }),
      msg({ role: "tool_result", content: '{"metrics": []}', toolUseId: "tu_1" }),
      msg({ role: "assistant", content: "Here are the results." }),
    ];

    const result = dbMessagesToClaudeMessages(dbMsgs);

    // Should be: user, assistant (text + tool_use), user (tool_result), assistant
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("user");
    expect((result[2].content as any[])[0].type).toBe("tool_result");
    expect(result[3].role).toBe("assistant");
  });

  it("handles empty message list", () => {
    const result = dbMessagesToClaudeMessages([]);
    expect(result).toEqual([]);
  });

  it("handles multiple tool calls in one assistant turn", () => {
    const dbMsgs: Message[] = [
      msg({ role: "user", content: "Compare metrics" }),
      msg({ role: "tool_use", content: "", toolName: "get_leads", toolInput: {}, toolUseId: "tu_1" }),
      msg({ role: "tool_use", content: "", toolName: "get_sales", toolInput: {}, toolUseId: "tu_2" }),
    ];

    const result = dbMessagesToClaudeMessages(dbMsgs);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("assistant");
    expect((result[1].content as any[])).toHaveLength(2);
    expect((result[1].content as any[])[0].name).toBe("get_leads");
    expect((result[1].content as any[])[1].name).toBe("get_sales");
  });
});

describe("sanitizeAssistantText", () => {
  it("removes <function_calls> blocks", () => {
    const input = "Hello <function_calls><invoke name='test'>args</invoke></function_calls> world";
    expect(sanitizeAssistantText(input)).toBe("Hello  world");
  });

  it("removes <invoke> blocks", () => {
    const input = "Before <invoke name='tool'>content</invoke> after";
    expect(sanitizeAssistantText(input)).toBe("Before  after");
  });

  it("removes <parameter> blocks", () => {
    const input = "Text <parameter name='x'>value</parameter> more";
    expect(sanitizeAssistantText(input)).toBe("Text  more");
  });

  it("removes ```xml code blocks", () => {
    const input = "Text ```xml\n<some>xml</some>\n``` more";
    expect(sanitizeAssistantText(input)).toBe("Text  more");
  });

  it("trims whitespace", () => {
    expect(sanitizeAssistantText("  hello  ")).toBe("hello");
  });

  it("preserves normal markdown content", () => {
    const input = "Here are your **results**:\n\n| Metric | Count |\n|--------|-------|\n| Leads  | 42    |";
    expect(sanitizeAssistantText(input)).toBe(input);
  });
});
