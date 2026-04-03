import { afterEach, describe, expect, it, vi } from "vitest";

import {
  normalizeSlackImageAttachments,
  SlackApi
} from "../src/services/slack/slack-api.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeSlackImageAttachments", () => {
  it("extracts image metadata and prefers thumbnail URLs", () => {
    const images = normalizeSlackImageAttachments([
      {
        id: "F123",
        name: "screenshot.png",
        title: "Screenshot",
        mimetype: "image/png",
        thumb_1024: "https://example.com/thumb-1024.png",
        url_private_download: "https://example.com/original.png",
        original_w: 1600,
        original_h: 900
      }
    ]);

    expect(images).toEqual([
      {
        fileId: "F123",
        name: "screenshot.png",
        title: "Screenshot",
        mimetype: "image/png",
        width: 1600,
        height: 900,
        url: "https://example.com/thumb-1024.png"
      }
    ]);
  });

  it("ignores non-image files and malformed entries", () => {
    const images = normalizeSlackImageAttachments([
      null,
      {
        id: "F234",
        mimetype: "application/pdf",
        url_private_download: "https://example.com/file.pdf"
      },
      {
        id: "F345",
        mimetype: "image/jpeg"
      }
    ]);

    expect(images).toEqual([]);
  });
});

describe("SlackApi.uploadThreadFile", () => {
  it("uses Slack external upload flow and returns file metadata", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/files.getUploadURLExternal")) {
        expect(init?.method).toBe("POST");
        expect(String(init?.body)).toContain("filename=report.txt");
        expect(String(init?.body)).toContain("length=11");
        return new Response(
          JSON.stringify({
            ok: true,
            upload_url: "https://uploads.slack.test/upload/abc",
            file_id: "F123"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      if (url === "https://uploads.slack.test/upload/abc") {
        expect(init?.method).toBe("POST");
        expect(init?.headers).toMatchObject({
          "content-type": "text/plain"
        });
        expect(Buffer.from((init?.body as Buffer) ?? []).toString("utf8")).toBe("hello world");
        return new Response("ok", { status: 200 });
      }

      if (url.endsWith("/files.completeUploadExternal")) {
        expect(init?.method).toBe("POST");
        const body = String(init?.body);
        expect(body).toContain("channel_id=C123");
        expect(body).toContain("thread_ts=111.222");
        expect(body).toContain("initial_comment=upload+done");
        const params = new URLSearchParams(body);
        expect(params.get("files")).toBe(JSON.stringify([{ id: "F123", title: "Build report" }]));
        return new Response(
          JSON.stringify({
            ok: true,
            files: [
              {
                id: "F123",
                title: "Build report",
                name: "report.txt",
                mimetype: "text/plain",
                permalink: "https://slack.test/files/F123",
                url_private: "https://slack.test/private/F123",
                url_private_download: "https://slack.test/private/F123/download",
                size: 11
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new SlackApi({
      baseUrl: "https://slack.test/api",
      appToken: "xapp-test",
      botToken: "xoxb-test"
    });

    const result = await api.uploadThreadFile({
      channelId: "C123",
      threadTs: "111.222",
      filename: "report.txt",
      bytes: Buffer.from("hello world"),
      title: "Build report",
      initialComment: "upload done",
      contentType: "text/plain"
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      fileId: "F123",
      title: "Build report",
      name: "report.txt",
      mimetype: "text/plain",
      permalink: "https://slack.test/files/F123",
      privateUrl: "https://slack.test/private/F123",
      downloadUrl: "https://slack.test/private/F123/download",
      size: 11
    });
  });
});

describe("SlackApi assistant status and streaming helpers", () => {
  it("serializes loading messages and stream chunks as JSON payloads", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = String(init?.body);
      const params = new URLSearchParams(body);

      if (url.endsWith("/assistant.threads.setStatus")) {
        expect(params.get("channel_id")).toBe("C123");
        expect(params.get("thread_ts")).toBe("111.222");
        expect(params.get("status")).toBe("is thinking…");
        expect(params.get("loading_messages")).toBe(JSON.stringify(["正在理解请求", "正在查看上下文"]));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/chat.startStream")) {
        expect(params.get("channel")).toBe("C123");
        expect(params.get("thread_ts")).toBe("111.222");
        expect(params.get("recipient_user_id")).toBe("U123");
        expect(params.get("recipient_team_id")).toBe("T123");
        expect(params.get("task_display_mode")).toBe("plan");
        expect(params.get("markdown_text")).toBeNull();
        expect(params.get("chunks")).toBe(JSON.stringify([
          {
            type: "markdown_text",
            text: "思考步骤：\n- 已开始分析上下文"
          },
          {
            type: "plan_update",
            title: "Thinking steps"
          }
        ]));
        return new Response(JSON.stringify({ ok: true, ts: "111.333" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/chat.appendStream")) {
        expect(params.get("channel")).toBe("C123");
        expect(params.get("ts")).toBe("111.333");
        expect(params.get("markdown_text")).toBeNull();
        expect(params.get("chunks")).toBe(JSON.stringify([
          {
            type: "markdown_text",
            text: "\n- 已开始组织回复"
          },
          {
            type: "task_update",
            id: "reply",
            title: "整理回复",
            status: "in_progress"
          }
        ]));
        return new Response(JSON.stringify({ ok: true, ts: "111.333" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/chat.stopStream")) {
        expect(params.get("channel")).toBe("C123");
        expect(params.get("ts")).toBe("111.333");
        expect(params.get("markdown_text")).toBeNull();
        expect(params.get("chunks")).toBe(JSON.stringify([
          {
            type: "markdown_text",
            text: "\n- 已发送最终回复"
          },
          {
            type: "task_update",
            id: "reply",
            title: "整理回复",
            status: "complete"
          }
        ]));
        return new Response(JSON.stringify({ ok: true, ts: "111.333" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/reactions.add")) {
        expect(params.get("channel")).toBe("C123");
        expect(params.get("timestamp")).toBe("111.444");
        expect(params.get("name")).toBe("eyes");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new SlackApi({
      baseUrl: "https://slack.test/api",
      appToken: "xapp-test",
      botToken: "xoxb-test"
    });

    await api.setAssistantThreadStatus({
      channelId: "C123",
      threadTs: "111.222",
      status: "is thinking…",
      loadingMessages: ["正在理解请求", "正在查看上下文"]
    });

    const streamTs = await api.startThreadStream({
      channelId: "C123",
      threadTs: "111.222",
      recipientUserId: "U123",
      recipientTeamId: "T123",
      markdownText: "思考步骤：\n- 已开始分析上下文",
      taskDisplayMode: "plan",
      chunks: [
        {
          type: "plan_update",
          title: "Thinking steps"
        }
      ]
    });
    expect(streamTs).toBe("111.333");

    await api.appendThreadStream({
      channelId: "C123",
      streamTs: "111.333",
      markdownText: "\n- 已开始组织回复",
      chunks: [
        {
          type: "task_update",
          id: "reply",
          title: "整理回复",
          status: "in_progress"
        }
      ]
    });

    await api.stopThreadStream({
      channelId: "C123",
      streamTs: "111.333",
      markdownText: "\n- 已发送最终回复",
      chunks: [
        {
          type: "task_update",
          id: "reply",
          title: "整理回复",
          status: "complete"
        }
      ]
    });

    await api.addReaction({
      channelId: "C123",
      messageTs: "111.444",
      name: "eyes"
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("SlackApi.postThreadMessage", () => {
  it("includes context blocks when contextText is provided", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/chat.postMessage")) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      const params = new URLSearchParams(String(init?.body));
      expect(params.get("channel")).toBe("C123");
      expect(params.get("thread_ts")).toBe("111.222");
      expect(params.get("text")).toBe("hello");
      expect(params.get("blocks")).toBe(JSON.stringify([
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "hello"
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "📁 slack-codex-broker"
            }
          ]
        }
      ]));

      return new Response(JSON.stringify({ ok: true, ts: "111.333" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new SlackApi({
      baseUrl: "https://slack.test/api",
      appToken: "xapp-test",
      botToken: "xoxb-test"
    });

    await expect(
      api.postThreadMessage("C123", "111.222", "hello", {
        contextText: "📁 slack-codex-broker"
      })
    ).resolves.toBe("111.333");
  });
});



describe("SlackApi.setAssistantThreadStatus", () => {
  it("sends the explicit loading message alongside the status label", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (!url.endsWith("/assistant.threads.setStatus")) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      expect(init?.method).toBe("POST");
      const body = String(init?.body);
      expect(body).toContain("channel_id=C123");
      expect(body).toContain("thread_ts=111.222");
      expect(body).toContain("status=Reading+files...");
      expect(body).toContain("loading_messages=Reading+files...");

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new SlackApi({
      baseUrl: "https://slack.test/api",
      appToken: "xapp-test",
      botToken: "xoxb-test"
    });

    await api.setAssistantThreadStatus({
      channelId: "C123",
      threadTs: "111.222",
      status: "Reading files..."
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe("SlackApi.listThreadMessages", () => {
  it("preserves bot/app card messages with raw Slack payload", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);

      if (!url.endsWith("/conversations.replies")) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      return new Response(
        JSON.stringify({
          ok: true,
          messages: [
            {
              ts: "111.222",
              subtype: "bot_message",
              bot_id: "B123",
              app_id: "A123",
              username: "Linear",
              text: "zanwei.guo@cue.surf created an issue in the Bridge project",
              attachments: [
                {
                  title: "CUE-1180 感觉 ai chat webview 帧率很低",
                  title_link: "https://linear.app/surf-cue/issue/CUE-1180"
                }
              ]
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new SlackApi({
      baseUrl: "https://slack.test/api",
      appToken: "xapp-test",
      botToken: "xoxb-test"
    });

    const messages = await api.listThreadMessages({
      channelId: "C123",
      rootThreadTs: "111.111",
      channelType: "channel"
    });

    expect(messages).toEqual([
      {
        channelId: "C123",
        channelType: "channel",
        rootThreadTs: "111.111",
        messageTs: "111.222",
        userId: "bot:B123",
        text: "zanwei.guo@cue.surf created an issue in the Bridge project",
        senderKind: "bot",
        botId: "B123",
        appId: "A123",
        senderUsername: "Linear",
        images: [],
        slackMessage: {
          ts: "111.222",
          subtype: "bot_message",
          bot_id: "B123",
          app_id: "A123",
          username: "Linear",
          text: "zanwei.guo@cue.surf created an issue in the Bridge project",
          attachments: [
            {
              title: "CUE-1180 感觉 ai chat webview 帧率很低",
              title_link: "https://linear.app/surf-cue/issue/CUE-1180"
            }
          ]
        }
      }
    ]);
  });
});

describe("SlackApi.getUserIdentity", () => {
  it("parses Slack profile email for inferred co-author mapping", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (!url.endsWith("/users.info")) {
        throw new Error(`Unexpected fetch ${url}`);
      }

      return new Response(JSON.stringify({
        ok: true,
        user: {
          id: "U123",
          name: "alice",
          real_name: "Alice Example",
          profile: {
            display_name: "Alice Slack",
            email: "alice@example.com"
          }
        }
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new SlackApi({
      baseUrl: "https://slack.test/api",
      appToken: "xapp-test",
      botToken: "xoxb-test"
    });

    await expect(api.getUserIdentity("U123")).resolves.toEqual({
      userId: "U123",
      mention: "<@U123>",
      username: "alice",
      displayName: "Alice Slack",
      realName: "Alice Example",
      email: "alice@example.com"
    });
  });
});

describe("SlackApi interactivity helpers", () => {
  it("posts ephemeral thread prompts and opens views", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/chat.postEphemeral")) {
        expect(String(init?.body)).toContain("channel=C123");
        expect(String(init?.body)).toContain("user=U123");
        expect(String(init?.body)).toContain("thread_ts=111.222");
        expect(String(init?.body)).toContain("blocks=");
        return new Response(JSON.stringify({ ok: true, message_ts: "111.333" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.endsWith("/views.open")) {
        expect(String(init?.body)).toContain("trigger_id=trigger-1");
        expect(String(init?.body)).toContain("view=");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const api = new SlackApi({
      baseUrl: "https://slack.test/api",
      appToken: "xapp-test",
      botToken: "xoxb-test"
    });

    await expect(api.postEphemeral({
      channelId: "C123",
      threadTs: "111.222",
      userId: "U123",
      text: "Configure co-authors",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello" } }]
    })).resolves.toBe("111.333");

    await expect(api.openView({
      triggerId: "trigger-1",
      view: { type: "modal", title: { type: "plain_text", text: "Demo" } }
    })).resolves.toBeUndefined();
  });
});
