import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlackSessionRecord } from "../src/types.js";
import { SlackTurnPresence } from "../src/services/slack/slack-turn-presence.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SlackTurnPresence", () => {
  it("sets assistant status, starts a thinking-steps stream, and finalizes it", async () => {
    vi.useFakeTimers();

    const setAssistantThreadStatus = vi.fn(async () => {});
    const startThreadStream = vi.fn(async () => "111.333");
    const appendThreadStream = vi.fn(async () => {});
    const stopThreadStream = vi.fn(async () => {});
    const setLastSlackReplyAt = vi.fn(async (_channelId: string, _rootThreadTs: string) => session);

    const presence = new SlackTurnPresence({
      slackApi: {
        setAssistantThreadStatus,
        startThreadStream,
        appendThreadStream,
        stopThreadStream
      },
      sessions: {
        setLastSlackReplyAt
      }
    });

    await presence.beginTurn({
      session,
      turnId: "turn-1",
      recipientUserId: "U123",
      recipientTeamId: "T123"
    });

    expect(setAssistantThreadStatus).toHaveBeenCalledWith({
      channelId: "C123",
      threadTs: "111.222",
      status: "is thinking…",
      loadingMessages: ["正在理解请求", "正在查看上下文", "正在整理回复"]
    });

    await vi.advanceTimersByTimeAsync(1_500);

    expect(startThreadStream).toHaveBeenCalledTimes(1);
    expect(startThreadStream).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      threadTs: "111.222",
      recipientUserId: "U123",
      recipientTeamId: "T123",
      taskDisplayMode: "plan"
    }));

    await presence.noteTurnDelta("turn-1");

    expect(appendThreadStream).toHaveBeenCalledTimes(1);
    expect(appendThreadStream).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      streamTs: "111.333",
      markdownText: "\n- 已开始组织回复"
    }));

    await presence.noteSlackMessage({
      session,
      kind: "final",
      text: "done"
    });

    expect(setAssistantThreadStatus).toHaveBeenLastCalledWith({
      channelId: "C123",
      threadTs: "111.222",
      status: "",
      loadingMessages: undefined
    });
    expect(stopThreadStream).toHaveBeenCalledTimes(1);
    expect(stopThreadStream).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      streamTs: "111.333",
      markdownText: "\n- 已发送最终回复"
    }));
  });
});

const session: SlackSessionRecord = {
  key: "C123:111.222",
  channelId: "C123",
  rootThreadTs: "111.222",
  workspacePath: "/tmp/workspace",
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z"
};
