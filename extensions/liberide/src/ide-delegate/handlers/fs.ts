import * as vscode from "vscode";
import * as path from "node:path";
import { constants as fsConstants, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isPathInside, requestConversationId, resolveInsideRoot } from "./helpers";
import { redactIfSecret } from "./redaction";

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
 * discarding the user's own uncommitted work with a git checkout. Kept per
 * conversation: one chat's new turn must not wipe another chat's baseline.
 */
const preEditSnapshots = new Map<string, Map<string, string | null>>();
const MAX_SNAPSHOTS = 200;
const MAX_SNAPSHOT_BYTES = 5_000_000;
const MAX_SNAPSHOT_SCOPES = 20;
/** Scope for requests that carry no conversation (another client, an old server). */
const DEFAULT_SCOPE = "";

function snapshotScope(scope: string): Map<string, string | null> {
  let map = preEditSnapshots.get(scope);
  if (!map) {
    map = new Map();
    preEditSnapshots.set(scope, map);
    while (preEditSnapshots.size > MAX_SNAPSHOT_SCOPES) preEditSnapshots.delete(preEditSnapshots.keys().next().value!);
  }
  return map;
}

/**
 * Remember `fullPath`'s current content (once per turn) before an agent
 * change. `scope` defaults to the conversation of the current request.
 */
export async function snapshotBeforeChange(fullPath: string, scope = requestConversationId() ?? DEFAULT_SCOPE): Promise<void> {
  const snapshots = snapshotScope(scope);
  if (snapshots.has(fullPath)) return;
  const info = await lstat(fullPath).catch(() => undefined);
  if (info && (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES)) return;
  snapshots.set(fullPath, info ? await readFile(fullPath, "utf8").catch(() => null) : null);
  while (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
}

/** Start of a new turn in `scope` (a conversation): earlier edits are the baseline now. No scope clears all. */
export function resetPreEditSnapshots(scope?: string): void {
  if (scope === undefined) preEditSnapshots.clear();
  else preEditSnapshots.delete(scope);
}

/**
 * Restore a file to its content before the agent's edits this turn in
 * `scope` (default: requests without a conversation).
 * Returns false when no snapshot exists (the edit did not go through here).
 */
export async function restorePreEditSnapshot(fullPath: string, scope = DEFAULT_SCOPE): Promise<boolean> {
  const snapshots = preEditSnapshots.get(scope);
  if (!snapshots?.has(fullPath)) return false;
  const before = snapshots.get(fullPath)!;
  if (before === null) await rm(fullPath, { force: true });
  else {
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFileNoFollow(fullPath, before);
  }
  snapshots.delete(fullPath);
  return true;
}

/** Write without following a symlink at `fullPath` (O_NOFOLLOW where the platform has it). */
async function writeFileNoFollow(fullPath: string, content: string, mode?: number): Promise<void> {
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(fullPath, flags, 0o666);
  try {
    await handle.writeFile(content, "utf8");
    if (mode !== undefined) await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

/** Largest file `vscode.fs.read` returns whole; bigger files need a byte range. */
export const MAX_READ_BYTES = 20_000_000;

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

/**
 * Read a file. Whole files are capped at MAX_READ_BYTES; `offset`/`length`
 * (bytes) read a range of a larger one and report the total `size`.
 */
export async function handleFsRead(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const full = await resolveInsideRoot(root, relPath(payload));
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`Not a file: ${String(payload.path)}`);
  const ranged = payload.offset !== undefined || payload.length !== undefined;
  if (!ranged) {
    if (info.size > MAX_READ_BYTES) {
      throw new Error(`File is too large to read whole (${info.size} bytes, limit ${MAX_READ_BYTES}); pass offset/length to read a range`);
    }
    return { content: await readFile(full, "utf8") };
  }
  const offset = Math.max(0, Math.floor(Number(payload.offset ?? 0)) || 0);
  const length = Math.max(0, Math.min(Math.floor(Number(payload.length ?? MAX_READ_BYTES)) || 0, MAX_READ_BYTES, Math.max(0, info.size - offset)));
  const handle = await open(full, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), offset, length: bytesRead, size: info.size, hasMore: offset + bytesRead < info.size };
  } finally {
    await handle.close();
  }
}

