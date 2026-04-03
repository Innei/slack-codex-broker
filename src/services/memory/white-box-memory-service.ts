import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { logger } from "../../logger.js";
import type {
  PersistedInboundMessage,
  SlackSessionRecord,
  SlackTurnSignalKind
} from "../../types.js";
import { ensureDir, fileExists } from "../../utils/fs.js";

const MAX_TASKS_PER_SECTION = 20;
const MAX_RECENT_SECTIONS = 8;
const MAX_RENDERED_TASKS = 6;
const MAX_RENDERED_SECTIONS = 5;
const MAX_CONTEXT_CHARS = 12_000;
const MIN_REQUEST_LENGTH = 4;

type WorkTaskStatus = "requested" | "in_progress" | "completed" | "blocked" | "waiting";

interface WorkTask {
  readonly id: string;
  readonly title: string;
  readonly request: string;
  readonly status: WorkTaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly outputs: readonly string[];
  readonly nextStep?: string | undefined;
  readonly sourceMessageTs?: string | undefined;
  readonly sourceTurnId?: string | undefined;
  readonly lastAssistantSummary?: string | undefined;
}

interface SectionWorkLedger {
  readonly sectionId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly userId: string;
  readonly updatedAt: string;
  readonly tasks: readonly WorkTask[];
}

interface UserSectionSummary {
  readonly sectionId: string;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly status: WorkTaskStatus;
  readonly latestTask?: string | undefined;
  readonly openTaskCount: number;
}

interface UserWorkLedger {
  readonly userId: string;
  readonly updatedAt: string;
  readonly sections: readonly UserSectionSummary[];
}

export class WhiteBoxMemoryService {
  readonly #rootDir: string;
  readonly #writeChains = new Map<string, Promise<void>>();

  constructor(options: {
    readonly rootDir: string;
  }) {
    this.#rootDir = options.rootDir;
  }

