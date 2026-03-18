import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createHttpHandler } from "../src/http/router.js";

describe("integration routes", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("lists isolated MCP tools through the broker router", async () => {
    const listCalls: string[] = [];
    const server = http.createServer(
      createHttpHandler({
        adminService: {} as never,
        bridge: {} as never,
        isolatedMcp: {
          listTools: async (name: string) => {
            listCalls.push(name);
            return [
              {
                name: "search_issues",
                description: "Search Linear issues"
              }
            ];
          },
          callTool: async () => {
            throw new Error("unexpected_call");
          }
        } as never,
        jobManager: {} as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        })
    );

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind integration route test server");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/integrations/mcp-tools?server=linear`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      server: "linear",
      tools: [
        {
          name: "search_issues",
          description: "Search Linear issues"
        }
      ]
    });
    expect(listCalls).toEqual(["linear"]);
  });

  it("calls an isolated MCP tool through the broker router", async () => {
    const toolCalls: Array<{ server: string; name: string; arguments?: Record<string, unknown> | undefined }> = [];
    const server = http.createServer(
      createHttpHandler({
        adminService: {} as never,
        bridge: {} as never,
        isolatedMcp: {
          listTools: async () => [],
          callTool: async (input: {
            server: string;
            name: string;
            arguments?: Record<string, unknown> | undefined;
          }) => {
            toolCalls.push(input);
            return {
              content: [{ type: "text", text: "ok:notion" }],
              isError: false
            };
          }
        } as never,
        jobManager: {} as never,
        config: {
          serviceName: "test-broker"
        } as never
      })
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        })
    );

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to bind integration route test server");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/integrations/mcp-call`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        server: "notion",
        name: "search",
        arguments: {
          query: "workspace docs"
        }
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      server: "notion",
      name: "search",
      result: {
        content: [{ type: "text", text: "ok:notion" }],
        isError: false
      }
    });
    expect(toolCalls).toEqual([
      {
        server: "notion",
        name: "search",
        arguments: {
          query: "workspace docs"
        }
      }
    ]);
  });
});
