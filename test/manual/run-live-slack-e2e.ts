import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

interface SlackAuthTestResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly team?: string;
  readonly team_id?: string;
  readonly user?: string;
  readonly user_id?: string;
  readonly bot_id?: string;
  readonly url?: string;
}

interface SlackPostedMessageResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly ts?: string;
  readonly channel?: string;
}

interface SlackMessage {
  readonly ts?: string;
  readonly text?: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly thread_ts?: string;
}

interface SlackConversationRepliesResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly messages?: SlackMessage[];
}

interface LiveSlackE2EResult {
  readonly channelId: string;
  readonly rootMessageTs: string;
  readonly runId: string;
  readonly targetFile: string;
  readonly targetRepo: string;
  readonly triggerUserId: string;
  readonly botUserId: string;
  readonly startedAt: string;
  finishedAt: string;
  passed: boolean;
  failureMessage?: string;
  assistantReplyTs?: string;
  assistantReplyText?: string;
  threadUrl?: string;
}

const DEFAULT_RESULT_PATH = "artifacts/slack-live-e2e/result.json";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_TARGET_REPO = "slack-codex-broker";
const DEFAULT_TARGET_FILE = "src/services/slack/slack-codex-bridge.ts";
const DEFAULT_API_BASE_URL = "https://slack.com/api";

class SlackApiClient {
  readonly #token: string;
  readonly #apiBaseUrl: string;

  constructor(token: string, apiBaseUrl: string) {
    this.#token = token;
    this.#apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
  }

  async authTest(): Promise<SlackAuthTestResponse> {
    return await this.#call<SlackAuthTestResponse>("auth.test", {}, "POST");
  }

  async postMessage(args: {
    readonly channel: string;
    readonly text: string;
    readonly unfurl_links?: boolean;
    readonly unfurl_media?: boolean;
  }): Promise<SlackPostedMessageResponse> {
    return await this.#call<SlackPostedMessageResponse>("chat.postMessage", {
      channel: args.channel,
      text: args.text,
      unfurl_links: String(args.unfurl_links ?? false),
      unfurl_media: String(args.unfurl_media ?? false)
    }, "POST");
  }

  async conversationReplies(args: {
    readonly channel: string;
    readonly ts: string;
    readonly limit?: number;
    readonly inclusive?: boolean;
  }): Promise<SlackConversationRepliesResponse> {
    return await this.#call<SlackConversationRepliesResponse>("conversations.replies", {
      channel: args.channel,
      ts: args.ts,
      limit: String(args.limit ?? 50),
      inclusive: String(args.inclusive ?? true)
    }, "GET");
  }

  async getPermalink(args: {
    readonly channel: string;
    readonly message_ts: string;
  }): Promise<{ readonly ok: boolean; readonly error?: string; readonly permalink?: string }> {
    return await this.#call("chat.getPermalink", args, "GET");
  }

  async #call<T>(method: string, args: Record<string, string>, httpMethod: "GET" | "POST"): Promise<T> {
    const url = httpMethod === "GET"
      ? `${this.#apiBaseUrl}/${method}?${new URLSearchParams(args).toString()}`
      : `${this.#apiBaseUrl}/${method}`;
    const response = await fetch(url, {
      method: httpMethod,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: httpMethod === "POST" ? new URLSearchParams(args).toString() : undefined
    });

    const json = await response.json() as { readonly ok?: boolean; readonly error?: string };
    if (!response.ok || json.ok === false) {
      throw new Error(`Slack API ${method} failed: ${json.error ?? response.statusText}`);
    }

    return json as T;
  }
}

