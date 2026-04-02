import type { SlackSessionRecord } from "../../types.js";
import type { AppServerRateLimitSnapshot } from "../codex/app-server-client.js";

/**
 * Builds context text for Slack Context Blocks.
 * Context blocks appear as small, gray text below the main message.
 */

/**
 * Extract a human-meaningful repo name from a workspace path when possible.
 * Returns undefined for generic broker session workspaces like ".../sessions/<id>/workspace".
 */
export function extractRepoName(workspacePath: string): string | undefined {
  const parts = workspacePath.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }

  const basename = parts[parts.length - 1];
  if (!basename) {
    return undefined;
  }

  if (basename === "workspace" && parts.includes("sessions")) {
    return undefined;
  }

  const reposIndex = parts.lastIndexOf("repos");
  if (reposIndex >= 0) {
    const repoParts = parts.slice(reposIndex + 1);
    if (repoParts.length >= 2) {
      return repoParts.slice(-2).join("/");
    }
    if (repoParts.length === 1) {
      return repoParts[0];
    }
  }

  return basename;
}

/**
 * Build context text for session/workspace info.
 */
export function buildWorkspaceContext(session: SlackSessionRecord): string | undefined {
  const repoName = extractRepoName(session.workspacePath);
  return repoName ? `📁 ${repoName}` : undefined;
}

/**
 * Build context text for turn completion stats.
 */
export function buildTurnStatsContext(options: {
  readonly durationMs: number;
  readonly toolCallCount?: number;
  readonly filesModified?: number;
}): string {
  const parts: string[] = [];

  // Duration
  const seconds = Math.round(options.durationMs / 1000);
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    parts.push(`⏱️ ${minutes}m ${remainingSeconds}s`);
  } else {
    parts.push(`⏱️ ${seconds}s`);
  }

  // Tool calls
  if (options.toolCallCount !== undefined && options.toolCallCount > 0) {
    parts.push(`🔧 ${options.toolCallCount} tool calls`);
  }

  // Files modified
  if (options.filesModified !== undefined && options.filesModified > 0) {
    parts.push(`📝 ${options.filesModified} files`);
  }

  return parts.join(" • ");
}

/**
 * Build context text for error/debug info.
 */
export function buildErrorContext(options: {
  readonly sessionKey: string;
  readonly turnId?: string;
}): string {
  const parts = [`🔍 Session: ${options.sessionKey.slice(0, 12)}...`];
  if (options.turnId) {
    parts.push(`Turn: ${options.turnId.slice(0, 8)}...`);
  }
  return parts.join(" • ");
}

/**
 * Build context text for rate limit warning.
 */
export function buildRateLimitContext(rateLimits: AppServerRateLimitSnapshot): string | undefined {
  const primary = rateLimits.primary;
  if (!primary || primary.usedPercent < 70) {
    return undefined; // Don't show unless approaching limit
  }

  const usedPercent = Math.round(primary.usedPercent);
  const emoji = usedPercent >= 90 ? "🔴" : usedPercent >= 80 ? "🟠" : "🟡";

  let resetText = "";
  if (primary.resetsAt) {
    const resetsInMs = primary.resetsAt - Date.now();
    if (resetsInMs > 0) {
      const resetsInMins = Math.ceil(resetsInMs / 60000);
      resetText = ` • Resets in ${resetsInMins}m`;
    }
  }

  return `${emoji} Rate limit: ${usedPercent}% used${resetText}`;
}

/**
 * Build context text for git status.
 */
export function buildGitContext(options: {
  readonly branch?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly filesChanged?: number;
}): string {
  const parts: string[] = [];

  if (options.branch) {
    parts.push(`🌿 ${options.branch}`);
  }

  if (options.filesChanged !== undefined && options.filesChanged > 0) {
    const changes: string[] = [];
    if (options.additions !== undefined && options.additions > 0) {
      changes.push(`+${options.additions}`);
    }
    if (options.deletions !== undefined && options.deletions > 0) {
      changes.push(`-${options.deletions}`);
    }
    if (changes.length > 0) {
      parts.push(changes.join(" "));
    }
    parts.push(`${options.filesChanged} files`);
  }

  return parts.join(" • ");
}

/**
 * Combine multiple context parts into a single string.
 */
export function combineContextParts(...parts: (string | undefined)[]): string | undefined {
  const filtered = parts.filter((p): p is string => Boolean(p));
  return filtered.length > 0 ? filtered.join(" • ") : undefined;
}
