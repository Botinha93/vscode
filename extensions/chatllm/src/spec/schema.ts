import type * as vscode from "vscode";

export type TaskStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "blocked"
  | "failed";

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
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function asProducesContext(value: unknown): ProducesContextEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({
      id: String(v.id ?? ""),
      summary: String(v.summary ?? ""),
    }))
    .filter((e) => e.id.length > 0);
}

export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value: unknown = trimmed.slice(colon + 1).trim();
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      try {
        value = JSON.parse(value.replace(/'/g, '"'));
      } catch {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
          .filter(Boolean);
      }
    }
    if (value === "true") value = true;
    if (value === "false") value = false;
    data[key] = value;
  }
  return { data, body: match[2] };
}

export function parseTaskContract(
  featureId: string,
  filePath: vscode.Uri,
  raw: string,
): TaskContract | undefined {
  const { data, body } = parseFrontmatter(raw);
  const id = String(data.id ?? "").trim();
  const title = String(data.title ?? "").trim();
  if (!id || !title) return undefined;

  const statusRaw = String(data.status ?? "pending").trim() as TaskStatus;
  const status = TASK_STATUSES.has(statusRaw) ? statusRaw : "pending";

  return {
    id,
    title,
    status,
    requirementRefs: asStringArray(data.requirement_refs ?? data.requirementRefs),
    designRefs: asStringArray(data.design_refs ?? data.designRefs),
    dependsOn: asStringArray(data.depends_on ?? data.dependsOn),
    producesContext: asProducesContext(data.produces_context ?? data.producesContext),
    expectedFiles: asStringArray(data.expected_files ?? data.expectedFiles),
    architectureHints: String(data.architecture_hints ?? data.architectureHints ?? ""),
    acceptance: asStringArray(data.acceptance),
    agent: String(data.agent ?? "coding").trim() || "coding",
    body: body.trim(),
    filePath,
    featureId,
  };
}

export function parseFeatureStatus(raw: string): FeatureStatus {
  const match = raw.match(/status:\s*(\w+)/i);
  const status = (match?.[1] ?? "draft") as FeatureStatus;
  return FEATURE_STATUSES.has(status) ? status : "draft";
}

export function extractSectionIds(markdown: string, prefix: string): string[] {
  const ids: string[] = [];
  const re = new RegExp(`^##\\s+(${prefix}-[\\w.-]+)`, "gim");
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

export function serializeTaskFrontmatter(task: TaskContract): string {
  const lines = [
    "---",
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `requirement_refs: ${JSON.stringify(task.requirementRefs)}`,
    `design_refs: ${JSON.stringify(task.designRefs)}`,
    `depends_on: ${JSON.stringify(task.dependsOn)}`,
    `produces_context:`,
    ...task.producesContext.map((p) => `  - id: ${p.id}\n    summary: ${p.summary}`),
    `expected_files: ${JSON.stringify(task.expectedFiles)}`,
    "architecture_hints: |",
    ...task.architectureHints.split("\n").map((l) => `  ${l}`),
    `acceptance: ${JSON.stringify(task.acceptance)}`,
    `agent: ${task.agent}`,
    "---",
    "",
    task.body,
  ];
  return lines.join("\n");
}
