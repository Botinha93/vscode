import * as vscode from "vscode";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolveInsideRoot } from "./helpers";

/**
 * Primitive file operations the server runs on the user's machine when the API
 * is remote. All paths are relative to the socket's workspace folder; the
 * server keeps the edit/patch logic and only asks for these primitives.
 */

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__"]);
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flac",
  ".sqlite", ".db", ".wasm",
]);
const MAX_SEARCH_FILE_BYTES = 2_000_000;

/**
 * Content of each file before the agent first changed it in the current turn
 * (`null` = the file did not exist), so Undo restores exactly that instead of
 * discarding the user's own uncommitted work with a git checkout.
 */
const preEditSnapshots = new Map<string, string | null>();
const MAX_SNAPSHOTS = 200;
const MAX_SNAPSHOT_BYTES = 5_000_000;

async function snapshotBeforeChange(fullPath: string): Promise<void> {
  if (preEditSnapshots.has(fullPath)) return;
  const info = await stat(fullPath).catch(() => undefined);
  if (info && (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES)) return;
  preEditSnapshots.set(fullPath, info ? await readFile(fullPath, "utf8").catch(() => null) : null);
  while (preEditSnapshots.size > MAX_SNAPSHOTS) preEditSnapshots.delete(preEditSnapshots.keys().next().value!);
}

/** Start of a new turn: earlier edits are the baseline now. */
export function resetPreEditSnapshots(): void {
  preEditSnapshots.clear();
}

/**
 * Restore a file to its content before the agent's edits this turn.
 * Returns false when no snapshot exists (the edit did not go through here).
 */
export async function restorePreEditSnapshot(fullPath: string): Promise<boolean> {
  if (!preEditSnapshots.has(fullPath)) return false;
  const before = preEditSnapshots.get(fullPath)!;
  if (before === null) await rm(fullPath, { force: true });
  else {
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, before, "utf8");
  }
  preEditSnapshots.delete(fullPath);
  return true;
}

function relPath(payload: Record<string, unknown>, key = "path"): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

export async function handleFsStat(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const full = await resolveInsideRoot(root, relPath(payload));
  try {
    const info = await stat(full);
    return {
      exists: true,
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
      size: info.size,
      mode: info.mode,
      mtime: info.mtime.toISOString(),
    };
  } catch {
    return { exists: false };
  }
}

export async function handleFsRead(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const full = await resolveInsideRoot(root, relPath(payload));
  return { content: await readFile(full, "utf8") };
}

export async function handleFsWrite(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const full = await resolveInsideRoot(root, relPath(payload));
  const content = typeof payload.content === "string" ? payload.content : "";
  await snapshotBeforeChange(full);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  if (typeof payload.mode === "number") await chmod(full, payload.mode);
  return { bytes: Buffer.byteLength(content) };
}

export async function handleFsDelete(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const full = await resolveInsideRoot(root, relPath(payload));
  if (full === path.resolve(root)) throw new Error("Refusing to delete the workspace root");
  await snapshotBeforeChange(full);
  await rm(full, { force: true, recursive: payload.recursive === true });
  return { deleted: true };
}

export async function handleFsRename(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const from = await resolveInsideRoot(root, relPath(payload, "from"));
  const to = await resolveInsideRoot(root, relPath(payload, "to"));
  if (payload.overwrite !== true && existsSync(to)) throw new Error(`Target already exists: ${String(payload.to)}`);
  await snapshotBeforeChange(from);
  await snapshotBeforeChange(to);
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
  return { renamed: true };
}

interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
  children?: DirectoryEntry[];
}

async function listRecursive(dir: string, root: string, depth: number): Promise<DirectoryEntry[]> {
  if (depth <= 0) return [];
  const entries: DirectoryEntry[] = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    const info = await stat(full).catch(() => undefined);
    if (!info) continue;
    const entry: DirectoryEntry = {
      name: item.name,
      path: path.relative(root, full).replace(/\\/g, "/"),
      type: info.isDirectory() ? "directory" : "file",
      size: Number(info.size),
      modifiedAt: info.mtime.toISOString(),
    };
    if (entry.type === "directory" && depth > 1) entry.children = await listRecursive(full, root, depth - 1);
    entries.push(entry);
  }
  entries.sort((a, b) => (a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name)));
  return entries;
}

