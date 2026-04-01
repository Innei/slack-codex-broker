import { logger } from "../../logger.js";
import type { SlackSessionRecord } from "../../types.js";
import type {
  SlackStreamChunk,
  SlackTaskUpdateChunk
} from "./slack-api.js";

const STREAM_START_DELAY_MS = 1_500;
const STATUS_REFRESH_MS = 45_000;
const MAX_LOG_LINE_LENGTH = 140;

type PresenceTaskId = "understand" | "analyze" | "reply";
type PresenceTaskStatus = SlackTaskUpdateChunk["status"];
type PresenceEndKind = "completed" | "wait" | "block" | "failed" | "interrupted";

interface PresenceTaskState {
  readonly id: PresenceTaskId;
  readonly title: string;
  status: PresenceTaskStatus;
  details?: string | undefined;
  output?: string | undefined;
}

interface RuntimePresenceState {
  readonly sessionKey: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  turnId: string;
  readonly recipientUserId?: string | undefined;
  readonly recipientTeamId?: string | undefined;
  streamTs?: string | undefined;
  streamDisabled: boolean;
  statusActive: boolean;
  lastStatusAt?: number | undefined;
  firstAnalysisUpdateSent: boolean;
  replyPhaseStarted: boolean;
  finalizing: boolean;
  readonly tasks: Record<PresenceTaskId, PresenceTaskState>;
  streamStartTimer?: NodeJS.Timeout | undefined;
}

interface PresenceSlackApi {
  setAssistantThreadStatus(options: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly status: string;
    readonly loadingMessages?: readonly string[] | undefined;
  }): Promise<void>;
  startThreadStream(options: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly recipientUserId?: string | undefined;
    readonly recipientTeamId?: string | undefined;
    readonly markdownText?: string | undefined;
    readonly chunks?: readonly SlackStreamChunk[] | undefined;
  }): Promise<string | undefined>;
  appendThreadStream(options: {
    readonly channelId: string;
    readonly streamTs: string;
    readonly markdownText: string;
    readonly chunks?: readonly SlackStreamChunk[] | undefined;
  }): Promise<void>;
  stopThreadStream(options: {
    readonly channelId: string;
    readonly streamTs: string;
    readonly markdownText?: string | undefined;
    readonly chunks?: readonly SlackStreamChunk[] | undefined;
  }): Promise<void>;
}

interface PresenceSessionStore {
  setLastSlackReplyAt(
    channelId: string,
    rootThreadTs: string,
    lastSlackReplyAt: string | undefined
  ): Promise<SlackSessionRecord>;
}

export class SlackTurnPresence {
  readonly #slackApi: PresenceSlackApi;
  readonly #sessions: PresenceSessionStore;
  readonly #runtimeBySessionKey = new Map<string, RuntimePresenceState>();
  readonly #sessionKeyByTurnId = new Map<string, string>();

  constructor(options: {
    readonly slackApi: PresenceSlackApi;
    readonly sessions: PresenceSessionStore;
  }) {
    this.#slackApi = options.slackApi;
    this.#sessions = options.sessions;
  }

