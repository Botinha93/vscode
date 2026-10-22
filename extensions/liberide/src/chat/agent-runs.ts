/**
 * Agent runs shown in the chat: the server's run records, the anchor
 * messages it posts for them, and the live `/agents/stream` events, folded
 * into one view model per run. Pure and vscode-free (the webview, the host
 * and the tests all import it). Wire contract: packages/shared/src/agent-stream.ts.
 */

import { AGENT_RUN_CARD_KIND, isTerminalAgentRunStatus, type AgentRunCardMetadata } from "@nexus/shared";

export interface AgentRunToolCallView {
  id: string;
  name: string;
  status: "running" | "complete" | "error";
  /** One-line summary of the call (path, command, query…). */
  summary?: string;
  result?: string;
}

export interface AgentRunView {
  runId: string;
  status: string;
  /** Streamed output so far (the final output once the run finished). */
  text: string;
  toolCalls: AgentRunToolCallView[];
  graphId?: string;
  /** Graph node the run executes (server node id). */
  nodeId?: string;
  parentRunId?: string;
  /** The chat message the run belongs to (its anchor card, or the turn that started it). */
  messageId?: string;
  agentName?: string;
  /** Full error of a failed run. */
  error?: string;
}

export type AgentStreamEvent =
  | { type: "snapshot"; runs: AgentRunView[] }
  | { type: "delta"; runId: string; text: string }
  | { type: "tool"; runId: string; call: AgentRunToolCallView }
  | { type: "status"; runId: string; status: string; error?: string; graphId?: string; nodeId?: string; parentRunId?: string };

/** True while the run can still produce output (anything but completed / failed / cancelled). */
export function isActiveAgentRunStatus(status: string | undefined): boolean {
  return Boolean(status) && !isTerminalAgentRunStatus(status);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolSummary(name: string, args: Record<string, unknown>): string | undefined {
  for (const key of ["path", "command", "query", "url", "pattern"]) {
    const value = str(args[key]);
    if (value) return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return name === "agent" ? str(args.agentId) ?? str(args.agent) : undefined;
}

function looksLikeError(result: string): boolean {
  const trimmed = result.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; success?: unknown };
      if (parsed.error === true || typeof parsed.error === "string" || parsed.success === false) return true;
    } catch {
      // not json
    }
  }
  return /^(error|failed|denied)\b/i.test(trimmed);
}

/** A tool call from a snapshot, a `tool` event or `/tool-calls` (ToolCallEvent-like shapes). */
export function toolCallFrom(raw: unknown): AgentRunToolCallView | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const id = str(value.id) ?? str(value.callId) ?? str(value.toolCallId);
  const name = str(value.name) ?? str(value.toolName) ?? str(value.tool);
  if (!id || !name) return undefined;
  const args = record(value.arguments) ?? record(value.args) ?? record(value.input) ?? {};
  const result = typeof value.result === "string" ? value.result
    : value.result !== undefined && value.result !== null ? JSON.stringify(value.result)
    : typeof value.output === "string" ? value.output
    : undefined;
  const error = str(value.error);
  const declared = str(value.status);
  const status: AgentRunToolCallView["status"] = error || declared === "error" || declared === "failed"
    ? "error"
    : declared === "running" || declared === "pending" || declared === "started"
      ? "running"
      : result !== undefined
        ? (looksLikeError(result) ? "error" : "complete")
        : declared === "completed" || declared === "complete" ? "complete" : "running";
  return {
    id,
    name,
    status,
    summary: toolSummary(name, args),
    ...(error ? { result: error } : result !== undefined ? { result: result.slice(0, 2000) } : {}),
  };
}

/**
 * A run from the snapshot / `GET /api/conversations/:id/agent-runs` /
 * agent_run_updated payloads (`runId` or `id`; output in `text` or `output`).
 */
export function agentRunFrom(raw: unknown): AgentRunView | undefined {
  const value = record(raw);
  if (!value) return undefined;
  const runId = str(value.runId) ?? str(value.id) ?? str(value.agentRunId);
  if (!runId) return undefined;
  const toolCalls = Array.isArray(value.toolCalls) ? value.toolCalls.map(toolCallFrom).filter((c): c is AgentRunToolCallView => Boolean(c)) : [];
  return {
    runId,
    status: str(value.status) ?? "running",
    text: typeof value.text === "string" ? value.text : typeof value.output === "string" ? value.output : typeof value.excerpt === "string" ? value.excerpt : "",
    toolCalls,
    ...(str(value.graphId) ?? str(value.executionGraphId) ? { graphId: str(value.graphId) ?? str(value.executionGraphId) } : {}),
    ...(str(value.nodeId) ? { nodeId: str(value.nodeId) } : {}),
    ...(str(value.parentRunId) ? { parentRunId: str(value.parentRunId) } : {}),
    ...(str(value.messageId) ? { messageId: str(value.messageId) } : {}),
    ...(str(value.agentName) ? { agentName: str(value.agentName) } : {}),
    ...(str(value.error) ? { error: str(value.error) } : {}),
  };
}