async function main(): Promise<void> {
  const slackBotToken = requireEnv("SLACK_BOT_TOKEN");
  const triggerUserToken = requireEnv("SLACK_E2E_TRIGGER_USER_TOKEN");
  const channelId = requireEnv("SLACK_E2E_CHANNEL_ID");
  const apiBaseUrl = process.env.SLACK_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;
  const timeoutMs = Number(process.env.SLACK_E2E_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const resultPath = process.env.SLACK_E2E_RESULT_PATH?.trim() || DEFAULT_RESULT_PATH;
  const targetRepo = process.env.SLACK_E2E_TARGET_REPO?.trim() || DEFAULT_TARGET_REPO;
  const targetFile = process.env.SLACK_E2E_TARGET_FILE?.trim() || DEFAULT_TARGET_FILE;

  const botClient = new SlackApiClient(slackBotToken, apiBaseUrl);
  const triggerClient = new SlackApiClient(triggerUserToken, apiBaseUrl);
  const threadReadToken = process.env.SLACK_E2E_READ_TOKEN?.trim() || triggerUserToken;
  const readClient = new SlackApiClient(threadReadToken, apiBaseUrl);

  const botIdentity = await botClient.authTest();
  const triggerIdentity = await triggerClient.authTest();

  if (!botIdentity.user_id) {
    throw new Error("Slack bot auth.test did not return user_id");
  }
  if (!triggerIdentity.user_id) {
    throw new Error("Slack trigger-user auth.test did not return user_id");
  }

  const runId = `LIVE_E2E_${crypto.randomUUID().slice(0, 8)}`;
  const prompt = createPrompt(botIdentity.user_id, runId, targetRepo, targetFile);
  const rootMessage = await triggerClient.postMessage({
    channel: channelId,
    text: prompt,
    unfurl_links: false,
    unfurl_media: false
  });

  if (!rootMessage.ts) {
    throw new Error("Slack chat.postMessage did not return ts");
  }

  const result: LiveSlackE2EResult = {
    channelId,
    rootMessageTs: rootMessage.ts,
    runId,
    targetFile,
    targetRepo,
    triggerUserId: triggerIdentity.user_id,
    botUserId: botIdentity.user_id,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    passed: false
  };

  try {
    const assistantReply = await waitForAssistantReply({
      slackClient: readClient,
      channelId,
      rootTs: rootMessage.ts,
      runId,
      timeoutMs
    });
    result.assistantReplyTs = assistantReply.ts;
    result.assistantReplyText = assistantReply.text;
    result.passed = true;

    const permalink = await readClient.getPermalink({
      channel: channelId,
      message_ts: rootMessage.ts
    }).catch(() => undefined);
    if (permalink?.permalink) {
      result.threadUrl = permalink.permalink;
    }
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    result.finishedAt = new Date().toISOString();
    await writeResult(resultPath, result);
  }

  console.info(JSON.stringify(result, null, 2));
}

function createPrompt(botUserId: string, runId: string, targetRepo: string, targetFile: string): string {
  return [
    `<@${botUserId}> ${runId}`,
    `Use repository ${targetRepo} for this task.`,
    `Please inspect ${targetFile} in repo ${targetRepo}.`,
    "Use file-reading tools instead of guessing.",
    "Reply with exactly two bullet points.",
    `The first bullet must start with "LIVE_E2E_OK ${runId}".`,
    `The second bullet must start with "WORKSPACE_OK ${targetRepo}" and briefly describe what you found.`
  ].join(" ");
}

async function waitForAssistantReply(options: {
  readonly slackClient: SlackApiClient;
  readonly channelId: string;
  readonly rootTs: string;
  readonly runId: string;
  readonly timeoutMs: number;
}): Promise<{ readonly ts: string; readonly text: string }> {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const replies = await options.slackClient.conversationReplies({
      channel: options.channelId,
      ts: options.rootTs,
      inclusive: true,
      limit: 50
    });

    for (const message of replies.messages ?? []) {
      if (!message.ts || message.ts === options.rootTs || typeof message.text !== "string") {
        continue;
      }
      if (message.text.includes(`LIVE_E2E_OK ${options.runId}`)) {
        return {
          ts: message.ts,
          text: message.text
        };
      }
    }

    await delay(3_000);
  }

  throw new Error(`Timed out waiting for assistant reply for run ${options.runId}`);
}

async function writeResult(resultPath: string, result: LiveSlackE2EResult): Promise<void> {
  const absolutePath = path.resolve(resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
