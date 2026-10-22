import * as vscode from "vscode";
import { parseFrontmatter, type TaskContract, type TaskStatus } from "./schema";

export async function readTextFile(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

export async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

/**
 * Frontmatter in the forms `parseFrontmatter` reads back: lists as dash
 * items (an inline `[a, b]` list splits items at their commas) and multi-line
 * text as `|` blocks (a bare `key: a\nb` keeps only its first line).
 */
/** Keys always written as `|` blocks, even on one line. */
const BLOCK_KEYS = new Set(["architecture_hints"]);

function serializeFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${key}: []`);
      else lines.push(`${key}:`, ...value.map((item) => `  - ${String(item).replace(/\s*\n\s*/g, " ")}`));
    } else if (typeof value === "string" && (value.includes("\n") || BLOCK_KEYS.has(key))) {
      lines.push(`${key}: |`, ...value.split("\n").map((line) => `  ${line}`));
    } else {
      lines.push(`${key}: ${value ?? ""}`);
    }
  }
  return lines.join("\n");
}

/** `error` records why a run failed the task; any other status clears it. */
export async function updateTaskStatus(uri: vscode.Uri, status: TaskStatus, error?: string): Promise<void> {
  const raw = await readTextFile(uri);
  const { data, body } = parseFrontmatter(raw);
  data.status = status;
  if (status === "failed" && error) data.error = error.replace(/\s*\n\s*/g, " ");
  else delete data.error;
  await writeTextFile(uri, `---\n${serializeFrontmatter(data)}\n---\n${body}`);
}

export async function writeTaskContract(task: TaskContract): Promise<void> {
  const frontmatter = serializeFrontmatter({
    id: task.id,
    title: task.title,
    status: task.status,
    requirement_refs: task.requirementRefs,
    design_refs: task.designRefs,
    depends_on: task.dependsOn,
    expected_files: task.expectedFiles,
    architecture_hints: task.architectureHints,
    acceptance: task.acceptance,
    agent: task.agent,
  });
  await writeTextFile(task.filePath, `---\n${frontmatter}\n---\n${task.body}\n`);
}

export async function scaffoldFeature(folder: vscode.WorkspaceFolder, featureName: string): Promise<vscode.Uri> {
  const slug = featureName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-feature";
  const root = vscode.Uri.joinPath(folder.uri, ".liberide", "specs", slug);
  const tasks = vscode.Uri.joinPath(root, "tasks");
  await vscode.workspace.fs.createDirectory(tasks);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "runs"));
  await writeTextFile(vscode.Uri.joinPath(root, "runs", ".gitignore"), "*\n!.gitignore\n");
  await writeTextFile(vscode.Uri.joinPath(root, "feature.md"), `# ${featureName}\n\nstatus: draft\n`);
  await writeTextFile(vscode.Uri.joinPath(root, "requirements.md"), "# Requirements\n\n## R-1 Overview\n\n");
  await writeTextFile(vscode.Uri.joinPath(root, "design.md"), "# Design\n\n## D-1 Architecture\n\n");
  await writeTextFile(vscode.Uri.joinPath(tasks, "index.md"), regenerateTasksIndex([]));
  return root;
}

export function regenerateTasksIndex(tasks: TaskContract[]): string {
  const header = "# Tasks\n\n| ID | Title | Status | Depends on | Requirements | Design |\n|----|-------|--------|------------|--------------|--------|\n";
  return header + tasks.map((t) =>
    `| ${t.id} | ${t.title} | ${t.status} | ${t.dependsOn.join(", ") || "-"} | ${t.requirementRefs.join(", ") || "-"} | ${t.designRefs.join(", ") || "-"} |`,
  ).join("\n") + "\n";
}