/** Parse one frame of `GET /api/conversations/:id/agents/stream`. */
export function parseAgentStreamEvent(event: string, data: unknown): AgentStreamEvent | undefined {
  const value = record(data);
  if (!value) return undefined;
  const type = event === "message" ? str(value.type) ?? event : event;
  switch (type) {
    case "snapshot": {
      const runs = Array.isArray(value.runs) ? value.runs.map(agentRunFrom).filter((r): r is AgentRunView => Boolean(r)) : [];
      return { type: "snapshot", runs };
    }
    case "delta": {
      const runId = str(value.runId);
      if (!runId || typeof value.text !== "string") return undefined;
      return { type: "delta", runId, text: value.text };
    }
    case "tool": {
      const runId = str(value.runId);
      const call = toolCallFrom(value.event ?? value.call);
      if (!runId || !call) return undefined;
      return { type: "tool", runId, call };
    }
    case "status": {
      const runId = str(value.runId);
      const status = str(value.status);
      if (!runId || !status) return undefined;
      return {
        type: "status",
        runId,
        status,
        ...(str(value.error) ? { error: str(value.error) } : {}),
        ...(str(value.graphId) ? { graphId: str(value.graphId) } : {}),
        ...(str(value.nodeId) ? { nodeId: str(value.nodeId) } : {}),
        ...(str(value.parentRunId) ? { parentRunId: str(value.parentRunId) } : {}),
      };
    }
    default:
      return undefined;
  }
}

/** Merge newer facts about a run into what is known; empty values never erase known ones. */
export function mergeAgentRun(existing: AgentRunView | undefined, next: AgentRunView): AgentRunView {
  if (!existing) return { ...next, toolCalls: [...next.toolCalls] };
  const toolCalls = [...existing.toolCalls];
  for (const call of next.toolCalls) upsertToolCall(toolCalls, call);
  return {
    runId: existing.runId,
    status: next.status || existing.status,
    // Anchor excerpts are shorter than the streamed text: keep the longer one.
    text: next.text && next.text.length >= existing.text.length ? next.text : existing.text || next.text,
    toolCalls,
    graphId: next.graphId ?? existing.graphId,
    nodeId: next.nodeId ?? existing.nodeId,
    parentRunId: next.parentRunId ?? existing.parentRunId,
    messageId: existing.messageId ?? next.messageId,
    agentName: next.agentName ?? existing.agentName,
    error: next.error ?? (isActiveAgentRunStatus(next.status) ? undefined : existing.error),
  };
}

function upsertToolCall(list: AgentRunToolCallView[], call: AgentRunToolCallView): void {
  const index = list.findIndex((c) => c.id === call.id);
  if (index >= 0) list[index] = { ...list[index], ...call, summary: call.summary ?? list[index].summary };
  else list.push(call);
}

/**
 * Fold a stream event into `runs` (keyed by run id). Returns the ids of the
 * runs that changed.
 */
export function applyAgentStreamEvent(runs: Map<string, AgentRunView>, event: AgentStreamEvent): string[] {
  const ensure = (runId: string): AgentRunView => {
    let run = runs.get(runId);
    if (!run) {
      run = { runId, status: "running", text: "", toolCalls: [] };
      runs.set(runId, run);
    }
    return run;
  };
  switch (event.type) {
    case "snapshot": {
      for (const run of event.runs) {
        const existing = runs.get(run.runId);
        // The snapshot is the server's full state: its text replaces ours.
        const merged = mergeAgentRun(existing, run);
        merged.text = run.text || existing?.text || "";
        runs.set(run.runId, merged);
      }
      return event.runs.map((run) => run.runId);
    }
    case "delta": {
      const run = ensure(event.runId);
      run.text += event.text;
      if (!isActiveAgentRunStatus(run.status)) run.status = "running";
      return [event.runId];
    }
    case "tool": {
      const run = ensure(event.runId);
      upsertToolCall(run.toolCalls, event.call);
      return [event.runId];
    }
    case "status": {
      const run = ensure(event.runId);
      run.status = event.status;
      if (event.graphId) run.graphId = event.graphId;
      if (event.nodeId) run.nodeId = event.nodeId;
      if (event.parentRunId) run.parentRunId = event.parentRunId;
      if (event.error) run.error = event.error;
      else if (isActiveAgentRunStatus(event.status)) run.error = undefined;
      return [event.runId];
    }
  }
}

