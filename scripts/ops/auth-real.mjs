#!/usr/bin/env node

import { getAuthRealStatus, replaceAuthInRealContainer } from "./auth-real-lib.mjs";

function parseArgs(argv) {
  const options = {
    command: "status",
    containerName: "slack-codex-broker-real",
    authJsonPath: undefined,
    credentialsJsonPath: undefined,
    configTomlPath: undefined,
    restart: true,
    allowActive: false,
    openInboundLimit: 10,
    logLineLimit: 10
  };

  let index = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    options.command = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--":
        break;
      case "--container":
        options.containerName = argv[index + 1];
        index += 1;
        break;
      case "--auth-json":
        options.authJsonPath = argv[index + 1];
        index += 1;
        break;
      case "--credentials-json":
        options.credentialsJsonPath = argv[index + 1];
        index += 1;
        break;
      case "--config-toml":
        options.configTomlPath = argv[index + 1];
        index += 1;
        break;
      case "--no-restart":
        options.restart = false;
        break;
      case "--allow-active":
        options.allowActive = true;
        break;
      case "--open-inbound-limit":
        options.openInboundLimit = Number(argv[index + 1]);
        index += 1;
        break;
      case "--log-lines":
        options.logLineLimit = Number(argv[index + 1]);
        index += 1;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!["status", "replace"].includes(options.command)) {
    throw new Error(`Unsupported command: ${options.command}`);
  }

  return options;
}

function printHelp() {
  console.log(
    [
      "Usage:",
      "  node scripts/ops/auth-real.mjs status [--container <name>] [--open-inbound-limit <n>] [--log-lines <n>]",
      "  node scripts/ops/auth-real.mjs replace --auth-json <path> [--credentials-json <path>] [--config-toml <path>] [--container <name>] [--no-restart] [--allow-active]"
    ].join("\n")
  );
}

const options = parseArgs(process.argv.slice(2));

if (options.command === "status") {
  console.log(
    JSON.stringify(
      await getAuthRealStatus({
        containerName: options.containerName,
        openInboundLimit: options.openInboundLimit,
        logLineLimit: options.logLineLimit
      }),
      null,
      2
    )
  );
} else {
  console.log(
    JSON.stringify(
      await replaceAuthInRealContainer({
        containerName: options.containerName,
        authJsonPath: options.authJsonPath,
        credentialsJsonPath: options.credentialsJsonPath,
        configTomlPath: options.configTomlPath,
        restart: options.restart,
        allowActive: options.allowActive
      }),
      null,
      2
    )
  );
}
