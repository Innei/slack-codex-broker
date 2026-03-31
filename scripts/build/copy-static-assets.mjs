#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..");

const copies = [
  {
    source: path.join(repoRoot, "src", "services", "codex", "prompts"),
    target: path.join(repoRoot, "dist", "src", "services", "codex", "prompts")
  }
];

for (const entry of copies) {
  await fs.rm(entry.target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(entry.target), { recursive: true });
  await fs.cp(entry.source, entry.target, { recursive: true });
}
