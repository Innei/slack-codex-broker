import http from "node:http";
import { URL } from "node:url";

import { logger } from "../logger.js";
import type { IsolatedMcpService } from "../services/codex/isolated-mcp-service.js";
import { parseJsonLike, readJsonBody, readString, respondJson } from "./common.js";

export async function handleIntegrationRequest(
  method: string,
  url: URL,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly isolatedMcp: IsolatedMcpService;
  }
): Promise<boolean> {
  if (method === "GET" && url.pathname === "/integrations/mcp-tools") {
    await handleMcpToolsRequest(url, response, options);
    return true;
  }

  if (method === "POST" && url.pathname === "/integrations/mcp-call") {
    await handleMcpCallRequest(request, response, options);
    return true;
  }

  return false;
}

async function handleMcpToolsRequest(
  url: URL,
  response: http.ServerResponse,
  options: {
    readonly isolatedMcp: IsolatedMcpService;
  }
): Promise<void> {
  const server = url.searchParams.get("server")?.trim();
  if (!server) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_query",
      required: ["server"]
    });
    return;
  }

  try {
    const tools = await options.isolatedMcp.listTools(server);
    respondJson(response, 200, {
      ok: true,
      server,
      tools
    });
  } catch (error) {
    respondJson(response, 502, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function handleMcpCallRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  options: {
    readonly isolatedMcp: IsolatedMcpService;
  }
): Promise<void> {
  let body: Record<string, unknown>;

  try {
    body = await readJsonBody(request);
  } catch (error) {
    respondJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const server = readString(body.server);
  const name = readString(body.name);
  const rawArgs = body.arguments;

  logger.raw("http-requests", {
    method: "POST",
    path: "/integrations/mcp-call",
    body: {
      server,
      name,
      arguments: rawArgs
    }
  });

  if (!server || !name) {
    respondJson(response, 400, {
      ok: false,
      error: "missing_required_body",
      required: ["server", "name"]
    });
    return;
  }

  const argsValue = parseJsonLike(rawArgs);
  if (argsValue != null && (typeof argsValue !== "object" || Array.isArray(argsValue))) {
    respondJson(response, 400, {
      ok: false,
      error: "invalid_arguments"
    });
    return;
  }

  try {
    const result = await options.isolatedMcp.callTool({
      server,
      name,
      arguments: (argsValue as Record<string, unknown> | undefined) ?? {}
    });
    respondJson(response, 200, {
      ok: true,
      server,
      name,
      result
    });
  } catch (error) {
    respondJson(response, 502, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
