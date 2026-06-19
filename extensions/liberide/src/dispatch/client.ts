import { apiFetch, sseStream } from "../api";
import type { FeatureSpec, TaskContract } from "../spec/schema";
import type { IdeToolContextPayload } from "../chat/types";
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

export async function dispatchFeature(feature: FeatureSpec, options: { conversationId?: string; taskIds?: string[]; ideContext?: IdeToolContextPayload; swarm?: boolean; isolation?: "worktree" | "shared" } = {}): Promise<SpecDispatchResult> {
  const tasks = options.taskIds?.length ? feature.tasks.filter((task) => options.taskIds!.includes(task.id)) : feature.tasks;
  const validation = validateDag(tasks);
  if (!validation.ok) throw new Error(validation.error);
  const response = await apiFetch("/api/specs/dispatch", {
    method: "POST",
    body: JSON.stringify({
      feature: feature.id,
      goal: `Spec dispatch: ${feature.name}`,
      conversationId: options.conversationId,
      ideContext: options.ideContext,
      priority: "FOREGROUND",
      ...(options.swarm ? { swarm: true, isolation: options.isolation ?? "shared" } : {}),
      ...(feature.documentation?.length ? { documentation: feature.documentation } : {}),
      ...(feature.blockers?.length ? { blockers: feature.blockers } : {}),
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

export function subscribeExecutionGraphEvents(
  graphId: string,
  onEvent: (event: { type: string; nodeId?: string; status?: string }) => void,
  options: { onDisconnect?: () => void; log?: (message: string) => void } = {},
): () => void {
  // Reconnects by graphId with exponential backoff so a mid-run stream break
  // doesn't leave the run frozen; surfaces a disconnect after retries are
  // exhausted instead of silently swallowing the error.
  return sseStream(`/api/execution-graphs/${graphId}/events/stream`, {
    log: options.log,
    maxRetries: 8,
    onEvent: ({ type, data }) => {
      if (!type) return;
      try {
        onEvent({ type, ...(JSON.parse(data) as object) });
      } catch {
        // ignore malformed frame
      }
    },
    onError: ({ gaveUp }) => {
      if (gaveUp) options.onDisconnect?.();
    },
  });
}

export async function cancelExecutionGraph(graphId: string): Promise<void> {
  await apiFetch(`/api/execution-graphs/${graphId}/cancel`, { method: "POST" });
}

export interface GraphNodeSummary {
  id: string;
  type: string;
  title: string;
  status: string;
  inputSummary?: string;
  error?: string;
}

export interface GraphApprovalSummary {
  id: string;
  action: string;
  reason: string;
  details?: string;
  risk: string;
  status: string;
}

/** Fetch graph detail (nodes + agent-run approvals) — used to resolve approval prompts. */
export async function fetchGraphDetail(
  graphId: string,
): Promise<{ nodes: GraphNodeSummary[]; approvals: GraphApprovalSummary[] }> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/detail`);
  if (!res.ok) throw new Error(`Failed to load graph detail: ${res.status} ${res.statusText}`);
  const detail = (await res.json()) as { nodes?: GraphNodeSummary[]; approvals?: GraphApprovalSummary[] };
  return { nodes: detail.nodes ?? [], approvals: detail.approvals ?? [] };
}

/** Approve/reject a graph-native APPROVAL node (e.g. the swarm blocker gate). */
export async function resolveNodeApproval(
  graphId: string,
  nodeId: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<void> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/nodes/${encodeURIComponent(nodeId)}/approval`, {
    method: "POST",
    body: JSON.stringify({ decision, note }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Approval failed: ${res.status}`);
  }
}

export interface WorkingMemorySnapshot {
  executionGraphId: string;
  activeGoal: string;
  activeFiles: string[];
  activeTasks: string[];
  blockers: string[];
  assumptions: string[];
  nextActions: string[];
  currentPlan?: string;
  verificationHistory: Array<{ nodeTitle?: string; passed?: boolean } & Record<string, unknown>>;
  recentFailures: Array<{ nodeTitle?: string; error?: string } & Record<string, unknown>>;
  updatedAt: string;
}

/** Read a run's working memory (accumulated agent context). 404 → null. */
export async function getWorkingMemory(graphId: string): Promise<WorkingMemorySnapshot | null> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/working-memory`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Failed to load working memory: ${res.status}`);
  }
  return (await res.json()) as WorkingMemorySnapshot;
}

/** Merge a partial patch into a run's working memory (e.g. append assumptions). */
export async function patchWorkingMemory(
  graphId: string,
  patch: Partial<WorkingMemorySnapshot>,
): Promise<void> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/working-memory`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Failed to update working memory: ${res.status}`);
  }
}

/** Add a follow-up goal node to a run. */
export async function addFollowUp(graphId: string, additionalGoal: string): Promise<void> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/follow-up`, {
    method: "POST",
    body: JSON.stringify({ additionalGoal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Follow-up failed: ${res.status}`);
  }
}

export interface GraphMetrics {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  callCount: number;
  perNode: Array<{ nodeId: string; title: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number }>;
}

/** Aggregated token/cost usage for a run. 404 → null. */
export async function getGraphMetrics(graphId: string): Promise<GraphMetrics | null> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/metrics`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Failed to load metrics: ${res.status}`);
  }
  return (await res.json()) as GraphMetrics;
}

export interface GraphArtifact {
  id: string;
  path: string;
  title: string;
  kind: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
}

/** List artifacts produced by a run's nodes (content included inline). */
export async function listGraphArtifacts(graphId: string): Promise<GraphArtifact[]> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/artifacts`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Failed to list artifacts: ${res.status}`);
  }
  return (await res.json()) as GraphArtifact[];
}

/** Retry a failed/cancelled run (re-queues failed/cancelled nodes). */
export async function retryGraph(graphId: string): Promise<void> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/retry`, { method: "POST" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Retry failed: ${res.status}`);
  }
}

/** Replay a node and its downstream dependents; returns the number of nodes re-queued. */
export async function replayFromNode(graphId: string, nodeId: string, reason?: string): Promise<number> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/replay-from/${encodeURIComponent(nodeId)}`, {
    method: "POST",
    body: JSON.stringify({ reason: reason ?? "manual_replay" }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Replay failed: ${res.status}`);
  }
  const out = (await res.json()) as { replayed?: number };
  return out.replayed ?? 0;
}

/** Resolve an agent-run approval record (PATCH) — for operational tool approvals. */
export async function resolveGraphApproval(
  graphId: string,
  approvalId: string,
  status: "approved" | "rejected",
  response?: string,
): Promise<void> {
  const res = await apiFetch(`/api/execution-graphs/${graphId}/approvals/${encodeURIComponent(approvalId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status, response }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Approval failed: ${res.status}`);
  }
}