  async beginTurn(options: {
    readonly session: SlackSessionRecord;
    readonly turnId: string;
    readonly recipientUserId?: string | undefined;
    readonly recipientTeamId?: string | undefined;
  }): Promise<void> {
    await this.endSession(options.session.key, "interrupted");

    const runtime: RuntimePresenceState = {
      sessionKey: options.session.key,
      channelId: options.session.channelId,
      rootThreadTs: options.session.rootThreadTs,
      turnId: options.turnId,
      recipientUserId: options.recipientUserId,
      recipientTeamId: options.recipientTeamId,
      streamDisabled: false,
      statusActive: false,
      firstAnalysisUpdateSent: false,
      replyPhaseStarted: false,
      finalizing: false,
      tasks: createInitialTasks()
    };

    this.#runtimeBySessionKey.set(options.session.key, runtime);
    this.#sessionKeyByTurnId.set(options.turnId, options.session.key);

    await this.#setStatus(runtime, "is thinking…", [
      "正在理解请求",
      "正在查看上下文",
      "正在整理回复"
    ]);

    runtime.streamStartTimer = setTimeout(() => {
      void this.#startAnalysisTimeline(runtime.sessionKey, "已开始分析上下文");
    }, STREAM_START_DELAY_MS);
  }

  async noteTurnDelta(turnId: string): Promise<void> {
    const runtime = this.#getByTurnId(turnId);
    if (!runtime) {
      return;
    }

    if (!runtime.replyPhaseStarted) {
      runtime.tasks.understand.status = "complete";
      runtime.tasks.analyze.status = "complete";
      runtime.tasks.reply.status = "in_progress";
      runtime.replyPhaseStarted = true;
      runtime.firstAnalysisUpdateSent = true;
      await this.#appendTimeline(runtime, "已开始组织回复");
    }
  }

  async noteSlackMessage(options: {
    readonly session: SlackSessionRecord;
    readonly kind?: "progress" | "final" | "block" | "wait" | undefined;
    readonly text?: string | undefined;
    readonly reason?: string | undefined;
  }): Promise<void> {
    const runtime = this.#runtimeBySessionKey.get(options.session.key);
    if (!runtime) {
      return;
    }

    if (options.kind === "progress") {
      runtime.tasks.understand.status = "complete";
      runtime.tasks.analyze.status = runtime.replyPhaseStarted ? "complete" : "in_progress";
      await this.#appendTimeline(runtime, options.text?.trim() || "已发布进度更新");
      return;
    }

    if (options.kind === "final") {
      await this.endSession(options.session.key, "completed");
      return;
    }

    if (options.kind === "wait") {
      await this.endSession(options.session.key, "wait", options.reason);
      return;
    }

    if (options.kind === "block") {
      await this.endSession(options.session.key, "block", options.reason);
      return;
    }
  }

  async noteTurnResult(options: {
    readonly session: SlackSessionRecord;
    readonly turnId: string;
    readonly aborted: boolean;
  }): Promise<void> {
    const runtime = this.#runtimeBySessionKey.get(options.session.key);
    if (!runtime || runtime.turnId !== options.turnId) {
      return;
    }

    await this.endSession(options.session.key, options.aborted ? "interrupted" : "completed");
  }

  async failSession(session: SlackSessionRecord, reason?: string | undefined): Promise<void> {
    await this.endSession(session.key, "failed", reason);
  }

  async refreshSession(session: SlackSessionRecord): Promise<void> {
    const runtime = this.#runtimeBySessionKey.get(session.key);
    if (!runtime || runtime.finalizing) {
      return;
    }

    if (runtime.streamTs) {
      return;
    }

    const now = Date.now();
    if (runtime.lastStatusAt && now - runtime.lastStatusAt < STATUS_REFRESH_MS) {
      return;
    }

    await this.#setStatus(runtime, "is thinking…", [
      "正在理解请求",
      "正在查看上下文",
      "正在整理回复"
    ]);
  }

  async clearSession(session: SlackSessionRecord): Promise<void> {
    await this.endSession(session.key, "interrupted");
  }

  async stop(): Promise<void> {
    const sessionKeys = [...this.#runtimeBySessionKey.keys()];
    await Promise.all(sessionKeys.map(async (sessionKey) => {
      await this.endSession(sessionKey, "interrupted");
    }));
  }

  async endSession(
    sessionKey: string,
    kind: PresenceEndKind,
    reason?: string | undefined
  ): Promise<void> {
    const runtime = this.#runtimeBySessionKey.get(sessionKey);
    if (!runtime || runtime.finalizing) {
      return;
    }

    runtime.finalizing = true;
    if (runtime.streamStartTimer) {
      clearTimeout(runtime.streamStartTimer);
      runtime.streamStartTimer = undefined;
    }

    try {
      await this.#clearStatus(runtime);

      if (runtime.streamTs && !runtime.streamDisabled) {
        applyFinalTaskState(runtime, kind, reason);
        await this.#safeStopStream(runtime, summarizeEndKind(kind, reason));
      }
    } finally {
      this.#runtimeBySessionKey.delete(sessionKey);
      this.#sessionKeyByTurnId.delete(runtime.turnId);
    }
  }

  #getByTurnId(turnId: string): RuntimePresenceState | undefined {
    const sessionKey = this.#sessionKeyByTurnId.get(turnId);
    if (!sessionKey) {
      return undefined;
    }

    return this.#runtimeBySessionKey.get(sessionKey);
  }

  async #startAnalysisTimeline(sessionKey: string, line: string): Promise<void> {
    const runtime = this.#runtimeBySessionKey.get(sessionKey);
    if (!runtime || runtime.finalizing || runtime.firstAnalysisUpdateSent) {
      return;
    }

    runtime.tasks.understand.status = "complete";
    runtime.tasks.analyze.status = "in_progress";
    runtime.firstAnalysisUpdateSent = true;
    await this.#appendTimeline(runtime, line);
  }

  async #appendTimeline(runtime: RuntimePresenceState, line: string): Promise<void> {
    if (runtime.streamDisabled) {
      return;
    }

    if (!runtime.streamTs) {
      const started = await this.#safeStartStream(runtime, line);
      if (!started) {
        return;
      }
      return;
    }

    try {
      await this.#slackApi.appendThreadStream({
        channelId: runtime.channelId,
        streamTs: runtime.streamTs,
        markdownText: `\n- ${truncateLogLine(line)}`,
        chunks: buildTimelineChunks(runtime)
      });
      await this.#sessions.setLastSlackReplyAt(
        runtime.channelId,
        runtime.rootThreadTs,
        new Date().toISOString()
      );
    } catch (error) {
      runtime.streamDisabled = true;
      logger.warn("Failed to append Slack thinking-step stream", {
        sessionKey: runtime.sessionKey,
        turnId: runtime.turnId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #safeStartStream(runtime: RuntimePresenceState, line: string): Promise<boolean> {
    try {
      const ts = await this.#slackApi.startThreadStream({
        channelId: runtime.channelId,
        threadTs: runtime.rootThreadTs,
        recipientUserId: runtime.recipientUserId,
        recipientTeamId: runtime.recipientTeamId,
        markdownText: `思考步骤：\n- ${truncateLogLine(line)}`,
        chunks: buildTimelineChunks(runtime)
      });

      if (!ts) {
        runtime.streamDisabled = true;
        return false;
      }

      runtime.streamTs = ts;
      await this.#sessions.setLastSlackReplyAt(
        runtime.channelId,
        runtime.rootThreadTs,
        new Date().toISOString()
      );
      return true;
    } catch (error) {
      runtime.streamDisabled = true;
      logger.warn("Failed to start Slack thinking-step stream", {
        sessionKey: runtime.sessionKey,
        turnId: runtime.turnId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  async #safeStopStream(runtime: RuntimePresenceState, line: string): Promise<void> {
    try {
      await this.#slackApi.stopThreadStream({
        channelId: runtime.channelId,
        streamTs: runtime.streamTs!,
        markdownText: `\n- ${truncateLogLine(line)}`,
        chunks: buildTimelineChunks(runtime)
      });
      await this.#sessions.setLastSlackReplyAt(
        runtime.channelId,
        runtime.rootThreadTs,
        new Date().toISOString()
      );
    } catch (error) {
      logger.warn("Failed to stop Slack thinking-step stream", {
        sessionKey: runtime.sessionKey,
        turnId: runtime.turnId,
        streamTs: runtime.streamTs,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #setStatus(
    runtime: RuntimePresenceState,
    status: string,
    loadingMessages?: readonly string[] | undefined
  ): Promise<void> {
    try {
      await this.#slackApi.setAssistantThreadStatus({
        channelId: runtime.channelId,
        threadTs: runtime.rootThreadTs,
        status,
        loadingMessages
      });
      runtime.statusActive = Boolean(status);
      runtime.lastStatusAt = Date.now();
    } catch (error) {
      logger.warn("Failed to set Slack assistant status", {
        sessionKey: runtime.sessionKey,
        turnId: runtime.turnId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async #clearStatus(runtime: RuntimePresenceState): Promise<void> {
    if (!runtime.statusActive && !runtime.lastStatusAt) {
      return;
    }

    await this.#setStatus(runtime, "");
  }
}

function createInitialTasks(): Record<PresenceTaskId, PresenceTaskState> {
  return {
    understand: {
      id: "understand",
      title: "理解请求",
      status: "in_progress"
    },
    analyze: {
      id: "analyze",
      title: "分析上下文",
      status: "pending"
    },
    reply: {
      id: "reply",
      title: "整理回复",
      status: "pending"
    }
  };
}

function buildTimelineChunks(runtime: RuntimePresenceState): readonly SlackStreamChunk[] {
  return [
    {
      type: "plan_update",
      title: "Thinking steps"
    },
    ...(["understand", "analyze", "reply"] as const).map((taskId) => {
      const task = runtime.tasks[taskId];
      return {
        type: "task_update",
        id: task.id,
        title: task.title,
        status: task.status,
        details: task.details,
        output: task.output
      } satisfies SlackTaskUpdateChunk;
    })
  ];
}

function applyFinalTaskState(
  runtime: RuntimePresenceState,
  kind: PresenceEndKind,
  reason?: string | undefined
): void {
  runtime.tasks.understand.status = "complete";

  if (kind === "completed") {
    runtime.tasks.analyze.status = "complete";
    runtime.tasks.reply.status = "complete";
    runtime.tasks.reply.output = "已发送最终回复";
    return;
  }

  if (kind === "wait") {
    runtime.tasks.analyze.status = "complete";
    runtime.tasks.reply.status = "pending";
    runtime.tasks.reply.details = reason?.trim() || "等待外部输入";
    return;
  }

  if (kind === "block") {
    runtime.tasks.analyze.status = "complete";
    runtime.tasks.reply.status = "error";
    runtime.tasks.reply.details = reason?.trim() || "当前被阻塞";
    return;
  }

  runtime.tasks.analyze.status = runtime.tasks.analyze.status === "pending" ? "error" : runtime.tasks.analyze.status;
  runtime.tasks.reply.status = "error";
  runtime.tasks.reply.details = reason?.trim() || summarizeEndKind(kind, reason);
}

function summarizeEndKind(kind: PresenceEndKind, reason?: string | undefined): string {
  if (kind === "completed") {
    return "已发送最终回复";
  }

  if (kind === "wait") {
    return reason?.trim() || "正在等待外部输入";
  }

  if (kind === "block") {
    return reason?.trim() || "当前被阻塞";
  }

  if (kind === "failed") {
    return reason?.trim() || "执行失败";
  }

  return reason?.trim() || "当前运行已中断";
}

function truncateLogLine(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_LOG_LINE_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_LOG_LINE_LENGTH - 1)}…`;
}