  async buildContextBlock(options: {
    readonly session: SlackSessionRecord;
    readonly userId: string;
  }): Promise<string | undefined> {
    const userId = options.userId.trim();
    if (!userId) {
      return undefined;
    }

    const [sectionLedger, userLedger] = await Promise.all([
      this.#readSectionLedger(this.#sectionLedgerPath(userId, options.session)),
      this.#readUserLedger(this.#userLedgerPath(userId))
    ]);

    const currentTasks = [...(sectionLedger?.tasks ?? [])]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_RENDERED_TASKS);
    const recentSections = [...(userLedger?.sections ?? [])]
      .filter((section) => section.sectionId !== options.session.key)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_RENDERED_SECTIONS);

    if (currentTasks.length === 0 && recentSections.length === 0) {
      return undefined;
    }

    const lines = [
      "Cross-section work memory ledger for this Slack turn.",
      "Use it to continue unfinished work and recall what the user asked in other sections.",
      "",
      "## current_section",
      `section_id: ${options.session.key}`
    ];

    if (currentTasks.length === 0) {
      lines.push("- No remembered work items for this section yet.");
    } else {
      for (const task of currentTasks) {
        lines.push(...renderTaskLines(task));
      }
    }

    lines.push("", "## recent_sections");
    if (recentSections.length === 0) {
      lines.push("- No remembered work from other sections yet.");
    } else {
      for (const section of recentSections) {
        lines.push(`- [${section.updatedAt}] ${section.sectionId}`);
        lines.push(`  title: ${section.title}`);
        lines.push(`  status: ${section.status}`);
        lines.push(`  open_tasks: ${section.openTaskCount}`);
        if (section.latestTask) {
          lines.push(`  latest_task: ${section.latestTask}`);
        }
      }
    }

    return trimForContext(lines.join("\n"), MAX_CONTEXT_CHARS);
  }

  async captureTurn(options: {
    readonly session: SlackSessionRecord;
    readonly messages: readonly PersistedInboundMessage[];
    readonly turnId?: string | undefined;
    readonly assistantMessage?: string | undefined;
    readonly turnSignalKind?: SlackTurnSignalKind | undefined;
  }): Promise<void> {
    const groupedMessages = new Map<string, PersistedInboundMessage[]>();
    for (const message of options.messages) {
      if (message.senderKind !== "user") {
        continue;
      }

      const normalized = normalizeMessageText(message.text);
      if (normalized.length < MIN_REQUEST_LENGTH || isLikelyAck(normalized)) {
        continue;
      }

      const existing = groupedMessages.get(message.userId) ?? [];
      existing.push(message);
      groupedMessages.set(message.userId, existing);
    }

    const fallbackUserId = options.messages.find((message) => message.senderKind === "user")?.userId;
    const targetUserIds = groupedMessages.size > 0
      ? [...groupedMessages.keys()]
      : fallbackUserId
        ? [fallbackUserId]
        : [];

    await Promise.all(targetUserIds.map(async (userId) => {
      await this.#runSerialized(userId, async () => {
      const sectionPath = this.#sectionLedgerPath(userId, options.session);
      const currentLedger = await this.#readSectionLedger(sectionPath);
      let tasks = [...(currentLedger?.tasks ?? [])];

      for (const message of groupedMessages.get(userId) ?? []) {
        const candidate = buildTaskFromMessage(message);
        if (!candidate) {
          continue;
        }

        tasks = upsertTask(tasks, candidate);
      }

      if ((options.assistantMessage && options.assistantMessage.trim()) || options.turnSignalKind) {
        tasks = applyAssistantUpdate(tasks, {
          assistantMessage: options.assistantMessage,
          turnId: options.turnId,
          turnSignalKind: options.turnSignalKind
        });
      }

      if (tasks.length === 0) {
        return;
      }

      const sectionLedger: SectionWorkLedger = {
        sectionId: options.session.key,
        channelId: options.session.channelId,
        rootThreadTs: options.session.rootThreadTs,
        userId,
        updatedAt: new Date().toISOString(),
        tasks: tasks
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .slice(0, MAX_TASKS_PER_SECTION)
      };

      await this.#writeSectionLedger(sectionPath, sectionLedger);
      await this.#writeUserLedger(userId, sectionLedger);
      });
    }));
  }

  async #readSectionLedger(filePath: string): Promise<SectionWorkLedger | null> {
    const parsed = await readJsonFile(filePath);
    if (!parsed || !Array.isArray(parsed.tasks) || typeof parsed.sectionId !== "string" || typeof parsed.userId !== "string") {
      return null;
    }

    return {
      sectionId: parsed.sectionId,
      channelId: typeof parsed.channelId === "string" ? parsed.channelId : "",
      rootThreadTs: typeof parsed.rootThreadTs === "string" ? parsed.rootThreadTs : "",
      userId: parsed.userId,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      tasks: parsed.tasks.filter(isWorkTask)
    };
  }

  async #writeSectionLedger(filePath: string, ledger: SectionWorkLedger): Promise<void> {
    await writeJsonFile(filePath, ledger);
    const markdown = [
      `# Section Work Ledger (${ledger.sectionId})`,
      "",
      `Updated: ${ledger.updatedAt}`,
      `User: ${ledger.userId}`,
      ""
    ];

    for (const task of ledger.tasks) {
      markdown.push(...renderTaskLines(task), "");
    }

    await fs.writeFile(filePath.replace(/\.json$/u, ".md"), `${markdown.join("\n").trim()}\n`);
  }

  async #readUserLedger(filePath: string): Promise<UserWorkLedger | null> {
    const parsed = await readJsonFile(filePath);
    if (!parsed || !Array.isArray(parsed.sections) || typeof parsed.userId !== "string") {
      return null;
    }

    return {
      userId: parsed.userId,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      sections: parsed.sections.filter(isUserSectionSummary)
    };
  }

  async #writeUserLedger(userId: string, sectionLedger: SectionWorkLedger): Promise<void> {
    const filePath = this.#userLedgerPath(userId);
    const current = await this.#readUserLedger(filePath);
    const currentSummary = summarizeSection(sectionLedger);
    const sections = [
      currentSummary,
      ...(current?.sections ?? []).filter((section) => section.sectionId !== currentSummary.sectionId)
    ]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_RECENT_SECTIONS);

    const userLedger: UserWorkLedger = {
      userId,
      updatedAt: new Date().toISOString(),
      sections
    };

    await writeJsonFile(filePath, userLedger);

    const markdown = [
      `# User Work Ledger (${userId})`,
      "",
      `Updated: ${userLedger.updatedAt}`,
      ""
    ];

    for (const section of sections) {
      markdown.push(`## ${section.sectionId}`);
      markdown.push(`- title: ${section.title}`);
      markdown.push(`- status: ${section.status}`);
      markdown.push(`- updated_at: ${section.updatedAt}`);
      markdown.push(`- open_tasks: ${section.openTaskCount}`);
      if (section.latestTask) {
        markdown.push(`- latest_task: ${section.latestTask}`);
      }
      markdown.push("");
    }

    await fs.writeFile(filePath.replace(/\.json$/u, ".md"), `${markdown.join("\n").trim()}\n`);
  }

  #userLedgerPath(userId: string): string {
    return path.join(this.#rootDir, "users", sanitizePathSegment(userId), "ledger.json");
  }

  #sectionLedgerPath(userId: string, session: SlackSessionRecord): string {
    return path.join(this.#rootDir, "users", sanitizePathSegment(userId), "sections", `${sanitizePathSegment(session.key)}.json`);
  }

  async #runSerialized(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#writeChains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(operation);
    this.#writeChains.set(key, next);

    try {
      await next;
    } finally {
      if (this.#writeChains.get(key) === next) {
        this.#writeChains.delete(key);
      }
    }
  }
}

