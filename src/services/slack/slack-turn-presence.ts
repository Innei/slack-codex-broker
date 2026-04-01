import { logger } from "../../logger.js";
import type { SlackSessionRecord } from "../../types.js";
import type {
  SlackStreamChunk,
  SlackTaskUpdateChunk
} from "./slack-api.js";

const STREAM_START_DELAY_MS = 1_500;
const STATUS_REFRESH_MS = 12_000;
const FALLBACK_PHASE_ADVANCE_MS = 8_000;
const MAX_LOG_LINE_LENGTH = 140;
const MAX_TIMELINE_STEPS = 6;
const MAX_LOADING_MESSAGES = 4;
const DEFAULT_STATUS = "is thinking…";
const PLAN_TITLE = "Thinking steps";

type PresenceTaskStatus = SlackTaskUpdateChunk["status"];
type PresenceEndKind = "completed" | "wait" | "block" | "failed" | "interrupted";
type PresenceStepSource = "fallback" | "progress" | "delta" | "terminal";

interface PresenceTaskState {
  readonly id: string;
  title: string;
  status: PresenceTaskStatus;
  details?: string | undefined;
  output?: string | undefined;
  readonly source: PresenceStepSource;
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
  lastStatusFingerprint?: string | undefined;
  currentLoadingMessages?: readonly string[] | undefined;
  finalizing: boolean;
  readonly steps: PresenceTaskState[];
  nextStepSequence: number;
  activeStepId?: string | undefined;
  fallbackPhaseIndex: number;
  answerPhaseStarted: boolean;
  lastTimelineLine?: string | undefined;
  lastActivityAt: number;
  streamStartTimer?: NodeJS.Timeout | undefined;
  fallbackAdvanceTimer?: NodeJS.Timeout | undefined;
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
    readonly taskDisplayMode?: "timeline" | "plan" | undefined;
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

interface PhaseUpdate {
  readonly title: string;
  readonly line?: string | undefined;
  readonly details?: string | undefined;
  readonly loadingMessages?: readonly string[] | undefined;
  readonly source: PresenceStepSource;
  readonly announce?: boolean | undefined;
}

interface FallbackPhase {
  readonly title: string;
  readonly line: string;
  readonly loadingMessages: readonly string[];
}

const FALLBACK_PHASES: readonly FallbackPhase[] = [
  {
    title: "理解请求",
    line: "已开始理解请求",
    loadingMessages: ["正在理解请求", "正在提取关键信息", "正在确认目标"]
  },
  {
    title: "查看上下文",
    line: "已开始查看上下文",
    loadingMessages: ["正在查看上下文", "正在回顾线程历史", "正在定位相关信息"]
  },
  {
    title: "梳理方案",
    line: "已开始梳理可行方案",
    loadingMessages: ["正在梳理可行方案", "正在评估下一步动作", "正在选择处理路径"]
  },
  {
    title: "准备执行",
    line: "已开始准备执行操作",
    loadingMessages: ["正在准备执行操作", "正在组织工作步骤", "正在继续推进处理"]
  },
  {
    title: "整理回复",
    line: "已开始整理回复",
    loadingMessages: ["正在整理回复", "正在压缩关键信息", "正在准备返回结果"]
  }
];

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
      finalizing: false,
      steps: [],
      nextStepSequence: 0,
      fallbackPhaseIndex: 0,
      answerPhaseStarted: false,
      lastActivityAt: Date.now()
    };

    this.#runtimeBySessionKey.set(options.session.key, runtime);
    this.#sessionKeyByTurnId.set(options.turnId, options.session.key);

    await this.#activatePhase(runtime, {
      ...buildFallbackPhaseUpdate(0),
      announce: false,
      source: "fallback"
    });

    runtime.streamStartTimer = setTimeout(() => {
      void this.#advanceFallbackPhase(runtime.sessionKey, { minimumIndex: 1, force: true });
    }, STREAM_START_DELAY_MS);
    this.#scheduleFallbackAdvance(runtime);
  }

  async noteTurnDelta(turnId: string): Promise<void> {
    const runtime = this.#getByTurnId(turnId);
    if (!runtime) {
      return;
    }

    runtime.answerPhaseStarted = true;
    runtime.fallbackPhaseIndex = FALLBACK_PHASES.length - 1;
    this.#scheduleFallbackAdvance(runtime);

    await this.#activatePhase(runtime, {
      title: "整理回复",
      line: "已开始组织回复",
      loadingMessages: ["正在整理回复", "正在压缩关键信息", "正在生成最终内容"],
      source: "delta"
    });
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
      const phase = classifyProgressPhase(options.text);
      await this.#activatePhase(runtime, {
        ...phase,
        source: "progress"
      });
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

    await this.#refreshStatus(runtime, true);
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
    this.#clearTimers(runtime);

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

  #clearTimers(runtime: RuntimePresenceState): void {
    if (runtime.streamStartTimer) {
      clearTimeout(runtime.streamStartTimer);
      runtime.streamStartTimer = undefined;
    }

    if (runtime.fallbackAdvanceTimer) {
      clearTimeout(runtime.fallbackAdvanceTimer);
      runtime.fallbackAdvanceTimer = undefined;
    }
  }

  #scheduleFallbackAdvance(runtime: RuntimePresenceState): void {
    if (runtime.finalizing || runtime.answerPhaseStarted || runtime.fallbackPhaseIndex >= FALLBACK_PHASES.length - 1) {
      return;
    }

    if (runtime.fallbackAdvanceTimer) {
      clearTimeout(runtime.fallbackAdvanceTimer);
    }

    runtime.fallbackAdvanceTimer = setTimeout(() => {
      void this.#advanceFallbackPhase(runtime.sessionKey, { minimumIndex: runtime.fallbackPhaseIndex + 1 });
    }, FALLBACK_PHASE_ADVANCE_MS);
  }

  async #advanceFallbackPhase(
    sessionKey: string,
    options: {
      readonly minimumIndex: number;
      readonly force?: boolean | undefined;
    }
  ): Promise<void> {
    const runtime = this.#runtimeBySessionKey.get(sessionKey);
    if (!runtime || runtime.finalizing) {
      return;
    }

    const idleForMs = Date.now() - runtime.lastActivityAt;
    if (!options.force && idleForMs < FALLBACK_PHASE_ADVANCE_MS - 300) {
      this.#scheduleFallbackAdvance(runtime);
      return;
    }

    const nextIndex = Math.min(
      Math.max(options.minimumIndex, runtime.fallbackPhaseIndex),
      FALLBACK_PHASES.length - 1
    );
    if (nextIndex <= runtime.fallbackPhaseIndex && runtime.streamTs) {
      await this.#refreshStatus(runtime, true);
      this.#scheduleFallbackAdvance(runtime);
      return;
    }

    runtime.fallbackPhaseIndex = nextIndex;
    await this.#activatePhase(runtime, {
      ...buildFallbackPhaseUpdate(nextIndex),
      source: "fallback"
    });
    this.#scheduleFallbackAdvance(runtime);
  }

  async #activatePhase(runtime: RuntimePresenceState, update: PhaseUpdate): Promise<void> {
    const title = normalizePhaseTitle(update.title);
    if (!title || runtime.finalizing) {
      return;
    }

    runtime.lastActivityAt = Date.now();
    const current = getActiveStep(runtime);
    const details = normalizePhaseDetails(update.details);

    if (current && current.title === title && current.status === "in_progress") {
      if (details) {
        current.details = details;
      }
      await this.#refreshStatus(runtime, true, update.loadingMessages);
      if (update.announce !== false) {
        await this.#appendTimeline(runtime, update.line ?? title);
      }
      return;
    }

    if (current && current.status === "in_progress") {
      current.status = "complete";
    }

    const nextStep: PresenceTaskState = {
      id: `step-${++runtime.nextStepSequence}`,
      title,
      status: "in_progress",
      details,
      source: update.source
    };
    runtime.steps.push(nextStep);
    trimTimelineSteps(runtime);
    runtime.activeStepId = nextStep.id;

    await this.#refreshStatus(runtime, true, update.loadingMessages);
    if (update.announce !== false) {
      await this.#appendTimeline(runtime, update.line ?? title);
    }
  }

  async #appendTimeline(runtime: RuntimePresenceState, line: string): Promise<void> {
    if (runtime.streamDisabled) {
      return;
    }

    const normalizedLine = truncateLogLine(line);
    if (!normalizedLine || normalizedLine === runtime.lastTimelineLine) {
      return;
    }
    runtime.lastTimelineLine = normalizedLine;

    if (!runtime.streamTs) {
      const started = await this.#safeStartStream(runtime, normalizedLine);
      if (!started) {
        return;
      }
      return;
    }

    try {
      await this.#slackApi.appendThreadStream({
        channelId: runtime.channelId,
        streamTs: runtime.streamTs,
        markdownText: `\n- ${normalizedLine}`,
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
        markdownText: `思考过程：\n- ${line}`,
        chunks: buildTimelineChunks(runtime),
        taskDisplayMode: "plan"
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

  async #refreshStatus(
    runtime: RuntimePresenceState,
    force = false,
    loadingMessages?: readonly string[] | undefined
  ): Promise<void> {
    const nextLoadingMessages = normalizeLoadingMessages(
      loadingMessages ?? buildLoadingMessages(runtime)
    );
    const nextFingerprint = JSON.stringify([DEFAULT_STATUS, nextLoadingMessages]);
    if (
      !force &&
      runtime.lastStatusFingerprint === nextFingerprint &&
      runtime.lastStatusAt &&
      Date.now() - runtime.lastStatusAt < STATUS_REFRESH_MS
    ) {
      return;
    }

    runtime.currentLoadingMessages = nextLoadingMessages;
    await this.#setStatus(runtime, DEFAULT_STATUS, nextLoadingMessages);
    runtime.lastStatusFingerprint = nextFingerprint;
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

function buildFallbackPhaseUpdate(index: number): Omit<PhaseUpdate, "source"> {
  const phase = FALLBACK_PHASES[Math.min(index, FALLBACK_PHASES.length - 1)] ?? FALLBACK_PHASES[0]!;
  return {
    title: phase.title,
    line: phase.line,
    loadingMessages: phase.loadingMessages
  };
}

function classifyProgressPhase(text?: string | undefined): Omit<PhaseUpdate, "source"> {
  const normalized = truncateLogLine(text || "已发布进度更新");
  const lower = normalized.toLowerCase();

  const candidates: Array<{ pattern: RegExp; title: string; loadingMessages: readonly string[] }> = [
    { pattern: /(test|测试|vitest|e2e|smoke|验收)/i, title: "运行测试", loadingMessages: ["正在运行测试", "正在等待测试结果", "正在核对输出"] },
    { pattern: /(doc|docs|文档|reference|api|slack)/i, title: "查阅文档", loadingMessages: ["正在查阅文档", "正在核对接口细节", "正在提取关键信息"] },
    { pattern: /(repo|仓库|worktree|clone|branch|git status|github)/i, title: "检查仓库", loadingMessages: ["正在检查仓库", "正在查看改动范围", "正在确认代码状态"] },
    { pattern: /(patch|修改|修复|实现|代码|编码|refactor|fix)/i, title: "修改代码", loadingMessages: ["正在修改代码", "正在调整实现细节", "正在同步变更"] },
    { pattern: /(auth|token|scope|鉴权|权限)/i, title: "检查鉴权配置", loadingMessages: ["正在检查鉴权配置", "正在确认权限范围", "正在验证凭据"] },
    { pattern: /(commit|push|fork|pull request|pr\b)/i, title: "整理提交结果", loadingMessages: ["正在整理提交结果", "正在准备推送代码", "正在核对交付内容"] },
    { pattern: /(plan|方案|设计|思路)/i, title: "梳理方案", loadingMessages: ["正在梳理方案", "正在选择处理路径", "正在整理下一步"] }
  ];

  for (const candidate of candidates) {
    if (candidate.pattern.test(lower)) {
      return {
        title: candidate.title,
        line: normalized,
        details: normalized,
        loadingMessages: candidate.loadingMessages
      };
    }
  }

  const fallbackTitle = makeProgressTitle(normalized);
  return {
    title: fallbackTitle,
    line: normalized,
    details: normalized,
    loadingMessages: [toLoadingMessage(fallbackTitle), "正在继续处理", "正在整理下一步"]
  };
}

function getActiveStep(runtime: RuntimePresenceState): PresenceTaskState | undefined {
  if (!runtime.activeStepId) {
    return runtime.steps.at(-1);
  }

  return runtime.steps.find((step) => step.id === runtime.activeStepId) ?? runtime.steps.at(-1);
}

function trimTimelineSteps(runtime: RuntimePresenceState): void {
  while (runtime.steps.length > MAX_TIMELINE_STEPS) {
    const removableIndex = runtime.steps.findIndex((step) => step.id !== runtime.activeStepId && step.status !== "in_progress");
    if (removableIndex === -1) {
      runtime.steps.shift();
      continue;
    }

    runtime.steps.splice(removableIndex, 1);
  }
}

function buildTimelineChunks(runtime: RuntimePresenceState): readonly SlackStreamChunk[] {
  return [
    {
      type: "plan_update",
      title: PLAN_TITLE
    },
    ...runtime.steps.map((step) => ({
      type: "task_update",
      id: step.id,
      title: step.title,
      status: step.status,
      details: step.details,
      output: step.output
    } satisfies SlackTaskUpdateChunk))
  ];
}

function buildLoadingMessages(runtime: RuntimePresenceState): readonly string[] {
  const activeStep = getActiveStep(runtime);
  const recentTitles = runtime.steps
    .slice(-3)
    .reverse()
    .map((step) => toLoadingMessage(step.title));
  const nextFallback =
    FALLBACK_PHASES[Math.min(runtime.fallbackPhaseIndex + 1, FALLBACK_PHASES.length - 1)] ??
    FALLBACK_PHASES[FALLBACK_PHASES.length - 1]!;

  return normalizeLoadingMessages([
    activeStep ? toLoadingMessage(activeStep.title) : undefined,
    ...recentTitles,
    ...nextFallback.loadingMessages
  ]);
}

function normalizeLoadingMessages(messages: readonly (string | undefined)[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const candidate of messages) {
    const value = truncateLogLine(candidate || "");
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
    if (normalized.length >= MAX_LOADING_MESSAGES) {
      break;
    }
  }

  return normalized;
}

function applyFinalTaskState(
  runtime: RuntimePresenceState,
  kind: PresenceEndKind,
  reason?: string | undefined
): void {
  const active = getActiveStep(runtime);
  if (active && active.status === "in_progress") {
    active.status = kind === "completed" ? "complete" : "complete";
  }

  if (kind === "completed") {
    if (active) {
      active.status = "complete";
      active.output = "已发送最终回复";
      return;
    }

    runtime.steps.push({
      id: `step-${++runtime.nextStepSequence}`,
      title: "整理回复",
      status: "complete",
      output: "已发送最终回复",
      source: "terminal"
    });
    trimTimelineSteps(runtime);
    return;
  }

  const terminalTitle = terminalTitleForKind(kind);
  runtime.steps.push({
    id: `step-${++runtime.nextStepSequence}`,
    title: terminalTitle,
    status: kind === "wait" ? "pending" : "error",
    details: reason?.trim() || summarizeEndKind(kind, reason),
    source: "terminal"
  });
  trimTimelineSteps(runtime);
}

function terminalTitleForKind(kind: PresenceEndKind): string {
  if (kind === "wait") {
    return "等待外部输入";
  }

  if (kind === "block") {
    return "当前被阻塞";
  }

  if (kind === "failed") {
    return "执行失败";
  }

  return "当前运行已中断";
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

function normalizePhaseTitle(value: string): string {
  const trimmed = truncateLogLine(value)
    .replace(/^[\-•\s]+/, "")
    .replace(/^已开始/, "")
    .replace(/^正在/, "")
    .replace(/^我这边/, "")
    .trim();
  return trimmed || "继续处理";
}

function normalizePhaseDetails(value?: string | undefined): string | undefined {
  const trimmed = truncateLogLine(value || "");
  return trimmed || undefined;
}

function makeProgressTitle(value: string): string {
  const firstClause = value
    .split(/[\n，,。；;:：]/)[0]
    ?.replace(/^我这边/, "")
    ?.replace(/^已经/, "")
    ?.replace(/^正在/, "")
    ?.replace(/^开始/, "")
    ?.trim();
  const normalized = firstClause || value;
  return normalized.length <= 14 ? normalized : `${normalized.slice(0, 13)}…`;
}

function toLoadingMessage(value: string): string {
  if (!value.trim()) {
    return "正在继续处理";
  }

  return value.startsWith("正在") ? truncateLogLine(value) : `正在${truncateLogLine(value)}`;
}

function truncateLogLine(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_LOG_LINE_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_LOG_LINE_LENGTH - 1)}…`;
}
