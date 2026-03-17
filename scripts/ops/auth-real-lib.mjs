#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  checkContainer,
  dockerExecNode,
  getDataRootSource,
  getPublishedPort,
  inspectContainer,
  readDetailedStateFromHost,
  readSessionStatsFromHost,
  repoRoot,
  runCommand
} from "./lib.mjs";

async function fileInfo(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return {
      exists: true,
      path: filePath,
      size: stat.size,
      mtime: stat.mtime.toISOString()
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        exists: false,
        path: filePath
      };
    }

    throw error;
  }
}

export function readAccountSummary(containerName) {
  try {
    const raw = dockerExecNode(
      containerName,
      [
        "const WebSocket = require('ws');",
        "const ws = new WebSocket('ws://127.0.0.1:4590');",
        "let counter = 0;",
        "function send(method, params) {",
        "  const id = String(++counter);",
        "  ws.send(JSON.stringify({ id, method, params }));",
        "  return id;",
        "}",
        "ws.on('open', () => {",
        "  send('initialize', { clientInfo: { name: 'ops-auth-real', version: '0.0.0' }, capabilities: { experimentalApi: true } });",
        "});",
        "ws.on('message', (raw) => {",
        "  const msg = JSON.parse(String(raw));",
        "  if (msg.id === '1') {",
        "    send('account/read', { refreshToken: false });",
        "    return;",
        "  }",
        "  if (msg.id === '2') {",
        "    console.log(JSON.stringify(msg.result ?? msg));",
        "    ws.close();",
        "  }",
        "});",
        "ws.on('error', (error) => {",
        "  console.log(JSON.stringify({ ok: false, error: error.stack || String(error) }));",
        "  process.exit(0);",
        "});"
      ].join("\n")
    );
    const parsed = JSON.parse(raw);
    const account = parsed.account ?? null;
    const quota = parsed.quota ?? parsed.usage ?? null;
    return {
      ok: true,
      account,
      quota,
      note: quota
        ? undefined
        : "Codex app-server account/read did not expose quota or usage fields."
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readHealthSummary(hostPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${hostPort}/`);
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: safeParseJson(body)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function readReadySummary(containerName) {
  try {
    return JSON.parse(
      dockerExecNode(
        containerName,
        [
          'fetch("http://127.0.0.1:4590/readyz")',
          "  .then(async (response) => {",
          "    const text = await response.text();",
          "    console.log(JSON.stringify({ ok: response.ok, status: response.status, body: text }));",
          "    if (!response.ok) process.exit(0);",
          "  })",
          "  .catch((error) => {",
          "    console.log(JSON.stringify({ ok: false, error: error.stack || String(error) }));",
          "  });"
        ].join("\n")
      )
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function getAuthRealStatus(options = {}) {
  const containerName = options.containerName ?? "slack-codex-broker-real";
  const openInboundLimit = options.openInboundLimit ?? 10;
  const logLineLimit = options.logLineLimit ?? 10;

  const inspect = inspectContainer(containerName);
  const hostPort = getPublishedPort(inspect);
  const dataRootSource = getDataRootSource(inspect);
  const codexHome = path.join(dataRootSource, "codex-home");
  const state = await readDetailedStateFromHost(dataRootSource, {
    openInboundLimit,
    logLineLimit
  });
  const health = await readHealthSummary(hostPort);
  const ready = readReadySummary(containerName);
  const account = inspect.State?.Running
    ? readAccountSummary(containerName)
    : {
        ok: false,
        error: "container is not running"
      };

  return {
    container: {
      name: containerName,
      status: inspect.State?.Status ?? null,
      running: inspect.State?.Running ?? null,
      startedAt: inspect.State?.StartedAt ?? null,
      restartCount: inspect.RestartCount ?? 0,
      hostPort,
      dataRootSource
    },
    health,
    ready,
    codexHome,
    authFiles: {
      authJson: await fileInfo(path.join(codexHome, "auth.json")),
      credentialsJson: await fileInfo(path.join(codexHome, ".credentials.json")),
      configToml: await fileInfo(path.join(codexHome, "config.toml"))
    },
    account,
    state
  };
}

async function backupIfExists(filePath, backupDir) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }

  await fs.mkdir(backupDir, { recursive: true });
  const target = path.join(backupDir, path.basename(filePath));
  await fs.copyFile(filePath, target);
  return target;
}

async function copyIntoCodexHome(sourcePath, targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
}

export async function replaceAuthInRealContainer(options) {
  const containerName = options.containerName ?? "slack-codex-broker-real";
  if (!options.authJsonPath) {
    throw new Error("authJsonPath is required");
  }

  const inspect = inspectContainer(containerName);
  const dataRootSource = getDataRootSource(inspect);
  const codexHome = path.join(dataRootSource, "codex-home");
  const sessionStats = await readSessionStatsFromHost(dataRootSource);

  if ((options.restart ?? true) && !options.allowActive && sessionStats.activeCount > 0) {
    throw new Error(
      `Refusing auth replacement restart while active sessions exist (activeCount=${sessionStats.activeCount}). Re-run with allowActive if you really want to interrupt them.`
    );
  }

  const replacements = [
    {
      source: options.authJsonPath,
      target: path.join(codexHome, "auth.json")
    },
    options.credentialsJsonPath
      ? {
          source: options.credentialsJsonPath,
          target: path.join(codexHome, ".credentials.json")
        }
      : null,
    options.configTomlPath
      ? {
          source: options.configTomlPath,
          target: path.join(codexHome, "config.toml")
        }
      : null
  ].filter(Boolean);

  for (const entry of replacements) {
    await fs.access(entry.source);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(repoRoot, ".backups", "auth-switches", stamp);
  const backups = [];

  for (const entry of replacements) {
    const backupPath = await backupIfExists(entry.target, backupDir);
    backups.push({
      target: entry.target,
      backupPath
    });
    await copyIntoCodexHome(entry.source, entry.target);
  }

  let checkSummary = undefined;
  let restartAction = "not_requested";
  if (options.restart ?? true) {
    if (inspect.State?.Running) {
      runCommand("docker", ["restart", containerName]);
      restartAction = "restart";
    } else {
      runCommand("docker", ["start", containerName]);
      restartAction = "start";
    }
    checkSummary = await checkContainer(containerName);
  }

  return {
    ok: true,
    containerName,
    codexHome,
    restartAction,
    checkSummary,
    backups,
    replaced: replacements.map((entry) => ({
      source: entry.source,
      target: entry.target
    }))
  };
}
