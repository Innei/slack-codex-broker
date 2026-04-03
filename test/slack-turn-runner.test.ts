import { describe, expect, it, vi } from "vitest";

import type { SlackSessionRecord } from "../src/types.js";
import { SlackTurnRunner } from "../src/services/slack/slack-turn-runner.js";

describe("SlackTurnRunner", () => {
  it("resets a missing stored codex thread id and starts a fresh thread", async () => {
    let currentSession: SlackSessionRecord = {
      key: "C123:111.222",
      channelId: "C123",
      rootThreadTs: "111.222",
      workspacePath: "/tmp/workspace",
      codexThreadId: "thread-old",
      createdAt: "2026-03-16T00:00:00.000Z",
      updatedAt: "2026-03-16T00:00:00.000Z"
    };

    const ensureThread = vi.fn(async (session: SlackSessionRecord) => {
      if (session.codexThreadId === "thread-old") {
        throw new Error("no rollout found for thread id thread-old");
      }

      return "thread-new";
    });

    const setActiveTurnId = vi.fn(async () => currentSession);
    const setCodexThreadId = vi.fn(async (_channelId: string, _rootThreadTs: string, codexThreadId: string | undefined) => {
      currentSession = {
        ...currentSession,
        codexThreadId
      };
      return currentSession;
    });

    const runner = new SlackTurnRunner({
      codex: {
        ensureThread,
        steer: vi.fn(),
        startTurn: vi.fn(),
        interrupt: vi.fn(),
        readTurnResult: vi.fn()
      } as any,
      slackApi: {
        getUserIdentity: vi.fn(),
        downloadImageAsDataUrl: vi.fn()
      } as any,
      sessions: {
        setActiveTurnId,
        setCodexThreadId
      } as any,
      inboundStore: {} as any,
      memory: {
        buildContextBlock: vi.fn()
      } as any
    });

    const result = await runner.ensureCodexThread(currentSession);

    expect(ensureThread).toHaveBeenCalledTimes(2);
    expect(setActiveTurnId).toHaveBeenCalledWith("C123", "111.222", undefined);
    expect(setCodexThreadId).toHaveBeenNthCalledWith(1, "C123", "111.222", undefined);
    expect(setCodexThreadId).toHaveBeenNthCalledWith(2, "C123", "111.222", "thread-new");
    expect(result.codexThreadId).toBe("thread-new");
  });
});
