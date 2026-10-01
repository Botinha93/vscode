import * as vscode from "vscode";
import * as path from "node:path";
import { resolveInsideRootSync } from "./helpers";
import { redactUnifiedDiff } from "./redaction";

/** Subset of the vscode.git v1 API (see extensions/git/src/api/git.d.ts). */
type GitRepository = {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string; commit?: string; ahead?: number; behind?: number };
    indexChanges: Array<{ uri: vscode.Uri; status: number }>;
    workingTreeChanges: Array<{ uri: vscode.Uri; status: number }>;
    mergeChanges: Array<{ uri: vscode.Uri; status: number }>;
  };
  diff(cached?: boolean): Promise<string>;
  diffWithHEAD(path: string): Promise<string>;
  diffIndexWithHEAD(path: string): Promise<string>;
  blame(path: string): Promise<string>;
  log(options?: { maxEntries?: number; path?: string }): Promise<Array<{ hash: string; message: string; authorName?: string; authorEmail?: string; authorDate?: Date }>>;
};

type GitExtension = { getAPI(version: 1): { repositories: GitRepository[] } };

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The repository that contains `root` (the socket's workspace folder), deepest first. */
async function getGitRepo(root: string): Promise<GitRepository> {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) throw new Error("vscode.git extension is not available");
  if (!ext.isActive) await ext.activate();
  const repos = ext.exports.getAPI(1).repositories
    .filter((r) => isInside(r.rootUri.fsPath, root) || isInside(root, r.rootUri.fsPath))
    .sort((a, b) => b.rootUri.fsPath.length - a.rootUri.fsPath.length);
  const repo = repos.find((r) => isInside(r.rootUri.fsPath, root)) ?? repos[0];
  if (!repo) throw new Error("No git repository found in workspace");
  return repo;
}

function rel(fsPath: string, root: string): string {
  return path.relative(root, fsPath).replace(/\\/g, "/");
}

function truncate(text: string, maxBytes: number): string {
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n... [truncated]` : text;
}

export async function handleGitStatus(root: string): Promise<unknown> {
  const repo = await getGitRepo(root);
  const repoRoot = repo.rootUri.fsPath;
  const { state } = repo;
  return {
    branch: state.HEAD?.name ?? null,
    commit: state.HEAD?.commit ?? null,
    ahead: state.HEAD?.ahead ?? 0,
    behind: state.HEAD?.behind ?? 0,
    indexChanges: state.indexChanges.map((c) => ({ path: rel(c.uri.fsPath, repoRoot), status: c.status })),
    workingTreeChanges: state.workingTreeChanges.map((c) => ({ path: rel(c.uri.fsPath, repoRoot), status: c.status })),
    mergeChanges: state.mergeChanges.map((c) => ({ path: rel(c.uri.fsPath, repoRoot), status: c.status })),
  };
}

export async function handleGitLog(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const repo = await getGitRepo(root);
  const maxCount = Math.max(1, Math.min(Number(payload.maxCount ?? 20), 200));
  const relPath = payload.path ? String(payload.path) : undefined;
  const commits = await repo.log({
    maxEntries: maxCount,
    ...(relPath ? { path: resolveInsideRootSync(root, relPath) } : {}),
  });
  return {
    commits: commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      author: c.authorName,
      email: c.authorEmail,
      date: c.authorDate ? new Date(c.authorDate).toISOString() : undefined,
    })),
  };
}

export async function handleGitDiff(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const repo = await getGitRepo(root);
  const relPath = payload.path ? String(payload.path) : undefined;
  const staged = payload.staged === true;
  const maxBytes = Number(payload.maxBytes ?? 80_000);
  let text: string;
  if (relPath) {
    const full = resolveInsideRootSync(root, relPath);
    text = staged ? await repo.diffIndexWithHEAD(full) : await repo.diffWithHEAD(full);
  } else {
    text = await repo.diff(staged);
  }
  // Secret files' hunks are redacted like a read of the file would be.
  return { path: relPath ?? ".", staged, diff: truncate(redactUnifiedDiff(text ?? "", relPath), maxBytes) };
}

export async function handleGitBlame(root: string, payload: Record<string, unknown>): Promise<unknown> {
  const repo = await getGitRepo(root);
  const relPath = String(payload.path ?? "");
  if (!relPath) throw new Error("path is required");
  const blame = await repo.blame(resolveInsideRootSync(root, relPath));
  const lines = (blame ?? "").split("\n").slice(0, 500);
  return { path: relPath, blame: lines.join("\n"), lineCount: lines.length };
}
