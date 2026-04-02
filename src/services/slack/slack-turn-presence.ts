import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { logger } from "../../logger.js";
import type { SlackSessionRecord } from "../../types.js";

const STATUS_REFRESH_MS = 12_000;
const FALLBACK_PHASE_ADVANCE_MS = 8_000;
const MAX_LOG_LINE_LENGTH = 140;
const MAX_LOADING_MESSAGES = 4;
const DEFAULT_STATUS = "is thinking…";
const MAX_COMMAND_LABEL_LENGTH = 48;

const execFileAsync = promisify(execFile);

type PresenceEndKind = "completed" | "wait" | "block" | "failed" | "interrupted";

interface RuntimePresenceState {
  readonly sessionKey: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  turnId: string;
  statusActive: boolean;
  lastStatusAt?: number | undefined;
  lastStatusFingerprint?: string | undefined;
  currentLoadingMessages: readonly string[];
  finalizing: boolean;
  workingLabel?: string | undefined;
  activeCommandLabel?: string | undefined;
  fallbackPhaseIndex: number;
  answerPhaseStarted: boolean;
  lastActivityAt: number;
  fallbackAdvanceTimer?: NodeJS.Timeout | undefined;
}

interface PresenceSlackApi {
  setAssistantThreadStatus(options: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly status: string;
    readonly loadingMessages?: readonly string[] | undefined;
  }): Promise<void>;
}

interface PresenceSessionStore {
  setLastSlackReplyAt(
    channelId: string,
    rootThreadTs: string,
    lastSlackReplyAt: string | undefined
  ): Promise<SlackSessionRecord>;
}

interface FallbackPhase {
  readonly loadingMessages: readonly string[];
}

const FALLBACK_PHASES: readonly FallbackPhase[] = [
  {
    loadingMessages: ["正在理解请求", "正在提取关键信息", "正在确认目标"]
  },
  {
    loadingMessages: ["正在查看上下文", "正在回顾线程历史", "正在定位相关信息"]
  },
  {
    loadingMessages: ["正在梳理可行方案", "正在评估下一步动作", "正在选择处理路径"]
  },
  {
    loadingMessages: ["正在准备执行操作", "正在组织工作步骤", "正在继续推进处理"]
  },
  {
    loadingMessages: ["正在整理回复", "正在压缩关键信息", "正在准备返回结果"]
  }
];