function buildTaskFromMessage(message: PersistedInboundMessage): WorkTask | null {
  const request = normalizeMessageText(message.text);
  if (request.length < MIN_REQUEST_LENGTH || isLikelyAck(request)) {
    return null;
  }

  const title = buildTaskTitle(request);
  const now = new Date().toISOString();
  const id = createHash("sha1")
    .update(`task:${normalizeForKey(title)}`)
    .digest("hex")
    .slice(0, 16);

  return {
    id,
    title,
    request,
    status: inferRequestedStatus(request),
    createdAt: now,
    updatedAt: now,
    outputs: [],
    nextStep: `Continue work for: ${title}`,
    sourceMessageTs: message.messageTs
  };
}

function upsertTask(tasks: readonly WorkTask[], candidate: WorkTask): WorkTask[] {
  const existingIndex = tasks.findIndex((task) => task.id === candidate.id);
  if (existingIndex === -1) {
    return [candidate, ...tasks];
  }

  const existing = tasks[existingIndex]!;
  const updated: WorkTask = {
    ...existing,
    request: candidate.request,
    status: existing.status === "completed" ? existing.status : candidate.status,
    updatedAt: candidate.updatedAt,
    nextStep: candidate.nextStep,
    sourceMessageTs: candidate.sourceMessageTs ?? existing.sourceMessageTs
  };

  return tasks.map((task, index) => index === existingIndex ? updated : task);
}

function applyAssistantUpdate(tasks: readonly WorkTask[], options: {
  readonly assistantMessage?: string | undefined;
  readonly turnId?: string | undefined;
  readonly turnSignalKind?: SlackTurnSignalKind | undefined;
}): WorkTask[] {
  if (tasks.length === 0) {
    return [...tasks];
  }

  const [latest, ...rest] = tasks;
  if (!latest) {
    return [...tasks];
  }

  const assistantSummary = summarizeAssistantMessage(options.assistantMessage);
  const outputs = assistantSummary
    ? uniqueStrings([assistantSummary, ...latest.outputs]).slice(0, 3)
    : [...latest.outputs];
  const status = signalKindToStatus(options.turnSignalKind) ?? latest.status;

  return [
    {
      ...latest,
      status,
      updatedAt: new Date().toISOString(),
      outputs,
      nextStep: deriveNextStep(status, latest.title, assistantSummary),
      sourceTurnId: options.turnId ?? latest.sourceTurnId,
      lastAssistantSummary: assistantSummary ?? latest.lastAssistantSummary
    },
    ...rest
  ];
}

