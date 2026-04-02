/**
 * Safely extracts an error message from an unknown error value.
 * Avoids the repetitive `error instanceof Error ? error.message : String(error)` pattern.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Common patterns that indicate a recoverable Codex connection error.
 * These errors suggest the connection was lost but can be re-established.
 */
export const RECOVERABLE_CODEX_CONNECTION_PATTERNS = [
  "Codex app-server websocket is not connected",
  "Codex app-server websocket closed",
  "WebSocket is not open",
  "readyState 3",
  "socket hang up",
  "ECONNREFUSED",
  "closed"
] as const;

/**
 * Checks if the error indicates a recoverable Codex connection failure.
 */
export function isRecoverableCodexConnectionError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return RECOVERABLE_CODEX_CONNECTION_PATTERNS.some((pattern) => message.includes(pattern));
}
