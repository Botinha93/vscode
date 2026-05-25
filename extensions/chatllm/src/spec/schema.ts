import type * as vscode from "vscode";

export type TaskStatus = "pending" | "ready" | "running" | "completed" | "blocked" | "failed";
export type FeatureStatus = "draft" | "design" | "tasks" | "dispatching" | "done";

export interface ProducesContextEntry {
  id: string;
  summary: string;
}

export interface TaskContract {
  id: string;
  title: string;
  status: TaskStatus;
  requirementRefs: string[];
  designRefs: string[];
  dependsOn: string[];
  producesContext: ProducesContextEntry[];
  expectedFiles: string[];
  architectureHints: string;
  acceptance: string[];
  agent: string;
  body: string;
  filePath: vscode.Uri;
  featureId: string;
}

export interface FeatureSpec {
  id: string;
  name: string;
  status: FeatureStatus;
  rootUri: vscode.Uri;
  featureMdUri?: vscode.Uri;
  requirementsUri?: vscode.Uri;
  designUri?: vscode.Uri;
  tasksDirUri?: vscode.Uri;
  requirementIds: string[];
  designIds: string[];
  tasks: TaskContract[];
}

const TASK_STATUSES = new Set<TaskStatus>(["pending", "ready", "running", "completed", "blocked", "failed"]);
const FEATURE_STATUSES = new Set<FeatureStatus>(["draft", "design", "tasks", "dispatching", "done"]);

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed.slice(1, -1).split(",").map((v) => v.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon < 0 || line.startsWith(" ")) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (rawValue === "|") {
      const block: string[] = [];
      while (lines[i + 1]?.startsWith("  ")) block.push(lines[++i].slice(2));
      data[key] = block.join("\n");
    } else if (rawValue.startsWith("[")) {
      data[key] = parseInlineArray(rawValue);
    } else {
      data[key] = rawValue;
    }
  }
  return { data, body: match[2] };
}

export function parseTaskContract(featureId: string, filePath: vscode.Uri, raw: string): TaskContract | undefined {
  const { data, body } = parseFrontmatter(raw);
  const id = String(data.id ?? "").trim();
  const title = String(data.title ?? "").trim();
  if (!id || !title) return undefined;
  const statusRaw = String(data.status ?? "pending").trim() as TaskStatus;
  return {
    id,
    title,
    status: TASK_STATUSES.has(statusRaw) ? statusRaw : "pending",
    requirementRefs: asStringArray(data.requirement_refs),
    designRefs: asStringArray(data.design_refs),
    dependsOn: asStringArray(data.depends_on),
    producesContext: [],
    expectedFiles: asStringArray(data.expected_files),
    architectureHints: String(data.architecture_hints ?? ""),
    acceptance: asStringArray(data.acceptance),
    agent: String(data.agent ?? "coding"),
    body: body.trim(),
    filePath,
    featureId,
  };
}

export function parseFeatureStatus(raw: string): FeatureStatus {
  const status = (raw.match(/status:\s*(\w+)/i)?.[1] ?? "draft") as FeatureStatus;
  return FEATURE_STATUSES.has(status) ? status : "draft";
}

export function extractSectionIds(markdown: string, prefix: string): string[] {
  const ids: string[] = [];
  const re = new RegExp(`^##\\s+(${prefix}-[\\w.-]+)`, "gim");
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) ids.push(match[1]);
  return ids;
}
