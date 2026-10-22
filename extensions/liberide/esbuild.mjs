import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sharedRoot = join(__dirname, "../../../packages/shared/src");

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  // Shared Nexus sources live outside this extension's directory, so make its
  // installed dependencies visible when resolving imports from those sources.
  nodePaths: [join(__dirname, "node_modules")],
  alias: {
    "@nexus/shared": join(sharedRoot, "index.ts"),
  },
};

await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: [join(__dirname, "src/extension.ts")],
    platform: "node",
    format: "cjs",
    outfile: join(__dirname, "extension.js"),
    external: ["vscode"],
    target: "node18",
  }),
  esbuild.build({
    ...common,
    entryPoints: [join(__dirname, "src/webview/chat-main.ts")],
    platform: "browser",
    format: "iife",
    outfile: join(__dirname, "media/chat.js"),
    target: "es2022",
  }),
  esbuild.build({
    ...common,
    entryPoints: [join(__dirname, "src/webview/mermaid-entry.ts")],
    platform: "browser",
    format: "iife",
    globalName: "ChatllmMermaid",
    outfile: join(__dirname, "media/mermaid.js"),
    target: "es2022",
  }),
  esbuild.build({
    ...common,
    entryPoints: [join(__dirname, "src/webview/pipeline-main.ts")],
    platform: "browser",
    format: "iife",
    outfile: join(__dirname, "media/pipeline.js"),
    target: "es2022",
  }),
]);
