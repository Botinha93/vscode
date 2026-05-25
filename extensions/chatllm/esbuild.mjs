import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(__dirname, "src/extension.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(__dirname, "extension.js"),
  external: ["vscode"],
  sourcemap: true,
  target: "node18",
  logLevel: "info",
});
