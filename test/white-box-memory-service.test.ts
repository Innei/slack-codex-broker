import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PersistedInboundMessage, SlackSessionRecord } from "../src/types.js";
import { WhiteBoxMemoryService } from "../src/services/memory/white-box-memory-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => {
    await fs.rm(root, { force: true, recursive: true });
  }));
});

describe("WhiteBoxMemoryService", () => {
  it("stores task-ledger memory for the current section and replays it in turn context", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-memory-"));
    tempRoots.push(rootDir);

    const service = new WhiteBoxMemoryService({ rootDir });
    const session = createSession("C123:111.222", "C123", "111.222");

    await service.captureTurn({
      session,
      messages: [
        createMessage({
          messageTs: "1.001",
          text: "开始实现 slack codex 的跨 section 工作记忆",
          userId: "U123"
        })
      ],
      turnId: "turn-1",
      assistantMessage: "已经接入了基础 task ledger 读写链路。",
      turnSignalKind: "progress"
    });

    const contextBlock = await service.buildContextBlock({
      session,
      userId: "U123"
    });

    expect(contextBlock).toContain("current_section");
    expect(contextBlock).toContain("开始实现 slack codex 的跨 section 工作记忆");
    expect(contextBlock).toContain("status: in_progress");
    expect(contextBlock).toContain("outputs: 已经接入了基础 task ledger 读写链路。");

    const sectionLedger = JSON.parse(
      await fs.readFile(sectionLedgerPath(rootDir, "U123", session.key), "utf8")
    ) as { tasks: Array<{ request: string; status: string }> };
    expect(sectionLedger.tasks[0]?.request).toBe("开始实现 slack codex 的跨 section 工作记忆");
    expect(sectionLedger.tasks[0]?.status).toBe("in_progress");
  });

  it("exposes recent work from other sections for the same user", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "work-memory-"));
    tempRoots.push(rootDir);

    const service = new WhiteBoxMemoryService({ rootDir });
    const oldSession = createSession("C123:111.222", "C123", "111.222");
    const newSession = createSession("C123:222.333", "C123", "222.333");

    await service.captureTurn({
      session: oldSession,
      messages: [
        createMessage({
          messageTs: "1.001",
          text: "修复 broker 里的 section memory 注入问题",
          userId: "U123"
        })
      ],
      turnId: "turn-1",
      assistantMessage: "已完成注入链路修复。",
      turnSignalKind: "final"
    });

    const contextBlock = await service.buildContextBlock({
      session: newSession,
      userId: "U123"
    });

    expect(contextBlock).toContain("recent_sections");
    expect(contextBlock).toContain("C123:111.222");
    expect(contextBlock).toContain("修复 broker 里的 section memory 注入问题");
    expect(contextBlock).toContain("status: completed");
  });
});

function createSession(key: string, channelId: string, rootThreadTs: string): SlackSessionRecord {
  return {
    key,
    channelId,
    rootThreadTs,
    workspacePath: "/tmp/workspace",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z"
  };
}

function createMessage(options: {
  messageTs: string;
  text: string;
  userId: string;
}): PersistedInboundMessage {
  return {
    key: `${options.userId}:${options.messageTs}`,
    sessionKey: "session",
    channelId: "C123",
    rootThreadTs: "111.222",
    messageTs: options.messageTs,
    source: "thread_reply",
    userId: options.userId,
    text: options.text,
    senderKind: "user",
    mentionedUserIds: [],
    images: [],
    status: "done",
    createdAt: "2026-04-03T00:00:00.000Z",
    updatedAt: "2026-04-03T00:00:00.000Z"
  };
}

function sectionLedgerPath(rootDir: string, userId: string, sectionKey: string): string {
  return path.join(
    rootDir,
    "users",
    sanitizePathSegmentForTest(userId),
    "sections",
    `${sanitizePathSegmentForTest(sectionKey)}.json`
  );
}

function sanitizePathSegmentForTest(value: string): string {
  const normalized = value.normalize("NFKC");
  const base = normalized.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "default";
  const digest = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return `${base}--${digest}`;
}
