import { describe, expect, it } from "vitest";

import {
  buildWorkspaceContext,
  extractRepoName
} from "../src/services/slack/slack-context-builder.js";
import type { SlackSessionRecord } from "../src/types.js";

describe("slack-context-builder", () => {
  it("omits misleading repo context for generic session workspaces", () => {
    expect(
      extractRepoName("/app/.data/sessions/C0A7XMR9Y1E-1775105171-539349/workspace")
    ).toBeUndefined();
    expect(
      buildWorkspaceContext({
        ...session,
        workspacePath: "/app/.data/sessions/C0A7XMR9Y1E-1775105171-539349/workspace"
      })
    ).toBeUndefined();
  });

  it("extracts repo names from repo-oriented paths", () => {
    expect(extractRepoName("/app/.data/repos/slack-codex-broker")).toBe("slack-codex-broker");
    expect(extractRepoName("/repos/Innei/slack-codex-broker")).toBe("Innei/slack-codex-broker");
  });
});

const session: SlackSessionRecord = {
  key: "C123:111.222",
  channelId: "C123",
  rootThreadTs: "111.222",
  workspacePath: "/tmp/workspace",
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z"
};
