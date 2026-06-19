import * as vscode from "vscode";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceIntelligence {
  rootPath: string;
  packageManager?: string;
  languages: string[];
  rootMarkers: string[];
  git?: { branch?: string; remoteUrl?: string };
  tasks: Array<{ name: string; source: string; group?: string }>;
  commands: { test?: string; build?: string; typecheck?: string; lint?: string };
  instructionFiles: string[];
  updatedAt: string;
}

const cache = new Map<string, WorkspaceIntelligence>();
let watcherRegistered = false;

function detectPackageManager(root: string): string | undefined {
  if (existsSync(join(root, "bun.lock"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  if (existsSync(join(root, "Cargo.toml"))) return "cargo";
  if (existsSync(join(root, "pyproject.toml"))) return "python";
  return undefined;
}

function detectPackageScripts(root: string): WorkspaceIntelligence["commands"] {
  const packageJson = join(root, "package.json");
  if (!existsSync(packageJson)) return {};
  try {
    const pkg = JSON.parse(readFileSync(packageJson, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    return {
      test: scripts.test ? "npm test" : undefined,
      build: scripts.build ? "npm run build" : undefined,
      typecheck: scripts.typecheck ? "npm run typecheck" : scripts.check ? "npm run check" : undefined,
      lint: scripts.lint ? "npm run lint" : undefined,
    };
  } catch {
    return {};
  }
}

function detectRootMarkers(root: string): string[] {
  return [
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    ".git",
    ".vscode/tasks.json",
    ".chatllm/diagnostics.json",
  ].filter((marker) => existsSync(join(root, marker)));
}

function detectInstructionFiles(root: string): string[] {
  return ["AGENTS.md", "README.md", "CONTRIBUTING.md", ".github/copilot-instructions.md"].filter((file) =>
    existsSync(join(root, file))
  );
}

async function detectGit(root: string): Promise<WorkspaceIntelligence["git"]> {
  const ext = vscode.extensions.getExtension<any>("vscode.git");
  if (!ext) return undefined;
  if (!ext.isActive) await ext.activate();
  const api = ext.exports?.getAPI?.(1);
  const repo = api?.repositories?.find((r: any) => r.rootUri?.fsPath === root);
  if (!repo) return undefined;
  return {
    branch: repo.state?.HEAD?.name,
    remoteUrl: repo.state?.remotes?.[0]?.fetchUrl ?? repo.state?.remotes?.[0]?.pushUrl,
  };
}

async function detectTasks(): Promise<WorkspaceIntelligence["tasks"]> {
  try {
    const tasks = await vscode.tasks.fetchTasks();
    return tasks.slice(0, 25).map((task) => ({
      name: task.name,
      source: String(task.source),
      group: task.group?.id,
    }));
  } catch {
    return [];
  }
}

function detectLanguages(): string[] {
  const languages = new Set<string>();
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.languageId) languages.add(editor.document.languageId);
  }
  return [...languages].slice(0, 20);
}

export async function refreshWorkspaceIntelligence(output?: vscode.OutputChannel): Promise<void> {
  if (!watcherRegistered) {
    watcherRegistered = true;
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshWorkspaceIntelligence(output);
    });
    vscode.window.onDidChangeVisibleTextEditors(() => {
      void refreshWorkspaceIntelligence(output);
    });
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = folder.uri.fsPath;
    try {
      cache.set(root, {
        rootPath: root,
        packageManager: detectPackageManager(root),
        languages: detectLanguages(),
        rootMarkers: detectRootMarkers(root),
        git: await detectGit(root),
        tasks: await detectTasks(),
        commands: detectPackageScripts(root),
        instructionFiles: detectInstructionFiles(root),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      output?.appendLine(`[workspace] failed to refresh ${root}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function getWorkspaceIntelligence(rootPath: string): WorkspaceIntelligence | undefined {
  return cache.get(rootPath);
}

