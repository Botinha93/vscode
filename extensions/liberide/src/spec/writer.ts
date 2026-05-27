import * as vscode from "vscode";
import { parseFrontmatter, type TaskContract, type TaskStatus } from "./schema";

export async function readTextFile(uri: vscode.Uri): Promise<string> {
  return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
}

export async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

export async function updateTaskStatus(uri: vscode.Uri, status: TaskStatus): Promise<void> {
  const raw = await readTextFile(uri);
  const { data, body } = parseFrontmatter(raw);
  data.status = status;
  const frontmatter = Object.entries(data).map(([key, value]) =>
    Array.isArray(value) ? `${key}: [${value.join(", ")}]` : `${key}: ${value}`,
  );
  await writeTextFile(uri, `---\n${frontmatter.join("\n")}\n---\n${body}`);
}

export async function writeTaskContract(task: TaskContract): Promise<void> {
  const content = `---
id: ${task.id}
title: ${task.title}
status: ${task.status}
requirement_refs: [${task.requirementRefs.join(", ")}]
design_refs: [${task.designRefs.join(", ")}]
depends_on: [${task.dependsOn.join(", ")}]
expected_files: [${task.expectedFiles.join(", ")}]
architecture_hints: |
${task.architectureHints.split("\n").map((line) => `  ${line}`).join("\n")}
acceptance: [${task.acceptance.join(", ")}]
agent: ${task.agent}
---
${task.body}
`;
  await writeTextFile(task.filePath, content);
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
