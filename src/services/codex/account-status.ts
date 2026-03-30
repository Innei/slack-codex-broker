import type {
  AppServerAccountSummary,
  AppServerRateLimitsResponse
} from "./app-server-client.js";

export interface SerializedAccountStatusOk {
  readonly ok: true;
  readonly account: AppServerAccountSummary["account"];
  readonly requiresOpenaiAuth: boolean;
}

export interface SerializedAccountStatusError {
  readonly ok: false;
  readonly error: string;
}

export type SerializedAccountStatus = SerializedAccountStatusOk | SerializedAccountStatusError;

export interface SerializedRateLimitsStatusOk {
  readonly ok: true;
  readonly rateLimits: AppServerRateLimitsResponse["rateLimits"];
  readonly rateLimitsByLimitId: AppServerRateLimitsResponse["rateLimitsByLimitId"];
}

export interface SerializedRateLimitsStatusError {
  readonly ok: false;
  readonly error: string;
}

export type SerializedRateLimitsStatus = SerializedRateLimitsStatusOk | SerializedRateLimitsStatusError;

export function serializeAccountSummary(summary: AppServerAccountSummary): SerializedAccountStatus {
  return {
    ok: true,
    account: summary.account ?? null,
    requiresOpenaiAuth: summary.requiresOpenaiAuth ?? false
  };
}

export function serializeRateLimits(
  response: AppServerRateLimitsResponse
): SerializedRateLimitsStatus {
  return {
    ok: true,
    rateLimits: response.rateLimits,
    rateLimitsByLimitId: response.rateLimitsByLimitId
  };
}

export function serializeAccountError(error: unknown): SerializedAccountStatusError {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}

export function serializeRateLimitsError(error: unknown): SerializedRateLimitsStatusError {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };
}
