import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "src/index": "./src/index.ts",
    "src/admin-index": "./src/admin-index.ts",
    "src/worker-index": "./src/worker-index.ts",
    "src/tools/job-callback": "./src/tools/job-callback.ts",
    "src/tools/gemini-ui": "./src/tools/gemini-ui.ts"
  },
  format: "esm",
  platform: "node",
  target: "node22",
  outDir: "dist",
  dts: false,
  hash: false,
  outExtensions: () => ({
    js: ".js"
  }),
  deps: {
    alwaysBundle: [
      /^@modelcontextprotocol\/sdk(?:\/.*)?$/,
      /^ws(?:\/.*)?$/
    ],
    onlyBundle: false
  }
});
