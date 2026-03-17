import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SessionManager } from "../src/services/session-manager.js";
import { SlackInboundStore } from "../src/services/slack/slack-inbound-store.js";
import { StateStore } from "../src/store/state-store.js";

describe("SlackInboundStore", () => {
  it("reconciles orphaned inflight messages for idle sessions", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-state-"));
    const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "slack-codex-sessions-"));
    const store = new StateStore(stateDir, sessionsRoot);
    const sessions = new SessionManager({
      stateStore: store,
      sessionsRoot
    });
    await sessions.load();

    const initialSession = await sessions.ensureSession("C123", "111.222");
    const session = await sessions.setLastDeliveredMessageTs("C123", "111.222", "111.400");

    await sessions.upsertInboundMessage({
      key: "done-1",
      sessionKey: initialSession.key,
      channelId: initialSession.channelId,
      rootThreadTs: initialSession.rootThreadTs,
      messageTs: "111.300",
      source: "thread_reply",
      userId: "U1",
      text: "already delivered",
      status: "inflight",
      batchId: "turn-old",
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z"
    });
    await sessions.upsertInboundMessage({
      key: "done-2",
      sessionKey: initialSession.key,
      channelId: initialSession.channelId,
      rootThreadTs: initialSession.rootThreadTs,
      messageTs: "111.301",
      source: "background_job_event",
      userId: "BOT",
      text: "same old batch",
      status: "inflight",
      batchId: "turn-old",
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z"
    });
    await sessions.upsertInboundMessage({
      key: "pending-1",
      sessionKey: initialSession.key,
      channelId: initialSession.channelId,
      rootThreadTs: initialSession.rootThreadTs,
      messageTs: "111.500",
      source: "thread_reply",
      userId: "U1",
      text: "needs replay",
      status: "inflight",
      batchId: "turn-new",
      createdAt: "2026-03-17T00:00:00.000Z",
      updatedAt: "2026-03-17T00:00:00.000Z"
    });

    const inboundStore = new SlackInboundStore({
      sessions,
      slackApi: {} as never
    });

    const result = await inboundStore.reconcileOrphanedInflightMessages(session);
    expect(result).toEqual({
      markedDoneCount: 2,
      resetToPendingCount: 1
    });

    const doneMessages = sessions.listInboundMessages({
      channelId: "C123",
      rootThreadTs: "111.222",
      status: "done"
    });
    const pendingMessages = sessions.listInboundMessages({
      channelId: "C123",
      rootThreadTs: "111.222",
      status: "pending"
    });

    expect(doneMessages.map((message) => message.messageTs)).toEqual(["111.300", "111.301"]);
    expect(pendingMessages.map((message) => message.messageTs)).toEqual(["111.500"]);
  });
});
