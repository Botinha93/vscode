import * as vscode from "vscode";
import { parseFrontmatter, serializeTaskFrontmatter, type TaskContract, type TaskStatus } from "./schema";

export async function readTextFile(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString("utf8");
}

export async function writeTextFile(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
}

export async function updateTaskStatus(uri: vscode.Uri, status: TaskStatus): Promise<void> {
  const raw = await readTextFile(uri);
  const { data, body } = parseFrontmatter(raw);
  data.status = status;
  const lines = [
    "---",
    ...Object.entries(data).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: ${JSON.stringify(v)}`;
      if (typeof v === "string" && v.includes("\n")) return `${k}: |\n${v.split("\n").map((l) => `  ${l}`).join("\n")}`;
      return `${k}: ${v}`;
    }),
    "---",
    "",
    body,
  ];
  await writeTextFile(uri, lines.join("\n"));
}

export async function writeTaskContract(task: TaskContract): Promise<void> {
  await writeTextFile(task.filePath, serializeTaskFrontmatter(task));
}

export async function scaffoldFeature(workspaceFolder: vscode.WorkspaceFolder, featureName: string): Promise<vscode.Uri> {
  const slug = featureName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const root = vscode.Uri.joinPath(workspaceFolder.uri, ".chatllm", "specs", slug);
  await vscode.workspace.fs.createDirectory(root);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "tasks"));
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "runs"));
  await writeTextFile(vscode.Uri.joinPath(root, "runs", ".gitignore"), "*\n!.gitignore\n");

  const featureMd = `# ${featureName}

status: draft

Brief description of the feature.
`;
  await writeTextFile(vscode.Uri.joinPath(root, "feature.md"), featureMd);

  const requirementsMd = `# Requirements

## R-1 Overview

**User story:** As a user, I want ...

**Acceptance criteria:**
- WHEN ... THEN ...
`;
  await writeTextFile(vscode.Uri.joinPath(root, "requirements.md"), requirementsMd);

  const designMd = `# Design

## D-1 Architecture

Describe how R-1 is implemented.
`;
  await writeTextFile(vscode.Uri.joinPath(root, "design.md"), designMd);

  const indexMd = `# Tasks

| ID | Title | Status | Depends on | Requirements | Design |
|----|-------|--------|------------|--------------|--------|
`;
  await writeTextFile(vscode.Uri.joinPath(root, "tasks", "index.md"), indexMd);

  return root;
}

export function regenerateTasksIndex(tasks: TaskContract[]): string {
  const header = `# Tasks

| ID | Title | Status | Depends on | Requirements | Design |
|----|-------|--------|------------|--------------|--------|
`;
  const rows = tasks
    .map(
      (t) =>
        `| ${t.id} | ${t.title} | ${t.status} | ${t.dependsOn.join(", ") || "—"} | ${t.requirementRefs.join(", ") || "—"} | ${t.designRefs.join(", ") || "—"} |`,
    )
    .join("\n");
  return `${header}${rows}\n`;
}
