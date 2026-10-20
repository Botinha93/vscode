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

export interface DocumentationItem {
  id: string;
  title: string;
  target?: string;
  featureId?: string;
}

export interface BlockerItem {
  id: string;
  title: string;
  severity: "hard" | "soft";
  detail?: string;
  blocksFeatureIds?: string[];
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
  /** Documentation tasks parsed from the optional `documentation.md` plan section. */
  documentation?: DocumentationItem[];
  /** Blockers/risks parsed from the optional `blockers.md` plan section. */
  blockers?: BlockerItem[];
}

const TASK_STATUSES = new Set<TaskStatus>(["pending", "ready", "running", "completed", "blocked", "failed"]);
const FEATURE_STATUSES = new Set<FeatureStatus>(["draft", "design", "tasks", "dispatching", "done"]);

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((v) => unquoteScalar(v)).filter((v) => v.length > 0);
}

export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Indented lines are continuations consumed by the previous key.
    if (/^\s/.test(line)) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1).trim();
    if (rawValue === "|") {
      const block: string[] = [];
      while (lines[i + 1]?.startsWith("  ")) block.push(lines[++i].slice(2));
      data[key] = block.join("\n");
    } else if (rawValue.startsWith("[")) {
      data[key] = parseInlineArray(rawValue);
    } else if (rawValue === "") {
      const items: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const dashMatch = next.match(/^\s+-\s+(.*)$/);
        if (!dashMatch) break;
        items.push(unquoteScalar(dashMatch[1]));
        i += 1;
      }
      data[key] = items.length > 0 ? items : "";
    } else {
      data[key] = unquoteScalar(rawValue);
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

/**
 * Split markdown into `## ` sections, returning each heading line plus the body
 * text until the next `## ` heading.
 */
function splitSections(markdown: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string }> = [];
  const lines = markdown.split(/\r?\n/);
  let current: { heading: string; body: string[] } | undefined;
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
      current = { heading: h[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push({ heading: current.heading, body: current.body.join("\n").trim() });
  return sections;
}

/**
 * Parse `documentation.md`. Each `## <id> <title>` heading becomes a doc item;
 * an optional `target: <path>` line in the body sets the target file.
 */
export function parseDocumentationItems(markdown: string): DocumentationItem[] {
  return splitSections(markdown).map((s) => {
    const [id, ...rest] = s.heading.split(/\s+/);
    const target = s.body.match(/^target:\s*(.+)$/im)?.[1]?.trim();
    return { id, title: rest.join(" ") || id, ...(target ? { target } : {}) };
  }).filter((d) => d.id);
}

/**
 * Parse `blockers.md`. Each `## <id> [hard|soft] <title>` heading becomes a
 * blocker; the remaining body is its detail. Severity defaults to `hard`.
 */
export function parseBlockerItems(markdown: string): BlockerItem[] {
  return splitSections(markdown).map((s) => {
    const m = s.heading.match(/^(\S+)\s*(?:\[(hard|soft)\])?\s*(.*)$/);
    const id = m?.[1] ?? "";
    const severity: "hard" | "soft" = m?.[2] === "soft" ? "soft" : "hard";
    const title = (m?.[3] || id).trim();
    return { id, title, severity, ...(s.body ? { detail: s.body } : {}) };
  }).filter((b) => b.id);
}