function summarizeSection(section: SectionWorkLedger): UserSectionSummary {
  const latestTask = section.tasks[0];
  const openTaskCount = section.tasks.filter((task) => task.status !== "completed").length;

  return {
    sectionId: section.sectionId,
    channelId: section.channelId,
    rootThreadTs: section.rootThreadTs,
    updatedAt: section.updatedAt,
    title: latestTask?.title ?? "Untitled work section",
    status: latestTask?.status ?? "requested",
    latestTask: latestTask?.request,
    openTaskCount
  };
}

function renderTaskLines(task: WorkTask): string[] {
  const lines = [
    `- ${task.title}`,
    `  status: ${task.status}`,
    `  request: ${trimForContext(task.request, 240)}`
  ];

  if (task.outputs.length > 0) {
    lines.push(`  outputs: ${task.outputs.join(" | ")}`);
  }
  if (task.nextStep) {
    lines.push(`  next_step: ${task.nextStep}`);
  }

  return lines;
}

function buildTaskTitle(text: string): string {
  const firstChunk = text.split(/[\n。！？!?；;]+/u)[0]?.trim() || text;
  return trimForContext(firstChunk, 80);
}

function inferRequestedStatus(text: string): WorkTaskStatus {
  if (/(?:开始|实现|继续|接着|处理|修|改|排查|看看|做一下)/iu.test(text)) {
    return "in_progress";
  }

  return "requested";
}

function summarizeAssistantMessage(text?: string | undefined): string | undefined {
  const normalized = normalizeMessageText(text ?? "");
  return normalized ? trimForContext(normalized, 220) : undefined;
}

function signalKindToStatus(kind?: SlackTurnSignalKind | undefined): WorkTaskStatus | undefined {
  switch (kind) {
    case "final":
      return "completed";
    case "block":
      return "blocked";
    case "wait":
      return "waiting";
    case "progress":
      return "in_progress";
    default:
      return undefined;
  }
}

function deriveNextStep(
  status: WorkTaskStatus,
  title: string,
  assistantSummary?: string | undefined
): string | undefined {
  switch (status) {
    case "completed":
      return assistantSummary ? "Reuse the recorded output if follow-up work appears." : undefined;
    case "blocked":
      return "Resolve the blocker before continuing this work.";
    case "waiting":
      return "Wait for the pending dependency or user follow-up.";
    case "in_progress":
    case "requested":
      return `Continue work for: ${title}`;
    default:
      return undefined;
  }
}

function normalizeMessageText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function normalizeForKey(text: string): string {
  return normalizeMessageText(text).toLowerCase();
}

function trimForContext(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function sanitizePathSegment(value: string): string {
  const normalized = value.normalize("NFKC");
  const base = normalized.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "default";
  const digest = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return `${base}--${digest}`;
}

function isLikelyAck(text: string): boolean {
  return /^(?:ok|okay|好的|收到|可以|行|嗯|好|thanks|thank you)$/iu.test(text.trim());
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      logger.warn("Failed to read work-memory file", {
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return null;
  }

  if (!raw.trim()) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    logger.warn("Failed to parse work-memory file", {
      filePath,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed as Record<string, unknown>;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tempPath, filePath);
}

function isWorkTask(value: unknown): value is WorkTask {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WorkTask>;
  return typeof candidate.id === "string"
    && typeof candidate.title === "string"
    && typeof candidate.request === "string"
    && typeof candidate.status === "string"
    && typeof candidate.createdAt === "string"
    && typeof candidate.updatedAt === "string"
    && Array.isArray(candidate.outputs);
}

function isUserSectionSummary(value: unknown): value is UserSectionSummary {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<UserSectionSummary>;
  return typeof candidate.sectionId === "string"
    && typeof candidate.channelId === "string"
    && typeof candidate.rootThreadTs === "string"
    && typeof candidate.updatedAt === "string"
    && typeof candidate.title === "string"
    && typeof candidate.status === "string"
    && typeof candidate.openTaskCount === "number";
}
