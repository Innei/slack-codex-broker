import { describe, it, expect, vi } from "vitest";
import {
  parseSlashCommand,
  executeSlashCommand,
  type SlashCommandContext
} from "../src/services/slack/slash-commands.js";

describe("parseSlashCommand", () => {
  it("parses /help command", () => {
    const result = parseSlashCommand("/help");
    expect(result).toEqual({ command: "help", args: "" });
  });

  it("parses /h alias for help", () => {
    const result = parseSlashCommand("/h");
    expect(result).toEqual({ command: "help", args: "" });
  });

  it("parses /? alias for help", () => {
    const result = parseSlashCommand("/?");
    expect(result).toEqual({ command: "help", args: "" });
  });

  it("parses /usage command", () => {
    const result = parseSlashCommand("/usage");
    expect(result).toEqual({ command: "usage", args: "" });
  });

  it("parses /rate-limit alias for usage", () => {
    const result = parseSlashCommand("/rate-limit");
    expect(result).toEqual({ command: "usage", args: "" });
  });

  it("parses /quota alias for usage", () => {
    const result = parseSlashCommand("/quota");
    expect(result).toEqual({ command: "usage", args: "" });
  });

  it("parses /status command", () => {
    const result = parseSlashCommand("/status");
    expect(result).toEqual({ command: "status", args: "" });
  });

  it("parses /stat alias for status", () => {
    const result = parseSlashCommand("/stat");
    expect(result).toEqual({ command: "status", args: "" });
  });

  it("parses /workspace command", () => {
    const result = parseSlashCommand("/workspace");
    expect(result).toEqual({ command: "workspace", args: "" });
  });

  it("parses /ws alias for workspace", () => {
    const result = parseSlashCommand("/ws");
    expect(result).toEqual({ command: "workspace", args: "" });
  });

  it("parses /pwd alias for workspace", () => {
    const result = parseSlashCommand("/pwd");
    expect(result).toEqual({ command: "workspace", args: "" });
  });

  it("parses /model command", () => {
    const result = parseSlashCommand("/model");
    expect(result).toEqual({ command: "model", args: "" });
  });

  it("parses /sessions command", () => {
    const result = parseSlashCommand("/sessions");
    expect(result).toEqual({ command: "sessions", args: "" });
  });

  it("parses /list alias for sessions", () => {
    const result = parseSlashCommand("/list");
    expect(result).toEqual({ command: "sessions", args: "" });
  });

  it("parses commands with arguments", () => {
    const result = parseSlashCommand("/help some extra args");
    expect(result).toEqual({ command: "help", args: "some extra args" });
  });

  it("returns null for non-slash messages", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand("  ")).toBeNull();
  });

  it("returns null for unknown commands", () => {
    expect(parseSlashCommand("/unknown")).toBeNull();
    expect(parseSlashCommand("/foo")).toBeNull();
  });

  it("handles case insensitivity", () => {
    expect(parseSlashCommand("/HELP")).toEqual({ command: "help", args: "" });
    expect(parseSlashCommand("/Help")).toEqual({ command: "help", args: "" });
    expect(parseSlashCommand("/STATUS")).toEqual({ command: "status", args: "" });
  });

  it("trims whitespace", () => {
    expect(parseSlashCommand("  /help  ")).toEqual({ command: "help", args: "" });
    expect(parseSlashCommand("/help   args  ")).toEqual({ command: "help", args: "args" });
  });
});

