import { apiFetch, getApiOrigin } from "../api";
import { backoffDelay, readSseStream } from "../sse";
import type { FeatureSpec, TaskContract } from "../spec/schema";
import type { IdeToolContextPayload } from "../chat/types";
import type { ApprovalMode } from "@nexus/shared";
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

export async function dispatchFeature(feature: FeatureSpec, options: { conversationId?: string; taskIds?: string[]; ideContext?: IdeToolContextPayload; swarm?: boolean; isolation?: "worktree" | "shared"; approvalMode?: ApprovalMode } = {}): Promise<SpecDispatchResult> {
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
      // The dispatching chat's approval mode: graph nodes ask (or not) like the chat.
      ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
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

const TERMINAL_GRAPH_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalGraphStatus(status: string | undefined): boolean {
  return Boolean(status && TERMINAL_GRAPH_STATUSES.has(status));
}

export interface ExecutionGraphEvent {
  /** `init` | `node_status` | `graph_status` | `event` | `done` (plus any server extras). */
  type: string;
  nodeId?: string;
  status?: string;
  title?: string;
  [key: string]: unknown;
}

/**
 * The task a node_status event is about. Server node ids are prefixed with
 * the graph id (`<graphId>_T-1`); the task id travels as `templateNodeId`.
 */
export function taskIdFromNodeEvent(event: ExecutionGraphEvent, graphId: string): string | undefined {
  if (typeof event.templateNodeId === "string" && event.templateNodeId) return event.templateNodeId;
  if (!event.nodeId) return undefined;
  const prefix = `${graphId}_`;
  return event.nodeId.startsWith(prefix) ? event.nodeId.slice(prefix.length) : event.nodeId;
}

/** Why a failed node failed, when the server sent it. */
export function nodeEventError(event: ExecutionGraphEvent): string | undefined {
  return event.status === "failed" && typeof event.error === "string" && event.error.trim() ? event.error.trim() : undefined;
}

export interface TaskStatusUpdate {
  taskId: string;
  status: string;
  error?: string;
}

/**
 * The task status an event reports, if any:
 * - `task_status`: swarm graphs, where a task runs as several nodes
 *   (implement, verify, repairs…) and the server folds them into one status;
 * - `node_status` for a task's own node (one node per task). Swarm nodes
 *   carry a `taskId` and are skipped: their task's `task_status` covers them.
 */
export function taskStatusFromEvent(event: ExecutionGraphEvent, graphId: string): TaskStatusUpdate | undefined {
  if (!event.status) return undefined;
  if (event.type === "task_status") {
    if (typeof event.taskId !== "string" || !event.taskId) return undefined;
    return { taskId: event.taskId, status: event.status, ...(nodeEventError(event) ? { error: nodeEventError(event)! } : {}) };
  }
  if (event.type !== "node_status" || typeof event.taskId === "string") return undefined;
  const taskId = taskIdFromNodeEvent(event, graphId);
  if (!taskId) return undefined;
  return { taskId, status: event.status, ...(nodeEventError(event) ? { error: nodeEventError(event)! } : {}) };
}

export interface GraphSubscriptionOptions {
  /** Connection problems. `willRetry` is false when the subscription gave up. */
  onError?: (message: string, willRetry: boolean) => void;
  /** Fired when a (re)connection succeeds. */
  onConnected?: () => void;
  /** Fired once when the subscription gives up (retries exhausted, 401/403/404). */
  onDisconnect?: () => void;
  /** Optional logger for connection diagnostics. */
  log?: (message: string) => void;
}

/** Backup poll of the graph row, since the event stream may go quiet. */
const GRAPH_POLL_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 8;

/**
 * Follow an execution graph's events. Checks the response status, reconnects
 * with backoff when the stream drops before the graph finished, polls the
 * graph row as a backup, and emits exactly one `done` when it reaches a
 * terminal status. Returns a disposer.
 */
export function subscribeExecutionGraphEvents(
  graphId: string,
  onEvent: (event: ExecutionGraphEvent) => void,
  options: GraphSubscriptionOptions = {},
): () => void {
  let closed = false;
  let finished = false;
  let attempt = 0;
  let abort: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const stop = () => {
    closed = true;
    abort?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    if (pollTimer) clearInterval(pollTimer);
    retryTimer = null;
    pollTimer = null;
  };

  const finish = (status: string | undefined) => {
    if (finished || closed) return;
    finished = true;
    stop();
    onEvent({ type: "done", status });
  };

  const emit = (event: ExecutionGraphEvent) => {
    if (closed) return;
    if (event.type === "done") {
      finish(event.status);
      return;
    }
    onEvent(event);
    if ((event.type === "graph_status" || event.type === "init") && isTerminalGraphStatus(event.status)) finish(event.status);
  };

  const fail = (message: string) => {
    if (closed) return;
    options.log?.(`graph ${graphId}: ${message}`);
    options.onError?.(message, false);
    options.onDisconnect?.();
    stop();
  };

  const scheduleReconnect = (reason: string) => {
    if (closed || retryTimer) return;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      fail(`Lost the graph event stream: ${reason}`);
      return;
    }
    options.log?.(`graph ${graphId}: reconnecting (${reason})`);
    options.onError?.(reason, true);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, backoffDelay(attempt++, 1_000, 30_000));
  };

  const poll = async () => {
    if (closed) return;
    try {
      const res = await apiFetch(`/api/execution-graphs/${encodeURIComponent(graphId)}`);
      if (res.status === 404) {
        fail("Execution graph not found.");
        return;
      }
      if (!res.ok) return;
      const graph = (await res.json()) as { status?: string };
      if (graph.status) emit({ type: "graph_status", status: graph.status });
    } catch {
      // transient; the stream or the next poll will catch up
    }
  };

  const connect = async () => {
    if (closed) return;
    const origin = getApiOrigin();
    if (!origin) {
      fail("LIBERIDE_API_ORIGIN is not set.");
      return;
    }
    abort = new AbortController();
    try {
      const response = await apiFetch(`/api/execution-graphs/${encodeURIComponent(graphId)}/events/stream`, {
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (response.status === 404) {
        response.body?.cancel().catch(() => undefined);
        fail("Execution graph not found.");
        return;
      }
      if (response.status === 401 || response.status === 403) {
        response.body?.cancel().catch(() => undefined);
        fail(response.status === 401 ? "Not signed in (401) — cannot follow the graph." : "Not allowed to view this graph.");
        return;
      }
      if (!response.ok || !response.body) {
        response.body?.cancel().catch(() => undefined);
        scheduleReconnect(`HTTP ${response.status}`);
        return;
      }
      attempt = 0;
      options.onConnected?.();
      await readSseStream(response.body, ({ event, data }) => {
        const payload = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
        if (event === "init") {
          emit({ ...payload, type: "init", status: typeof payload.graphStatus === "string" ? payload.graphStatus : undefined });
          return;
        }
        if (event === "connected" || event === "stream_closed") return;
        emit({ ...payload, type: event } as ExecutionGraphEvent);
      }, { idleTimeoutMs: 90_000 });
      if (!closed) scheduleReconnect("stream ended before the graph finished");
    } catch (err) {
      if (closed) return;
      scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  };

  pollTimer = setInterval(() => void poll(), GRAPH_POLL_MS);
  void connect();
  return stop;
}

export async function cancelExecutionGraph(graphId: string): Promise<void> {
  const response = await apiFetch(`/api/execution-graphs/${encodeURIComponent(graphId)}/cancel`, { method: "POST" });
  // 404 means "not found or already terminal" — nothing left to cancel.
  if (!response.ok && response.status !== 404) {
    const err = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(err.error ?? response.statusText);
  }
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
