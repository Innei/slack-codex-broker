import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlackSessionRecord } from "../src/types.js";
import { SlackTurnPresence } from "../src/services/slack/slack-turn-presence.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SlackTurnPresence", () => {
  it("updates dynamic status text, starts a thinking stream, and finalizes it", async () => {
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

    expect(setAssistantThreadStatus).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      threadTs: "111.222",
      status: "is thinking…",
      loadingMessages: expect.arrayContaining(["正在理解请求"])
    }));

    await vi.advanceTimersByTimeAsync(1_500);

    expect(startThreadStream).toHaveBeenCalledTimes(1);
    expect(startThreadStream).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      threadTs: "111.222",
      recipientUserId: "U123",
      recipientTeamId: "T123",
      taskDisplayMode: "plan",
      markdownText: "思考过程：\n- 已开始查看上下文",
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "task_update",
          title: "理解请求",
          status: "complete"
        }),
        expect.objectContaining({
          type: "task_update",
          title: "查看上下文",
          status: "in_progress"
        })
      ])
    }));

    await presence.noteTurnDelta("turn-1");

    expect(appendThreadStream).toHaveBeenCalledTimes(1);
    expect(appendThreadStream).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "C123",
      streamTs: "111.333",
      markdownText: "\n- 已开始组织回复",
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "task_update",
          title: "整理回复",
          status: "in_progress"
        })
      ])
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

  it("surfaces command execution metadata in status and thinking stream", async () => {
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
      turnId: "turn-1"
    });

    await presence.noteCommandExecution({
      turnId: "turn-1",
      itemId: "cmd-1",
      phase: "started",
      command: "bash -lc 'pwd'",
      cwd: "/tmp/workspace"
    });

    expect(setAssistantThreadStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "is thinking…",
      loadingMessages: expect.arrayContaining(["Working in workspace", "Running Bash"])
    }));
    expect(startThreadStream).toHaveBeenCalledWith(expect.objectContaining({
      markdownText: "思考过程：\n- Running Bash",
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "plan_update",
          title: "Working in workspace"
        }),
        expect.objectContaining({
          type: "task_update",
          title: "执行命令",
          details: "Running Bash"
        })
      ])
    }));

    await presence.noteCommandExecution({
      turnId: "turn-1",
      itemId: "cmd-1",
      phase: "completed",
      command: "bash -lc 'pwd'",
      cwd: "/tmp/workspace",
      durationMs: 3_000
    });

    expect(appendThreadStream).toHaveBeenCalledWith(expect.objectContaining({
      markdownText: "\n- Finished Bash (3s)",
      chunks: expect.arrayContaining([
        expect.objectContaining({
          type: "task_update",
          title: "执行命令",
          output: "Finished Bash (3s)"
        })
      ])
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
