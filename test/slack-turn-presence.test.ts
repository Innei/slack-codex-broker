import { afterEach, describe, expect, it, vi } from "vitest";

import type { SlackSessionRecord } from "../src/types.js";
import { SlackTurnPresence } from "../src/services/slack/slack-turn-presence.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SlackTurnPresence", () => {
  it("keeps presence in assistant status/loading messages only and finalizes it", async () => {
    vi.useFakeTimers();

    const setAssistantThreadStatus = vi.fn(async () => {});
    const setLastSlackReplyAt = vi.fn(async (_channelId: string, _rootThreadTs: string) => session);

    const presence = new SlackTurnPresence({
      slackApi: {
        setAssistantThreadStatus
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

    await presence.noteTurnDelta("turn-1");

    expect(setAssistantThreadStatus).toHaveBeenNthCalledWith(2, {
      channelId: "C123",
      threadTs: "111.222",
      status: "is thinking…",
      loadingMessages: ["正在整理回复", "正在压缩关键信息", "已开始组织回复"]
    });

    await presence.noteSlackMessage({
      session,
      kind: "progress",
      text: "我在拉最新分支复查，先跑一轮测试和看修复点。"
    });

    expect(setAssistantThreadStatus).toHaveBeenNthCalledWith(3, {
      channelId: "C123",
      threadTs: "111.222",
      status: "is thinking…",
      loadingMessages: ["我在拉最新分支复查，先跑一轮测试和看修复点。", "正在运行测试", "正在等待测试结果", "正在核对输出"]
    });

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
  });

  it("surfaces command execution metadata in status only", async () => {
    const setAssistantThreadStatus = vi.fn(async () => {});
    const setLastSlackReplyAt = vi.fn(async (_channelId: string, _rootThreadTs: string) => session);

    const presence = new SlackTurnPresence({
      slackApi: {
        setAssistantThreadStatus
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
      loadingMessages: ["Working in workspace", "Running Bash", "正在等待命令结果", "正在读取输出"]
    }));

    await presence.noteCommandExecution({
      turnId: "turn-1",
      itemId: "cmd-1",
      phase: "completed",
      command: "bash -lc 'pwd'",
      cwd: "/tmp/workspace",
      durationMs: 3_000
    });

    expect(setAssistantThreadStatus).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "is thinking…",
      loadingMessages: ["Working in workspace", "Finished Bash (3s)", "正在处理命令结果", "正在继续处理"]
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
