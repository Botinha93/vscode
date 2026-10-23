import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const outputs = [
	"extension.js",
	"extension.js.map",
	"media/chat.js",
	"media/chat.js.map",
	"media/mermaid.js",
	"media/mermaid.js.map",
	"media/pipeline.js",
	"media/pipeline.js.map",
];
const tempRoot = await mkdtemp(join(tmpdir(), "liberide-reproducibility-"));

async function hashBuild(name) {
	const destination = join(tempRoot, name);
	await mkdir(join(destination, "media"), { recursive: true });
	const result = spawnSync(process.execPath, [join(extensionDir, "esbuild.mjs")], {
		cwd: extensionDir,
		env: { ...process.env, LIBERIDE_BUILD_OUT_DIR: destination },
		encoding: "utf8",
	});
	if (result.status !== 0) {
		process.stderr.write(result.stdout ?? "");
		process.stderr.write(result.stderr ?? "");
		throw new Error(`Build ${name} failed with status ${result.status}`);
	}
	const hashes = new Map();
	for (const file of outputs) {
		const bytes = await readFile(join(destination, file));
		hashes.set(file, createHash("sha256").update(bytes).digest("hex"));
	}
	return hashes;
}

try {
	const first = await hashBuild("first");
	const second = await hashBuild("second");
	const differences = outputs.filter((file) => first.get(file) !== second.get(file));
	if (differences.length > 0) {
		throw new Error(`LiberIDE build outputs are not reproducible: ${differences.join(", ")}`);
	}
	for (const file of outputs) {
		console.log(`${createHash("sha256").update(await readFile(join(tempRoot, "first", file))).digest("hex")}  ${file}`);
	}
	console.log(`Verified ${outputs.length} LiberIDE bundle and source-map files are byte-identical across two clean output directories.`);
} finally {
	await rm(resolve(tempRoot), { recursive: true, force: true });
}
