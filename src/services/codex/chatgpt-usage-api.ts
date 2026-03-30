import fs from "node:fs/promises";

import type { AppServerRateLimitsResponse, AppServerRateLimitSnapshot } from "./app-server-client.js";

interface StoredAuthTokens {
  readonly access_token?: string | undefined;
  readonly account_id?: string | undefined;
}

interface StoredAuthJson {
  readonly auth_mode?: string | undefined;
  readonly tokens?: StoredAuthTokens | undefined;
}

interface UsageWindowPayload {
  readonly used_percent?: number | null;
  readonly limit_window_seconds?: number | null;
  readonly reset_at?: number | null;
}

interface UsageLimitPayload {
  readonly primary_window?: UsageWindowPayload | null;
  readonly secondary_window?: UsageWindowPayload | null;
}

interface UsageAdditionalLimitPayload {
  readonly limit_name?: string | null;
  readonly metered_feature?: string | null;
  readonly rate_limit?: UsageLimitPayload | null;
}

interface UsagePayload {
  readonly account_id?: string | null;
  readonly email?: string | null;
  readonly plan_type?: string | null;
  readonly rate_limit?: UsageLimitPayload | null;
  readonly code_review_rate_limit?: UsageLimitPayload | null;
  readonly additional_rate_limits?: UsageAdditionalLimitPayload[] | null;
}

export interface ChatGptUsageSnapshot {
  readonly account: {
    readonly email: string | null;
    readonly type: "chatgpt";
    readonly planType: string | null;
  };
  readonly rateLimits: AppServerRateLimitsResponse;
}

export async function readChatGptUsageSnapshot(authJsonPath: string): Promise<ChatGptUsageSnapshot> {
  const auth = await readStoredAuthJson(authJsonPath);
  const accessToken = auth.tokens?.access_token?.trim();
  const accountId = auth.tokens?.account_id?.trim();

  if (!accessToken) {
    throw new Error(`Missing access_token in ${authJsonPath}`);
  }

  if (!accountId) {
    throw new Error(`Missing account_id in ${authJsonPath}`);
  }

  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "ChatGPT-Account-Id": accountId,
      "User-Agent": "codex-cli"
    },
    signal: AbortSignal.timeout(20_000)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ChatGPT usage API failed (${response.status}): ${body || response.statusText}`);
  }

  const payload = (await response.json()) as UsagePayload;
  const primarySnapshot = normalizeRateLimitSnapshot("codex", "Codex", payload.rate_limit, payload.plan_type ?? null);
  const byLimitId: Record<string, AppServerRateLimitSnapshot> = {
    codex: primarySnapshot
  };

  if (payload.code_review_rate_limit) {
    byLimitId.code_review = normalizeRateLimitSnapshot(
      "code_review",
      "Code Review",
      payload.code_review_rate_limit,
      payload.plan_type ?? null
    );
  }

  for (const additionalLimit of payload.additional_rate_limits ?? []) {
    if (!additionalLimit.rate_limit) {
      continue;
    }

    const limitId = additionalLimit.metered_feature ?? additionalLimit.limit_name ?? "additional_limit";
    byLimitId[limitId] = normalizeRateLimitSnapshot(
      limitId,
      additionalLimit.limit_name ?? limitId,
      additionalLimit.rate_limit,
      payload.plan_type ?? null
    );
  }

  return {
    account: {
      email: payload.email ?? null,
      type: "chatgpt",
      planType: payload.plan_type ?? null
    },
    rateLimits: {
      rateLimits: primarySnapshot,
      rateLimitsByLimitId: byLimitId
    }
  };
}

async function readStoredAuthJson(authJsonPath: string): Promise<StoredAuthJson> {
  const raw = await fs.readFile(authJsonPath, "utf8");
  return JSON.parse(raw) as StoredAuthJson;
}

function normalizeRateLimitSnapshot(
  limitId: string,
  limitName: string,
  rateLimit: UsageLimitPayload | null | undefined,
  planType: string | null
): AppServerRateLimitSnapshot {
  return {
    limitId,
    limitName,
    primary: normalizeWindow(rateLimit?.primary_window),
    secondary: normalizeWindow(rateLimit?.secondary_window),
    credits: null,
    planType
  };
}

function normalizeWindow(window: UsageWindowPayload | null | undefined) {
  if (!window) {
    return null;
  }

  return {
    usedPercent: Number(window.used_percent ?? 0),
    windowDurationMins:
      typeof window.limit_window_seconds === "number" ? Math.round(window.limit_window_seconds / 60) : null,
    resetsAt: typeof window.reset_at === "number" ? window.reset_at : null
  };
}
