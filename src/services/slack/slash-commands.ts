import type { AppConfig } from "../../config.js";
import type { SlackSessionRecord } from "../../types.js";
import type { CodexBroker } from "../codex/codex-broker.js";
import type { SessionManager } from "../session-manager.js";
import type { AppServerRateLimitSnapshot } from "../codex/app-server-client.js";

export type SlashCommandName =
  | "help"
  | "usage"
  | "status"
  | "workspace"
  | "model"
  | "sessions";

export interface ParsedSlashCommand {
  readonly command: SlashCommandName;
  readonly args: string;
}

export interface SlashCommandContext {
  readonly config: AppConfig;
  readonly sessions: SessionManager;
  readonly codex: CodexBroker;
  readonly channelId: string;
  readonly rootThreadTs: string;
  readonly session: SlackSessionRecord | undefined;
}

export interface SlashCommandResult {
  readonly text: string;
  readonly handled: boolean;
}

const COMMAND_ALIASES: Record<string, SlashCommandName> = {
  help: "help",
  h: "help",
  "?": "help",
  usage: "usage",
  "rate-limit": "usage",
  ratelimit: "usage",
  quota: "usage",
  status: "status",
  stat: "status",
  info: "status",
  workspace: "workspace",
  ws: "workspace",
  cwd: "workspace",
  pwd: "workspace",
  model: "model",
  sessions: "sessions",
  list: "sessions"
};

export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const commandPart = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
  const args = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

  const normalizedCommand = commandPart.toLowerCase();
  const resolvedCommand = COMMAND_ALIASES[normalizedCommand];

  if (!resolvedCommand) {
    return null;
  }

  return {
    command: resolvedCommand,
    args
  };
}

export async function executeSlashCommand(
  command: ParsedSlashCommand,
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  switch (command.command) {
    case "help":
      return handleHelp();
    case "usage":
      return await handleUsage(context);
    case "status":
      return handleStatus(context);
    case "workspace":
      return handleWorkspace(context);
    case "model":
      return await handleModel(context);
    case "sessions":
      return handleSessions(context);
    default:
      return {
        text: `Unknown command: /${command.command}`,
        handled: false
      };
  }
}

function handleHelp(): SlashCommandResult {
  const helpText = `*Available Commands*

\`/help\` - Show this help message
\`/usage\` - Show current rate limits and usage
\`/status\` - Show current session status
\`/workspace\` - Show current workspace path
\`/model\` - Show current model information
\`/sessions\` - List all active sessions

*Aliases*
- \`/help\`: \`/h\`, \`/?\`
- \`/usage\`: \`/rate-limit\`, \`/ratelimit\`, \`/quota\`
- \`/status\`: \`/stat\`, \`/info\`
- \`/workspace\`: \`/ws\`, \`/cwd\`, \`/pwd\`
- \`/sessions\`: \`/list\`

*Other Commands*
- \`-stop\` - Stop the current running task`;

  return {
    text: helpText,
    handled: true
  };
}

async function handleUsage(context: SlashCommandContext): Promise<SlashCommandResult> {
  try {
    const rateLimits = await context.codex.readAccountRateLimits();
    const summary = await context.codex.readAccountSummary(false);

    const lines: string[] = ["*Rate Limits & Usage*\n"];

    // Format main rate limit
    if (rateLimits.rateLimits) {
      lines.push(formatRateLimitSnapshot("Primary", rateLimits.rateLimits));
    }

    // Format additional rate limits by ID
    if (rateLimits.rateLimitsByLimitId) {
      for (const [limitId, snapshot] of Object.entries(rateLimits.rateLimitsByLimitId)) {
        if (limitId !== rateLimits.rateLimits.limitId) {
          lines.push(formatRateLimitSnapshot(snapshot.limitName ?? limitId, snapshot));
        }
      }
    }

    // Account info
    if (summary.account && typeof summary.account === "object") {
      const account = summary.account as Record<string, unknown>;
      if (account.type) {
        lines.push(`\n*Account Type:* ${account.type}`);
      }
    }

    return {
      text: lines.join("\n"),
      handled: true
    };
  } catch (error) {
    return {
      text: `Failed to fetch usage information: ${error instanceof Error ? error.message : String(error)}`,
      handled: true
    };
  }
}

function formatRateLimitSnapshot(name: string, snapshot: AppServerRateLimitSnapshot): string {
  const lines: string[] = [`*${name}*`];

  if (snapshot.planType) {
    lines.push(`  Plan: ${snapshot.planType}`);
  }

  if (snapshot.primary) {
    const usedPercent = Math.round(snapshot.primary.usedPercent * 100);
    const remaining = 100 - usedPercent;
    const progressBar = createProgressBar(usedPercent);
    lines.push(`  Primary: ${progressBar} ${remaining}% remaining`);

    if (snapshot.primary.resetsAt) {
      const resetsAt = new Date(snapshot.primary.resetsAt * 1000);
      const now = new Date();
      const diffMs = resetsAt.getTime() - now.getTime();
      const diffMins = Math.max(0, Math.round(diffMs / 60000));
      lines.push(`  Resets in: ${diffMins} minutes`);
    }
  }

  if (snapshot.secondary) {
    const usedPercent = Math.round(snapshot.secondary.usedPercent * 100);
    const remaining = 100 - usedPercent;
    const progressBar = createProgressBar(usedPercent);
    lines.push(`  Secondary: ${progressBar} ${remaining}% remaining`);
  }

  if (snapshot.credits) {
    if (snapshot.credits.unlimited) {
      lines.push(`  Credits: Unlimited`);
    } else if (snapshot.credits.balance) {
      lines.push(`  Credits: ${snapshot.credits.balance}`);
    } else if (snapshot.credits.hasCredits) {
      lines.push(`  Credits: Available`);
    }
  }

  return lines.join("\n");
}

