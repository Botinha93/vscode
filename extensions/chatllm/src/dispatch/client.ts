import { apiFetch, getApiOrigin } from "../api";
import type { FeatureSpec, TaskContract } from "../spec/schema";
import { topoSortTasks, validateDag } from "../spec/dag";

export interface SpecDispatchNode {
  id: string;
  type: "IMPLEMENT";
  title: string;
  inputSummary: string;
  dependsOn: string[];
  metadata: Record<string, unknown>;
  agent: string;
  expectedFiles: string[];
  acceptance: string[];
  requirementRefs: string[];
  designRefs: string[];
  producesContext: Array<{ id: string; summary: string }>;
}

export interface SpecDispatchResult {
  graphId: string;
  templateId: string;
  feature: string;
}

export function buildDispatchNodes(feature: FeatureSpec, tasks?: TaskContract[]): SpecDispatchNode[] {
  const taskList = tasks ?? feature.tasks;
  const validation = validateDag(taskList);
  if (!validation.ok) throw new Error(validation.error);

  const sorted = topoSortTasks(taskList);
  return sorted.map((task) => ({
    id: task.id,
    type: "IMPLEMENT" as const,
    title: task.title,
    inputSummary: buildTaskInputSummary(feature, task),
    dependsOn: task.dependsOn,
    metadata: {
      taskId: task.id,
      featureId: feature.id,
      agent: task.agent,
      producesContext: task.producesContext,
    },
    agent: task.agent,
    expectedFiles: task.expectedFiles,
    acceptance: task.acceptance,
    requirementRefs: task.requirementRefs,
    designRefs: task.designRefs,
    producesContext: task.producesContext,
  }));
}

function buildTaskInputSummary(feature: FeatureSpec, task: TaskContract): string {
  const parts = [
    `# Task ${task.id}: ${task.title}`,
    "",
    `Feature: ${feature.name}`,
    "",
    "## Requirement refs",
    task.requirementRefs.length ? task.requirementRefs.join(", ") : "(none)",
    "",
    "## Design refs",
    task.designRefs.length ? task.designRefs.join(", ") : "(none)",
    "",
  ];
  if (task.architectureHints.trim()) {
    parts.push("## Architecture hints", task.architectureHints.trim(), "");
  }
  if (task.body.trim()) {
    parts.push("## Instructions", task.body.trim(), "");
  }
  if (task.producesContext.length) {
    parts.push(
      "## Produces context (for downstream tasks)",
      ...task.producesContext.map((p) => `- **${p.id}**: ${p.summary}`),
      "",
    );
  }
  return parts.join("\n").slice(0, 2000);
}

export async function dispatchFeature(
  feature: FeatureSpec,
  options: { conversationId?: string; taskIds?: string[] } = {},
): Promise<SpecDispatchResult> {
  const tasks =
    options.taskIds?.length
      ? feature.tasks.filter((t) => options.taskIds!.includes(t.id))
      : feature.tasks;

  if (!tasks.length) throw new Error("No tasks to dispatch.");

  const nodes = buildDispatchNodes(feature, tasks);
  const response = await apiFetch("/api/specs/dispatch", {
    method: "POST",
    body: JSON.stringify({
      feature: feature.id,
      goal: `Spec dispatch: ${feature.name}`,
      conversationId: options.conversationId,
      priority: "FOREGROUND",
      nodes,
    }),
  });

  if (!response.ok) {
    const err = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(err.error ?? `Dispatch failed (${response.status})`);
  }

  return response.json() as Promise<SpecDispatchResult>;
}

export async function cancelExecutionGraph(graphId: string): Promise<void> {
  const response = await apiFetch(`/api/execution-graphs/${graphId}/cancel`, { method: "POST" });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(err.error ?? `Cancel failed (${response.status})`);
  }
}

export interface ExecutionGraphEvent {
  type: string;
  graphId?: string;
  nodeId?: string;
  status?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export function subscribeExecutionGraphEvents(
  graphId: string,
  handlers: {
    onEvent?: (event: ExecutionGraphEvent) => void;
    onError?: (error: Error) => void;
    onDone?: () => void;
  },
): () => void {
  const origin = getApiOrigin();
  if (!origin) {
    handlers.onError?.(new Error("CHATLLM_API_ORIGIN is not set."));
    return () => {};
  }

  const token = process.env.CHATLLM_AUTH_TOKEN || "";
  const url = new URL(`${origin}/api/execution-graphs/${graphId}/events/stream`);
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(url.toString(), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const eventLine = part.match(/^event: (.+)$/m)?.[1];
          const dataLine = part.match(/^data: (.+)$/m)?.[1];
          if (!eventLine || !dataLine) continue;
          const data = JSON.parse(dataLine) as Record<string, unknown>;
          const nodeId =
            typeof data.nodeId === "string"
              ? data.nodeId
              : typeof (data as { node?: { id?: string } }).node?.id === "string"
                ? (data as { node: { id: string } }).node.id
                : undefined;
          handlers.onEvent?.({
            type: eventLine,
            graphId,
            nodeId,
            status: typeof data.status === "string" ? data.status : undefined,
            message: typeof data.message === "string" ? data.message : undefined,
            payload: data,
          });
        }
        if (done) break;
      }
      handlers.onDone?.();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return () => controller.abort();
}