export class SlackTurnPresence {
  readonly #slackApi: PresenceSlackApi;
  readonly #sessions: PresenceSessionStore;
  readonly #runtimeBySessionKey = new Map<string, RuntimePresenceState>();
  readonly #sessionKeyByTurnId = new Map<string, string>();
  readonly #workingLabelByCwd = new Map<string, Promise<string | undefined>>();
  readonly #pendingCommandEventsByTurnId = new Map<string, Array<{
    readonly turnId: string;
    readonly itemId: string;
    readonly phase: "started" | "completed";
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly durationMs?: number | null | undefined;
    readonly exitCode?: number | null | undefined;
  }>>();

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
      statusActive: false,
      currentLoadingMessages: FALLBACK_PHASES[0]!.loadingMessages,
      finalizing: false,
      fallbackPhaseIndex: 0,
      answerPhaseStarted: false,
      lastActivityAt: Date.now()
    };

    this.#runtimeBySessionKey.set(options.session.key, runtime);
    this.#sessionKeyByTurnId.set(options.turnId, options.session.key);

    await this.#refreshStatus(runtime, true, runtime.currentLoadingMessages);

    const bufferedCommandEvents = this.#pendingCommandEventsByTurnId.get(options.turnId) ?? [];
    this.#pendingCommandEventsByTurnId.delete(options.turnId);
    for (const event of bufferedCommandEvents) {
      await this.noteCommandExecution(event);
    }

    this.#scheduleFallbackAdvance(runtime);
  }

  async noteTurnDelta(turnId: string, _delta?: string, _fullText?: string): Promise<void> {
    const runtime = this.#getByTurnId(turnId);
    if (!runtime || runtime.finalizing) {
      return;
    }

    runtime.answerPhaseStarted = true;
    runtime.fallbackPhaseIndex = FALLBACK_PHASES.length - 1;
    runtime.lastActivityAt = Date.now();
    this.#scheduleFallbackAdvance(runtime);

    await this.#refreshStatus(runtime, true, [
      runtime.workingLabel ? `Working in ${runtime.workingLabel}` : undefined,
      "正在整理回复",
      "正在压缩关键信息",
      "已开始组织回复"
    ]);
  }

  async noteToolUse(
    turnId: string,
    toolName: string,
    params?: Record<string, unknown>
  ): Promise<void> {
    const runtime = this.#getByTurnId(turnId);
    if (!runtime || runtime.finalizing) {
      return;
    }

    runtime.lastActivityAt = Date.now();
    const toolDisplay = formatToolCallForDisplay(toolName, params);
    const phaseInfo = classifyToolPhase(toolName);

    await this.#refreshStatus(runtime, true, [
      runtime.workingLabel ? `Working in ${runtime.workingLabel}` : undefined,
      toolDisplay,
      ...phaseInfo.loadingMessages
    ]);
  }

  async noteCommandExecution(options: {
    readonly turnId: string;
    readonly itemId: string;
    readonly phase: "started" | "completed";
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly durationMs?: number | null | undefined;
    readonly exitCode?: number | null | undefined;
  }): Promise<void> {
    const runtime = this.#getByTurnId(options.turnId);
    if (!runtime) {
      const pending = this.#pendingCommandEventsByTurnId.get(options.turnId) ?? [];
      pending.push(options);
      this.#pendingCommandEventsByTurnId.set(options.turnId, pending);
      return;
    }

    if (runtime.finalizing) {
      return;
    }

    runtime.lastActivityAt = Date.now();

    const commandLabel = describeCommand(options.command);
    const workingLabel = await this.#resolveWorkingLabel(options.cwd);
    if (workingLabel) {
      runtime.workingLabel = workingLabel;
    }

    if (options.phase === "started") {
      runtime.activeCommandLabel = commandLabel;
      await this.#refreshStatus(runtime, true, [
        workingLabel ? `Working in ${workingLabel}` : undefined,
        `Running ${commandLabel}`,
        "正在等待命令结果",
        "正在读取输出"
      ]);
      return;
    }

    runtime.activeCommandLabel = undefined;
    const summary = summarizeCommandCompletion(commandLabel, options.durationMs, options.exitCode);
    await this.#refreshStatus(runtime, true, [
      workingLabel ? `Working in ${workingLabel}` : undefined,
      summary,
      "正在处理命令结果",
      runtime.answerPhaseStarted ? "正在整理回复" : "正在继续处理"
    ]);
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
      runtime.lastActivityAt = Date.now();
      const phase = classifyProgressPhase(options.text);
      await this.#refreshStatus(runtime, true, [
        runtime.workingLabel ? `Working in ${runtime.workingLabel}` : undefined,
        ...phase.loadingMessages
      ]);
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

    await this.#refreshStatus(runtime);
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
    _kind: PresenceEndKind,
    _reason?: string | undefined
  ): Promise<void> {
    const runtime = this.#runtimeBySessionKey.get(sessionKey);
    if (!runtime || runtime.finalizing) {
      return;
    }

    runtime.finalizing = true;
    this.#clearTimers(runtime);

    try {
      await this.#clearStatus(runtime);
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
      void this.#advanceFallbackPhase(runtime.sessionKey, runtime.fallbackPhaseIndex + 1);
    }, FALLBACK_PHASE_ADVANCE_MS);
  }

  async #advanceFallbackPhase(sessionKey: string, minimumIndex: number): Promise<void> {
    const runtime = this.#runtimeBySessionKey.get(sessionKey);
    if (!runtime || runtime.finalizing || runtime.answerPhaseStarted) {
      return;
    }

    const idleForMs = Date.now() - runtime.lastActivityAt;
    if (idleForMs < FALLBACK_PHASE_ADVANCE_MS - 300) {
      this.#scheduleFallbackAdvance(runtime);
      return;
    }

    const nextIndex = Math.min(
      Math.max(minimumIndex, runtime.fallbackPhaseIndex + 1),
      FALLBACK_PHASES.length - 1
    );
    if (nextIndex <= runtime.fallbackPhaseIndex) {
      this.#scheduleFallbackAdvance(runtime);
      return;
    }

    runtime.fallbackPhaseIndex = nextIndex;
    await this.#refreshStatus(runtime, true, [
      runtime.workingLabel ? `Working in ${runtime.workingLabel}` : undefined,
      ...FALLBACK_PHASES[nextIndex]!.loadingMessages
    ]);
    this.#scheduleFallbackAdvance(runtime);
  }

  async #refreshStatus(
    runtime: RuntimePresenceState,
    force = false,
    loadingMessages?: readonly (string | undefined)[] | undefined
  ): Promise<void> {
    const nextLoadingMessages = normalizeLoadingMessages(
      loadingMessages ?? runtime.currentLoadingMessages
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
    runtime.lastStatusFingerprint = nextFingerprint;
    await this.#setStatus(runtime, DEFAULT_STATUS, nextLoadingMessages);
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

  async #resolveWorkingLabel(cwd?: string | undefined): Promise<string | undefined> {
    const normalized = cwd?.trim();
    if (!normalized) {
      return undefined;
    }

    let pending = this.#workingLabelByCwd.get(normalized);
    if (!pending) {
      pending = resolveWorkingLabelFromCwd(normalized)
        .catch((error) => {
          logger.warn("Failed to resolve working directory label", {
            cwd: normalized,
            error: error instanceof Error ? error.message : String(error)
          });
          return path.basename(normalized) || undefined;
        });
      this.#workingLabelByCwd.set(normalized, pending);
    }

    return await pending;
  }
}