export async function handleFsList(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const full = await resolveInsideRoot(root, typeof payload.path === "string" ? payload.path : ".");
  const depth = Math.max(1, Math.min(Number(payload.depth ?? 1), 5));
  const info = await stat(full).catch(() => undefined);
  if (!info) throw new Error(`Directory not found: ${String(payload.path ?? ".")}`);
  if (!info.isDirectory()) throw new Error(`Not a directory: ${String(payload.path ?? ".")}`);
  return { entries: await listRecursive(full, await realpath(root), depth) };
}

interface SearchMatch { file: string; line: number; text: string }

function bundledRipgrep(): string | undefined {
  const candidates = [
    path.join(vscode.env.appRoot, "node_modules", "@vscode", "ripgrep", "bin", "rg"),
    path.join(vscode.env.appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", "rg"),
  ];
  const suffix = process.platform === "win32" ? ".exe" : "";
  return candidates.map((candidate) => candidate + suffix).find((candidate) => existsSync(candidate));
}

function searchWithRipgrep(rg: string, root: string, query: string, isRegex: boolean, include: string | undefined, maxResults: number): Promise<SearchMatch[]> {
  const args = ["--json"];
  if (!isRegex) args.push("--fixed-strings");
  for (const dir of EXCLUDED_DIRS) args.push("--glob", `!${dir}`);
  for (const ext of BINARY_EXTS) args.push("--glob", `!*${ext}`);
  if (include) args.push("--glob", include);
  args.push("--", query, ".");
  return new Promise((resolve, reject) => {
    const proc = spawn(rg, args, { cwd: root, windowsHide: true });
    const results: SearchMatch[] = [];
    let buffer = "";
    const consume = (line: string) => {
      if (!line || results.length >= maxResults) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "match") {
          results.push({ file: String(parsed.data.path.text).replace(/\\/g, "/"), line: parsed.data.line_number, text: String(parsed.data.lines.text ?? "").trimEnd() });
        }
      } catch {
        // skip malformed rg lines
      }
    };
    proc.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(consume);
      if (results.length >= maxResults) proc.kill();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      consume(buffer);
      if (code === 2 && results.length === 0) reject(new Error("ripgrep error"));
      else resolve(results);
    });
  });
}

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

async function searchWithScan(root: string, query: string, isRegex: boolean, include: string | undefined, maxResults: number): Promise<SearchMatch[]> {
  const results: SearchMatch[] = [];
  const pattern = isRegex ? new RegExp(query) : undefined;
  const includeRe = include ? globToRegExp(include) : undefined;
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (results.length >= maxResults) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile() || BINARY_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      const rel = path.relative(root, full).replace(/\\/g, "/");
      if (includeRe && !includeRe.test(entry.name) && !includeRe.test(rel)) continue;
      const info = await stat(full).catch(() => undefined);
      if (!info || info.size > MAX_SEARCH_FILE_BYTES) continue;
      const lines = (await readFile(full, "utf8").catch(() => "")).split("\n");
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        const text = lines[i]!;
        if (pattern ? pattern.test(text) : text.includes(query)) results.push({ file: rel, line: i + 1, text: text.trimEnd() });
      }
    }
  };
  await walk(root);
  return results;
}

export async function handleFsSearch(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const query = String(payload.query ?? "");
  if (!query) throw new Error("query is required");
  const isRegex = payload.isRegex === true;
  const include = typeof payload.includePattern === "string" && payload.includePattern ? payload.includePattern : undefined;
  const maxResults = Math.max(1, Math.min(Number(payload.maxResults ?? 50), 200));
  const realRoot = await realpath(root);
  const rg = bundledRipgrep();
  let results: SearchMatch[] | undefined;
  if (rg) results = await searchWithRipgrep(rg, realRoot, query, isRegex, include, maxResults).catch(() => undefined);
  results ??= await searchWithScan(realRoot, query, isRegex, include, maxResults);
  return { results, totalMatches: results.length };
}