export async function handleFsWrite(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const full = await resolveInsideRoot(root, relPath(payload), { forWrite: true });
  const content = typeof payload.content === "string" ? payload.content : "";
  await snapshotBeforeChange(full);
  await mkdir(path.dirname(full), { recursive: true });
  // The parent may have been swapped for a link since the check: re-verify it.
  if (!isPathInside(await realpath(root), await realpath(path.dirname(full)))) {
    throw new Error("Path escapes the workspace folder");
  }
  await writeFileNoFollow(full, content, typeof payload.mode === "number" ? payload.mode : undefined);
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
    // lstat: a symlinked directory could point outside the folder (or loop).
    const info = await lstat(full).catch(() => undefined);
    if (!info || info.isSymbolicLink()) continue;
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

interface SearchMatch { file: string; line: number; text: string; redacted?: boolean }

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

interface IgnoreRule { re: RegExp; dirOnly: boolean; negate: boolean; anchored: boolean }

/** Parse one `.gitignore` (the common subset: globs, `/` anchoring, trailing `/`, `!`). */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.replace(/\/+$/, "");
    const anchored = line.includes("/");
    line = line.replace(/^\//, "").replace(/^\*\*\//, "");
    if (!line) continue;
    rules.push({ re: globToRegExp(line), dirOnly, negate, anchored: anchored && !raw.trimStart().startsWith("**/") });
  }
  return rules;
}

/** Whether `rel` (relative to the rules' directory) is ignored; the last matching rule wins. */
export function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  const name = rel.split("/").pop() ?? rel;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.anchored ? rule.re.test(rel) : rule.re.test(name) || rule.re.test(rel)) ignored = !rule.negate;
  }
  return ignored;
}

/**
 * Fallback search without ripgrep. Like rg's defaults it skips hidden
 * entries and honours `.gitignore` files (each directory's own rules apply
 * below it), so it does not read what rg would not.
 */
async function searchWithScan(root: string, query: string, isRegex: boolean, include: string | undefined, maxResults: number): Promise<SearchMatch[]> {
  const results: SearchMatch[] = [];
  const pattern = isRegex ? new RegExp(query) : undefined;
  const includeRe = include ? globToRegExp(include) : undefined;
  type Scope = { dir: string; rules: IgnoreRule[] };
  const ignoredBy = (scopes: Scope[], full: string, isDir: boolean) =>
    scopes.some((scope) => isIgnored(scope.rules, path.relative(scope.dir, full).replace(/\\/g, "/"), isDir));
  const walk = async (dir: string, parents: Scope[]): Promise<void> => {
    const ignoreText = await readFile(path.join(dir, ".gitignore"), "utf8").catch(() => "");
    const scopes = ignoreText ? [...parents, { dir, rules: parseGitignore(ignoreText) }] : parents;
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (results.length >= maxResults) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");
      const explicitlyIncluded = includeRe !== undefined && (includeRe.test(entry.name) || includeRe.test(rel));
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith(".") || ignoredBy(scopes, full, true)) continue;
        await walk(full, scopes);
        continue;
      }
      if (!entry.isFile() || BINARY_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      if (includeRe && !explicitlyIncluded) continue;
      // An explicit include glob reaches hidden/ignored files, as `rg --glob` does.
      if (!explicitlyIncluded && (entry.name.startsWith(".") || ignoredBy(scopes, full, false))) continue;
      const info = await stat(full).catch(() => undefined);
      if (!info || info.size > MAX_SEARCH_FILE_BYTES) continue;
      const lines = (await readFile(full, "utf8").catch(() => "")).split("\n");
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        const text = lines[i]!;
        if (pattern ? pattern.test(text) : text.includes(query)) results.push({ file: rel, line: i + 1, text: text.trimEnd() });
      }
    }
  };
  await walk(root, []);
  return results;
}

/** Secret files' matched lines are redacted exactly as a read of the file would be. */
export function redactSearchMatches(results: SearchMatch[]): SearchMatch[] {
  return results.map((match) => {
    const { text, redacted } = redactIfSecret(match.file, match.text);
    return redacted ? { ...match, text, redacted: true } : match;
  });
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
  results = redactSearchMatches(results);
  return { results, totalMatches: results.length };
}