describe("executeSlashCommand", () => {
  const createMockContext = (overrides: Partial<SlashCommandContext> = {}): SlashCommandContext => ({
    config: {} as any,
    sessions: {
      listSessions: vi.fn().mockReturnValue([])
    } as any,
    codex: {
      readAccountRateLimits: vi.fn().mockResolvedValue({
        rateLimits: {
          limitId: "test",
          limitName: "Test Limit",
          primary: { usedPercent: 42, windowDurationMins: 60, resetsAt: Date.now() / 1000 + 3600 },
          secondary: null,
          credits: null,
          planType: "pro"
        },
        rateLimitsByLimitId: null
      }),
      readAccountSummary: vi.fn().mockResolvedValue({
        account: { type: "pro" },
        quota: {},
        usage: {}
      })
    } as any,
    channelId: "C123",
    rootThreadTs: "111.222",
    session: undefined,
    ...overrides
  });

  it("executes /help command", async () => {
    const context = createMockContext();
    const result = await executeSlashCommand({ command: "help", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("Available Commands");
    expect(result.text).toContain("/help");
    expect(result.text).toContain("/usage");
    expect(result.text).toContain("/status");
  });

  it("executes /usage command", async () => {
    const context = createMockContext();
    const result = await executeSlashCommand({ command: "usage", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("Rate Limits");
    expect(context.codex.readAccountRateLimits).toHaveBeenCalled();
  });

  it("executes /status command without session", async () => {
    const context = createMockContext();
    const result = await executeSlashCommand({ command: "status", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("No active session");
  });

  it("executes /status command with session", async () => {
    const context = createMockContext({
      session: {
        key: "C123:111.222",
        channelId: "C123",
        rootThreadTs: "111.222",
        workspacePath: "/path/to/workspace",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        codexThreadId: "thread-123456789012",
        activeTurnId: undefined
      }
    });
    const result = await executeSlashCommand({ command: "status", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("Session Status");
    expect(result.text).toContain("C123:111.222");
    expect(result.text).toContain("/path/to/workspace");
  });

  it("executes /workspace command without session", async () => {
    const context = createMockContext();
    const result = await executeSlashCommand({ command: "workspace", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("No active session");
  });

  it("executes /workspace command with session", async () => {
    const context = createMockContext({
      session: {
        key: "C123:111.222",
        channelId: "C123",
        rootThreadTs: "111.222",
        workspacePath: "/path/to/workspace",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });
    const result = await executeSlashCommand({ command: "workspace", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("/path/to/workspace");
  });

  it("executes /model command", async () => {
    const context = createMockContext();
    const result = await executeSlashCommand({ command: "model", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("Model Information");
    expect(context.codex.readAccountSummary).toHaveBeenCalled();
  });

  it("executes /sessions command with no sessions", async () => {
    const context = createMockContext();
    const result = await executeSlashCommand({ command: "sessions", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("No active sessions");
  });

  it("executes /sessions command with sessions", async () => {
    const context = createMockContext({
      sessions: {
        listSessions: vi.fn().mockReturnValue([
          {
            key: "C123:111.222",
            channelId: "C123",
            rootThreadTs: "111.222",
            workspacePath: "/path/1",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            activeTurnId: "turn-123"
          },
          {
            key: "C456:333.444",
            channelId: "C456",
            rootThreadTs: "333.444",
            workspacePath: "/path/2",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        ])
      } as any
    });
    const result = await executeSlashCommand({ command: "sessions", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("Active Sessions");
    expect(result.text).toContain("2 total");
    expect(result.text).toContain("[ACTIVE]");
    expect(result.text).toContain("<-- current");
  });

  it("displays correct percentage for /usage (usedPercent is already 0-100)", async () => {
    const context = createMockContext();
    const result = await executeSlashCommand({ command: "usage", args: "" }, context);

    expect(result.handled).toBe(true);
    // usedPercent=42 means 42% used, 58% remaining — not 4200%
    expect(result.text).toContain("58% remaining");
    expect(result.text).not.toContain("4200%");
    expect(result.text).not.toMatch(/-\d+% remaining/);
  });

  it("handles usage command errors gracefully", async () => {
    const context = createMockContext({
      codex: {
        readAccountRateLimits: vi.fn().mockRejectedValue(new Error("Connection failed")),
        readAccountSummary: vi.fn().mockResolvedValue({})
      } as any
    });
    const result = await executeSlashCommand({ command: "usage", args: "" }, context);

    expect(result.handled).toBe(true);
    expect(result.text).toContain("Failed to fetch usage information");
    expect(result.text).toContain("Connection failed");
  });
});