function createProgressBar(usedPercent: number): string {
  const width = 10;
  const filled = Math.round((usedPercent / 100) * width);
  const empty = width - filled;
  return `[${"#".repeat(filled)}${"-".repeat(empty)}]`;
}

function handleStatus(context: SlashCommandContext): SlashCommandResult {
  const { session } = context;

  if (!session) {
    return {
      text: "*Session Status*\nNo active session in this thread.",
      handled: true
    };
  }

  const lines: string[] = ["*Session Status*\n"];

  lines.push(`*Session Key:* \`${session.key}\``);
  lines.push(`*Channel:* \`${session.channelId}\``);
  lines.push(`*Thread:* \`${session.rootThreadTs}\``);
  lines.push(`*Workspace:* \`${session.workspacePath}\``);

  if (session.codexThreadId) {
    lines.push(`*Codex Thread:* \`${session.codexThreadId.slice(0, 12)}...\``);
  }

  if (session.activeTurnId) {
    lines.push(`*Active Turn:* \`${session.activeTurnId.slice(0, 12)}...\``);
    if (session.activeTurnStartedAt) {
      const startedAt = new Date(session.activeTurnStartedAt);
      const duration = Math.round((Date.now() - startedAt.getTime()) / 1000);
      lines.push(`*Turn Duration:* ${duration}s`);
    }
  } else {
    lines.push("*Active Turn:* None (idle)");
  }

  if (session.lastTurnSignalKind) {
    lines.push(`*Last Signal:* ${session.lastTurnSignalKind}${session.lastTurnSignalReason ? ` (${session.lastTurnSignalReason})` : ""}`);
  }

  lines.push(`*Created:* ${formatRelativeTime(session.createdAt)}`);
  lines.push(`*Updated:* ${formatRelativeTime(session.updatedAt)}`);

  return {
    text: lines.join("\n"),
    handled: true
  };
}

function handleWorkspace(context: SlashCommandContext): SlashCommandResult {
  const { session } = context;

  if (!session) {
    return {
      text: "*Workspace*\nNo active session. Start a conversation to create a workspace.",
      handled: true
    };
  }

  return {
    text: `*Current Workspace*\n\`${session.workspacePath}\``,
    handled: true
  };
}

async function handleModel(context: SlashCommandContext): Promise<SlashCommandResult> {
  try {
    const summary = await context.codex.readAccountSummary(false);

    const lines: string[] = ["*Model Information*\n"];

    // The model is managed by Codex app-server, we can only report what we know
    lines.push("Model selection is managed by Codex app-server.");
    lines.push("The broker passes `model: null` to use server defaults.\n");

    if (summary.account && typeof summary.account === "object") {
      const account = summary.account as Record<string, unknown>;
      if (account.type) {
        lines.push(`*Account Type:* ${account.type}`);
      }
    }

    if (summary.quota && typeof summary.quota === "object") {
      const quota = summary.quota as Record<string, unknown>;
      lines.push("*Quota Info:*");
      for (const [key, value] of Object.entries(quota)) {
        if (value !== null && value !== undefined) {
          lines.push(`  ${key}: ${JSON.stringify(value)}`);
        }
      }
    }

    return {
      text: lines.join("\n"),
      handled: true
    };
  } catch (error) {
    return {
      text: `Failed to fetch model information: ${error instanceof Error ? error.message : String(error)}`,
      handled: true
    };
  }
}

function handleSessions(context: SlashCommandContext): SlashCommandResult {
  const allSessions = context.sessions.listSessions();

  if (allSessions.length === 0) {
    return {
      text: "*Active Sessions*\nNo active sessions.",
      handled: true
    };
  }

  const lines: string[] = [`*Active Sessions* (${allSessions.length} total)\n`];

  // Sort by updated time, most recent first
  const sorted = [...allSessions].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  // Show up to 10 sessions
  const displayed = sorted.slice(0, 10);

  for (const session of displayed) {
    const isActive = session.activeTurnId ? " [ACTIVE]" : "";
    const isCurrent = session.channelId === context.channelId && session.rootThreadTs === context.rootThreadTs;
    const marker = isCurrent ? " <-- current" : "";
    lines.push(`- \`${session.channelId}:${session.rootThreadTs.slice(0, 10)}\`${isActive}${marker}`);
    lines.push(`  Updated: ${formatRelativeTime(session.updatedAt)}`);
  }

  if (sorted.length > 10) {
    lines.push(`\n... and ${sorted.length - 10} more sessions`);
  }

  return {
    text: lines.join("\n"),
    handled: true
  };
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    return `${diffDays}d ago`;
  }
  if (diffHours > 0) {
    return `${diffHours}h ago`;
  }
  if (diffMins > 0) {
    return `${diffMins}m ago`;
  }
  return "just now";
}