function classifyProgressPhase(text?: string | undefined): { loadingMessages: readonly string[] } {
  const normalized = truncateLogLine(text || "已发布进度更新");
  const lower = normalized.toLowerCase();

  const candidates: Array<{ pattern: RegExp; loadingMessages: readonly string[] }> = [
    { pattern: /(test|测试|vitest|e2e|smoke|验收)/i, loadingMessages: [normalized, "正在运行测试", "正在等待测试结果", "正在核对输出"] },
    { pattern: /(doc|docs|文档|reference|api|slack)/i, loadingMessages: [normalized, "正在查阅文档", "正在核对接口细节", "正在提取关键信息"] },
    { pattern: /(repo|仓库|worktree|clone|branch|git status|github)/i, loadingMessages: [normalized, "正在检查仓库", "正在查看改动范围", "正在确认代码状态"] },
    { pattern: /(patch|修改|修复|实现|代码|编码|refactor|fix)/i, loadingMessages: [normalized, "正在修改代码", "正在调整实现细节", "正在同步变更"] },
    { pattern: /(auth|token|scope|鉴权|权限)/i, loadingMessages: [normalized, "正在检查鉴权配置", "正在确认权限范围", "正在验证凭据"] },
    { pattern: /(commit|push|fork|pull request|pr\b)/i, loadingMessages: [normalized, "正在整理提交结果", "正在准备推送代码", "正在核对交付内容"] },
    { pattern: /(plan|方案|设计|思路)/i, loadingMessages: [normalized, "正在梳理方案", "正在选择处理路径", "正在整理下一步"] }
  ];

  for (const candidate of candidates) {
    if (candidate.pattern.test(lower)) {
      return candidate;
    }
  }

  return {
    loadingMessages: [normalized, "正在继续处理", "正在整理下一步"]
  };
}

function classifyToolPhase(toolName: string): { loadingMessages: readonly string[] } {
  const normalized = toolName.trim().toLowerCase();

  if (normalized.includes("exec") || normalized.includes("shell") || normalized.includes("bash") || normalized.includes("zsh")) {
    return {
      loadingMessages: ["正在执行命令", "正在等待命令结果", "正在读取输出"]
    };
  }

  if (normalized.includes("search") || normalized.includes("web")) {
    return {
      loadingMessages: ["正在检索信息", "正在筛选结果", "正在提取关键信息"]
    };
  }

  if (normalized.includes("github") || normalized.includes("git")) {
    return {
      loadingMessages: ["正在检查仓库", "正在查看代码状态", "正在整理变更"]
    };
  }

  return {
    loadingMessages: ["正在使用工具处理", "正在等待结果", "正在继续推进"]
  };
}

function formatToolCallForDisplay(toolName: string, params?: Record<string, unknown>): string {
  const name = truncateLogLine(toolName || "tool");
  if (!params || Object.keys(params).length === 0) {
    return name;
  }

  const preview = truncateLogLine(JSON.stringify(params));
  return `${name} ${preview}`;
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

function truncateLogLine(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (trimmed.length <= MAX_LOG_LINE_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_LOG_LINE_LENGTH - 1)}…`;
}

function describeCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) {
    return "Command";
  }

  const firstToken = splitCommandTokens(trimmed)[0] ?? trimmed;
  const binary = path.basename(firstToken.replace(/^['"]|['"]$/g, ""));
  const display = binary || trimmed;
  return truncateDisplayLabel(toTitleCase(display));
}

function splitCommandTokens(command: string): string[] {
  return command.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
}

function toTitleCase(value: string): string {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

function truncateDisplayLabel(value: string): string {
  if (value.length <= MAX_COMMAND_LABEL_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_COMMAND_LABEL_LENGTH - 1)}…`;
}

function summarizeCommandCompletion(
  commandLabel: string,
  durationMs?: number | null | undefined,
  exitCode?: number | null | undefined
): string {
  const parts: string[] = [];
  const durationLabel = formatDuration(durationMs);

  if (durationLabel) {
    parts.push(durationLabel);
  }

  if (typeof exitCode === "number" && exitCode !== 0) {
    parts.push(`exit ${exitCode}`);
  }

  return parts.length > 0
    ? `Finished ${commandLabel} (${parts.join(", ")})`
    : `Finished ${commandLabel}`;
}

function formatDuration(durationMs?: number | null | undefined): string | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }

  if (durationMs >= 1_000) {
    const seconds = durationMs / 1_000;
    return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
  }

  return `${durationMs}ms`;
}

async function resolveWorkingLabelFromCwd(cwd: string): Promise<string | undefined> {
  const normalized = cwd.trim();
  if (!normalized) {
    return undefined;
  }

  try {
    const topLevel = (await execFileAsync("git", ["-C", normalized, "rev-parse", "--show-toplevel"]))
      .stdout
      .trim();
    const basename = path.basename(topLevel);
    return basename || path.basename(normalized) || undefined;
  } catch {
    return path.basename(normalized) || undefined;
  }
}
