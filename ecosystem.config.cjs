const fs = require("node:fs");
const path = require("node:path");

const repoRoot = __dirname;

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const result = {};
  const raw = fs.readFileSync(filePath, "utf8");

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    if (!key) {
      continue;
    }

    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

const envSource = {
  ...readDotEnv(path.join(repoRoot, ".env")),
  ...process.env
};

const dataRoot = envSource.DATA_ROOT || path.join(repoRoot, ".data");

module.exports = {
  apps: [
    {
      name: "slack-codex-broker",
      cwd: repoRoot,
      script: "dist/src/index.js",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      kill_timeout: 10000,
      env: {
        ...envSource,
        NODE_ENV: envSource.NODE_ENV || "production",
        PORT: envSource.PORT || "3000",
        DATA_ROOT: dataRoot,
        SESSIONS_ROOT: envSource.SESSIONS_ROOT || path.join(dataRoot, "sessions"),
        REPOS_ROOT: envSource.REPOS_ROOT || path.join(dataRoot, "repos"),
        LOG_DIR: envSource.LOG_DIR || path.join(dataRoot, "logs"),
        SERVICE_NAME: envSource.SERVICE_NAME || "slack-codex-broker"
      }
    }
  ]
};
