import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

export interface ProjectIdentity {
  /**
   * Stable identifier for the project across moves/clones. Format:
   *  - "git:<hash>"   when a git remote and/or first commit hash exists
   *  - "folder:<encoded path>" when there's a workspace but no git
   *  - "none"        when there is no workspace folder
   */
  id: string;
  source: "git" | "folder" | "none";
  /** Display name. */
  name: string;
  /** Git remote URL when discoverable (normalised lowercase, .git stripped). */
  remoteUrl?: string;
  /** First (root) commit hash, when discoverable. */
  firstCommit?: string;
  /** Current branch HEAD, when discoverable. */
  branch?: string;
  /** Workspace root absolute path. */
  rootPath?: string;
}

function gitExec(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.toString().trim());
    });
  });
}

function normaliseRemote(remote: string): string {
  let out = remote.trim();
  if (out.endsWith(".git")) out = out.slice(0, -4);
  // git@github.com:owner/repo -> github.com/owner/repo
  const sshMatch = out.match(/^[a-zA-Z0-9_-]+@([^:]+):(.+)$/);
  if (sshMatch) out = `${sshMatch[1]}/${sshMatch[2]}`;
  return out.replace(/^https?:\/\//, "").toLowerCase();
}

function shortHash(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 24);
}

export async function detectProjectIdentity(): Promise<ProjectIdentity> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") {
    return { id: "none", source: "none", name: "No workspace" };
  }
  const cwd = folder.uri.fsPath;
  const [remoteRaw, firstCommit, branch] = await Promise.all([
    gitExec(["config", "--get", "remote.origin.url"], cwd),
    gitExec(["rev-list", "--max-parents=0", "HEAD"], cwd),
    gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
  ]);
  if (remoteRaw || firstCommit) {
    const remote = remoteRaw ? normaliseRemote(remoteRaw) : undefined;
    const composite = `${remote ?? ""}|${firstCommit ?? ""}`;
    return {
      id: `git:${shortHash(composite)}`,
      source: "git",
      name: folder.name,
      remoteUrl: remote,
      firstCommit: firstCommit ?? undefined,
      branch: branch ?? undefined,
      rootPath: cwd,
    };
  }
  return {
    id: `folder:${shortHash(cwd)}`,
    source: "folder",
    name: folder.name,
    rootPath: cwd,
  };
}

/**
 * Backend "folder name" used to scope conversations to this project.
 * We use a stable prefix so the web/desktop UIs can recognise project-owned chats.
 */
export function projectFolderName(identity: ProjectIdentity): string {
  if (identity.source === "git" && identity.remoteUrl) {
    return `repo:${identity.remoteUrl}`;
  }
  if (identity.source === "git") {
    return `repo:${identity.id}`;
  }
  if (identity.source === "folder") {
    return `local:${identity.name}`;
  }
  return "workspace";
}

/**
 * Display-friendly secondary label like "github.com/owner/repo" or "~/path".
 */
export function projectSubtitle(identity: ProjectIdentity): string | undefined {
  if (identity.source === "git") {
    return identity.remoteUrl ?? identity.id.replace(/^git:/, "");
  }
  if (identity.source === "folder") {
    return identity.rootPath;
  }
  return undefined;
}
