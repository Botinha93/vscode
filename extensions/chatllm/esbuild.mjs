import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
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
    entryPoints: [join(__dirname, "src/webview/pipeline-main.ts")],
    platform: "browser",
    format: "iife",
    outfile: join(__dirname, "media/pipeline.js"),
    target: "es2022",
  }),
]);