/** A message as far as run cards are concerned. */
export interface AgentRunAnchorSource {
  id: string;
  content?: string;
  /** The card's metadata (`Message.agentRun`). */
  agentRun?: AgentRunCardMetadata;
}

/**
 * The run a card message stands for: assistant messages the server posts
 * per run, with `agentRun` (`metadata.kind = "agent_run"`). Undefined for
 * other messages.
 */
export function agentRunFromAnchor(message: AgentRunAnchorSource): AgentRunView | undefined {
  const card = message.agentRun ?? (record((message as { metadata?: unknown }).metadata) as AgentRunCardMetadata | undefined);
  if (!card || card.kind !== AGENT_RUN_CARD_KIND || !card.agentRunId) return undefined;
  return {
    runId: card.agentRunId,
    status: card.status || "running",
    text: card.outputExcerpt ?? message.content ?? "",
    toolCalls: [],
    messageId: message.id,
    ...(card.graphId ? { graphId: card.graphId } : {}),
    ...(card.nodeId ? { nodeId: card.nodeId } : {}),
    ...(card.parentRunId ? { parentRunId: card.parentRunId } : {}),
    ...(card.agentName ? { agentName: card.agentName } : {}),
    ...(card.error ? { error: card.error } : {}),
  };
}

export interface AgentRunLayoutMessage {
  id: string;
  /** Set on agent-run anchor cards. */
  agentRunId?: string;
  /** Set on messages that render a graph card. */
  graphId?: string;
}

export interface AgentRunLayout {
  /** Anchor cards drawn inside another card instead of as their own bubble. */
  hiddenMessageIds: Set<string>;
  /** Top-level run cards per message. */
  rootsByMessage: Map<string, string[]>;
  /** Runs executing a graph node: graphId → nodeId → run ids. */
  nodeRuns: Map<string, Map<string, string[]>>;
  /** Sub-agent runs per parent run. */
  childrenByRun: Map<string, string[]>;
  /** Runs with nowhere to go: drawn after the transcript. */
  orphans: string[];
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Where each run is drawn: under its parent run, in its graph's card (by
 * node), on its own anchor card, on the message that started it, or after
 * the transcript. Anchor cards placed elsewhere are hidden.
 */
export function layoutAgentRuns(messages: AgentRunLayoutMessage[], runs: AgentRunView[]): AgentRunLayout {
  const byId = new Map(runs.map((run) => [run.runId, run] as const));
  const messageIds = new Set(messages.map((m) => m.id));
  const graphMessage = new Map<string, string>();
  const anchorMessage = new Map<string, string>();
  for (const m of messages) {
    if (m.graphId && !graphMessage.has(m.graphId)) graphMessage.set(m.graphId, m.id);
    if (m.agentRunId) anchorMessage.set(m.agentRunId, m.id);
  }
  const hasLiveParent = (run: AgentRunView): boolean => {
    // Walk up to make sure the chain ends (a cycle would hide every run in it).
    const seen = new Set<string>([run.runId]);
    let parentId = run.parentRunId;
    while (parentId) {
      if (seen.has(parentId)) return false;
      const parent = byId.get(parentId);
      if (!parent) return false;
      seen.add(parentId);
      parentId = parent.parentRunId;
    }
    return Boolean(run.parentRunId);
  };

  const layout: AgentRunLayout = {
    hiddenMessageIds: new Set(),
    rootsByMessage: new Map(),
    nodeRuns: new Map(),
    childrenByRun: new Map(),
    orphans: [],
  };
  for (const run of runs) {
    const anchor = anchorMessage.get(run.runId);
    if (run.parentRunId && hasLiveParent(run)) {
      push(layout.childrenByRun, run.parentRunId, run.runId);
    } else if (run.graphId && graphMessage.has(run.graphId) && graphMessage.get(run.graphId) !== anchor) {
      if (run.nodeId) {
        let nodes = layout.nodeRuns.get(run.graphId);
        if (!nodes) {
          nodes = new Map();
          layout.nodeRuns.set(run.graphId, nodes);
        }
        push(nodes, run.nodeId, run.runId);
      } else {
        push(layout.rootsByMessage, graphMessage.get(run.graphId)!, run.runId);
      }
    } else if (anchor) {
      push(layout.rootsByMessage, anchor, run.runId);
      continue;
    } else if (run.messageId && messageIds.has(run.messageId)) {
      push(layout.rootsByMessage, run.messageId, run.runId);
    } else {
      layout.orphans.push(run.runId);
    }
    if (anchor) layout.hiddenMessageIds.add(anchor);
  }
  return layout;
}
