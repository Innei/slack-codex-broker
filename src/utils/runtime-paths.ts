import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function resolveRuntimeToolPath(fileName: string): string {
  const candidates = [
    path.resolve(moduleDir, "..", "tools", fileName),
    path.resolve(moduleDir, "tools", fileName),
    path.resolve(moduleDir, "src", "tools", fileName)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0]!;
}
