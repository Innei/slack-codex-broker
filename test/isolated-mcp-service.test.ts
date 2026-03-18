import { describe, expect, it, vi } from "vitest";

import { IsolatedMcpService } from "../src/services/codex/isolated-mcp-service.js";

describe("IsolatedMcpService", () => {
  it("lists tools through the injected isolated client and closes it", async () => {
    const close = vi.fn(async () => undefined);
    const createClient = vi.fn(async (server: string) => ({
      close,
      listTools: async () => [
        {
          name: `${server}-search`,
          description: "Search issues"
        }
      ],
      callTool: async () => ({})
    }));
    const service = new IsolatedMcpService({
      codexHome: "/tmp/codex-home",
      isolatedMcpServers: ["linear", "notion"],
      createClient
    });

    await expect(service.listTools("linear")).resolves.toEqual([
      {
        name: "linear-search",
        description: "Search issues"
      }
    ]);
    expect(createClient).toHaveBeenCalledWith("linear");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("calls a tool through the injected isolated client and closes it", async () => {
    const close = vi.fn(async () => undefined);
    const createClient = vi.fn(async () => ({
      close,
      listTools: async () => [],
      callTool: async (name: string, args: Record<string, unknown>) => ({
        structuredContent: {
          name,
          query: typeof args.query === "string" ? args.query : ""
        },
        isError: false
      })
    }));
    const service = new IsolatedMcpService({
      codexHome: "/tmp/codex-home",
      isolatedMcpServers: ["linear", "notion"],
      createClient
    });

    await expect(
      service.callTool({
        server: "notion",
        name: "search",
        arguments: {
          query: "docs"
        }
      })
    ).resolves.toEqual({
      structuredContent: {
        name: "search",
        query: "docs"
      },
      isError: false
    });
    expect(createClient).toHaveBeenCalledWith("notion");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects servers that are not marked as isolated", async () => {
    const createClient = vi.fn();
    const service = new IsolatedMcpService({
      codexHome: "/tmp/codex-home",
      isolatedMcpServers: ["linear", "notion"],
      createClient
    });

    await expect(service.listTools("github")).rejects.toThrowError(
      "unsupported_isolated_mcp_server:github"
    );
    expect(createClient).not.toHaveBeenCalled();
  });
});
