import { apiFetch, getApiOrigin, getAuthToken } from "../api";
import type { FeatureSpec, TaskContract } from "../spec/schema";
import { validateDag } from "../spec/dag";

export interface SpecDispatchResult {
  graphId: string;
  templateId: string;
  feature: string;
}

function taskInput(feature: FeatureSpec, task: TaskContract): string {
  return [
    `# Task ${task.id}: ${task.title}`,
    `Feature: ${feature.name}`,
    `Requirements: ${task.requirementRefs.join(", ") || "(none)"}`,
    `Design: ${task.designRefs.join(", ") || "(none)"}`,
    "",
    "## Architecture hints",
    task.architectureHints || "(none)",
    "",
    "## Instructions",
    task.body,
  ].join("\n").slice(0, 2000);
}

export async function dispatchFeature(feature: FeatureSpec, options: { conversationId?: string; taskIds?: string[] } = {}): Promise<SpecDispatchResult> {
  const tasks = options.taskIds?.length ? feature.tasks.filter((task) => options.taskIds!.includes(task.id)) : feature.tasks;
  const validation = validateDag(tasks);
  if (!validation.ok) throw new Error(validation.error);
  const response = await apiFetch("/api/specs/dispatch", {
    method: "POST",
    body: JSON.stringify({
      feature: feature.id,
      goal: `Spec dispatch: ${feature.name}`,
      conversationId: options.conversationId,
      priority: "FOREGROUND",
      nodes: tasks.map((task) => ({
        id: task.id,
        type: "IMPLEMENT",
        title: task.title,
        inputSummary: taskInput(feature, task),
        dependsOn: task.dependsOn,
        metadata: { taskId: task.id, produces_context: task.producesContext, requirement_refs: task.requirementRefs, design_refs: task.designRefs },
        agent: task.agent,
        expectedFiles: task.expectedFiles,
        acceptance: task.acceptance,
        requirementRefs: task.requirementRefs,
        designRefs: task.designRefs,
        producesContext: task.producesContext,
      })),
    }),
  });
  if (!response.ok) {
    const err = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(err.error ?? response.statusText);
  }
  return response.json() as Promise<SpecDispatchResult>;
}

export function subscribeExecutionGraphEvents(graphId: string, onEvent: (event: { type: string; nodeId?: string; status?: string }) => void): () => void {
  const origin = getApiOrigin();
  if (!origin) return () => {};
  const controller = new AbortController();
  void (async () => {
    const response = await fetch(`${origin}/api/execution-graphs/${graphId}/events/stream`, {
      headers: getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {},
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const type = part.match(/^event: (.+)$/m)?.[1];
        const data = part.match(/^data: (.+)$/m)?.[1];
        if (type && data) onEvent({ type, ...(JSON.parse(data) as object) });
      }
      if (done) break;
    }
  })().catch(() => {});
  return () => controller.abort();
}

export async function cancelExecutionGraph(graphId: string): Promise<void> {
  await apiFetch(`/api/execution-graphs/${graphId}/cancel`, { method: "POST" });
}
