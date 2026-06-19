import * as vscode from "vscode";
import * as path from "node:path";
import { workspaceFolder } from "./helpers";
import { resolveContainedRelativePath } from "./path-containment";

type GitExtension = {
  getAPI(version: 1): {
    repositories: Array<{
      rootUri: { fsPath: string };
      state: {
        HEAD?: { name?: string; commit?: string; ahead?: number; behind?: number };
        indexChanges: Array<{ uri: { fsPath: string }; status: number }>;
        workingTreeChanges: Array<{ uri: { fsPath: string }; status: number }>;
        mergeChanges: Array<{ uri: { fsPath: string }; status: number }>;
      };
      diff?: (uri?: vscode.Uri) => Promise<string | undefined>;
      log?: (options?: { maxEntries?: number }) => Promise<Array<{ hash: string; message: string; author?: string; date?: number }>>;
      blame?: (uri: vscode.Uri) => Promise<Array<{ line: number; hash: string; author?: string }>>;
    }>;
  };
};

async function getGitRepo() {
  const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!ext) throw new Error("vscode.git extension is not available");
  if (!ext.isActive) await ext.activate();
  const api = ext.exports.getAPI(1);
  const root = workspaceFolder()?.uri.fsPath;
  const repo = api.repositories.find((r) => root && r.rootUri.fsPath === root) ?? api.repositories[0];
  if (!repo) throw new Error("No git repository found in workspace");
  return repo;
}

function rel(fsPath: string, root: string): string {
  return path.relative(root, fsPath).replace(/\\/g, "/");
}

export async function handleGitStatus(): Promise<unknown> {
  const repo = await getGitRepo();
  const root = repo.rootUri.fsPath;
  const { state } = repo;
  return {
    branch: state.HEAD?.name ?? null,
    commit: state.HEAD?.commit ?? null,
    ahead: state.HEAD?.ahead ?? 0,
    behind: state.HEAD?.behind ?? 0,
    indexChanges: state.indexChanges.map((c) => ({ path: rel(c.uri.fsPath, root), status: c.status })),
    workingTreeChanges: state.workingTreeChanges.map((c) => ({ path: rel(c.uri.fsPath, root), status: c.status })),
    mergeChanges: state.mergeChanges.map((c) => ({ path: rel(c.uri.fsPath, root), status: c.status })),
  };
}

export async function handleGitLog(payload: Record<string, unknown>): Promise<unknown> {
  const repo = await getGitRepo();
  const maxCount = Number(payload.maxCount ?? 20);
  if (!repo.log) throw new Error("Git log API unavailable");
  const commits = await repo.log({ maxEntries: maxCount });
  return {
    commits: commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      author: c.author,
      date: c.date,
    })),
  };
}

export async function handleGitDiff(payload: Record<string, unknown>): Promise<unknown> {
  const repo = await getGitRepo();
  const root = repo.rootUri.fsPath;
  const relPath = payload.path ? String(payload.path) : undefined;
  const uri = relPath ? vscode.Uri.file(resolveContainedRelativePath(root, relPath)) : undefined;
  if (!repo.diff) throw new Error("Git diff API unavailable");
  const diff = await repo.diff(uri);
  const maxBytes = Number(payload.maxBytes ?? 80_000);
  const text = diff ?? "";
  return {
    path: relPath ?? ".",
    staged: Boolean(payload.staged),
    diff: text.length > maxBytes ? `${text.slice(0, maxBytes)}\n... [truncated]` : text,
  };
}

export async function handleGitBlame(payload: Record<string, unknown>): Promise<unknown> {
  const repo = await getGitRepo();
  const root = repo.rootUri.fsPath;
  const relPath = String(payload.path ?? "");
  const uri = vscode.Uri.file(resolveContainedRelativePath(root, relPath));
  if (!repo.blame) throw new Error("Git blame API unavailable");
  const lines = await repo.blame(uri);
  return { path: relPath, lines: lines.slice(0, 500) };
}
