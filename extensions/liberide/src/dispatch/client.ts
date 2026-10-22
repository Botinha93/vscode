import { apiFetch, getApiOrigin } from "../api";
import { backoffDelay, readSseStream } from "../sse";
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

export async function dispatchFeature(feature: FeatureSpec, options: { conversationId?: string; taskIds?: string[]; ideContext?: Record<string, unknown>; swarm?: boolean; isolation?: "worktree" | "shared" } = {}): Promise<SpecDispatchResult> {
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
    options.onError?.(message, false);
    stop();
  };

  const scheduleReconnect = (reason: string) => {
    if (closed || retryTimer) return;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      fail(`Lost the graph event stream: ${reason}`);
      return;
    }
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
