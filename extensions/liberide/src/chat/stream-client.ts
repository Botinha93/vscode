import { apiFetch } from "../api";
import { readSseStream } from "../sse";
import type {
  AgentApprovalRequest,
  ChatRequest,
  ChatResponse,
  FallbackRequiredResolution,
  RoutingUnsatisfiedResolution,
  TerminalDelegateEvent,
  ToolCallEvent,
} from "./types";

/** What a running turn streamed before a client (re-)attached. */
export interface TurnSnapshot {
  conversationId?: string;
  content: string;
  thinking: string;
  toolEvents: ToolCallEvent[];
  todos?: unknown[];
  startedAt: string;
}

export interface ChatStreamHandlers {
  /** Sent first on a re-attach: everything streamed so far. */
  onSnapshot?: (snapshot: TurnSnapshot) => void;
  /** The turn's server conversation id, sent early (drafts learn it before `done`). */
  onConversation?: (conversationId: string) => void;
  onToken?: (token: string) => void;
  onToolEvent?: (event: ToolCallEvent) => void;
  /** Full final markdown for the turn (replaces what was streamed as tokens). */
  onMarkdown?: (content: string) => void;
  /** Reasoning delta. */
  onThinking?: (content: string) => void;
  onDiff?: (payload: Record<string, unknown>) => void;
  onPlan?: (payload: Record<string, unknown>) => void;
  onTodo?: (payload: Record<string, unknown>) => void;
  onFollowUp?: (payload: Record<string, unknown>) => void;
  onReference?: (payload: Record<string, unknown>) => void;
  onCitation?: (payload: Record<string, unknown>) => void;
  onFallbackRequired?: (resolution: FallbackRequiredResolution) => void;
  onRoutingUnsatisfied?: (resolution: RoutingUnsatisfiedResolution) => void;
  onTerminalDelegate?: (payload: TerminalDelegateEvent) => void | Promise<void>;
}

export type ChatStreamErrorKind =
  | "busy"
  | "cancelled"
  | "fallback_required"
  | "routing_unsatisfied"
  | "forbidden"
  | "unauthorized"
  | "server";

/** A failed chat stream, typed so the panel can render the right notice. */
export class ChatStreamError extends Error {
  constructor(
    message: string,
    readonly kind: ChatStreamErrorKind,
    readonly details: {
      status?: number;
      fallback?: FallbackRequiredResolution;
      routing?: RoutingUnsatisfiedResolution;
    } = {},
  ) {
    super(message);
    this.name = "ChatStreamError";
  }
}

export const BUSY_MESSAGE = "A reply is still being generated in this conversation. Wait for it to finish or stop it first.";

/** Silence longer than this (the server heartbeats every 15s) means a dead stream. */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

async function errorFromResponse(response: Response): Promise<ChatStreamError> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; busy?: boolean };
  const message = body.error || response.statusText || `HTTP ${response.status}`;
  if (response.status === 409 || body.busy) return new ChatStreamError(BUSY_MESSAGE, "busy", { status: response.status });
  if (response.status === 401) {
    return new ChatStreamError("Not signed in to LiberIDE (401). Reopen the project from the LiberIDE desktop app.", "unauthorized", { status: 401 });
  }
  if (response.status === 403) return new ChatStreamError(message === "forbidden" ? "You are not allowed to do that." : message, "forbidden", { status: 403 });
  return new ChatStreamError(message, "server", { status: response.status });
}

/**
 * POST to a chat-shaped SSE endpoint and dispatch every event. Resolves with
 * the `done` payload; rejects with a {@link ChatStreamError}.
 */
async function streamChatEndpoint(
  path: string,
  body: unknown,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<ChatResponse> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { Accept: "text/event-stream", ...(headers ?? {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) throw await errorFromResponse(response);
  return consumeChatStream(response.body, handlers);
}

/** Dispatch a chat-shaped SSE body; resolves with the `done` payload. */
async function consumeChatStream(body: ReadableStream<Uint8Array>, handlers: ChatStreamHandlers): Promise<ChatResponse> {
  let finalResponse: ChatResponse | undefined;
  let fallback: FallbackRequiredResolution | undefined;
  let routing: RoutingUnsatisfiedResolution | undefined;

  await readSseStream(body, ({ event, data }) => {
    switch (event) {
      case "snapshot":
        handlers.onSnapshot?.(data as TurnSnapshot);
        break;
      case "conversation":
        handlers.onConversation?.((data as { conversationId: string }).conversationId);
        break;
      case "token":
        handlers.onToken?.((data as { token: string }).token);
        break;
      case "tool":
        handlers.onToolEvent?.(data as ToolCallEvent);
        break;
      case "terminal_delegate":
        void handlers.onTerminalDelegate?.(data as TerminalDelegateEvent);
        break;
      case "markdown":
        handlers.onMarkdown?.((data as { content: string }).content);
        break;
      case "thinking":
        handlers.onThinking?.((data as { content: string }).content);
        break;
      case "diff":
        handlers.onDiff?.(data as Record<string, unknown>);
        break;
      case "plan":
        handlers.onPlan?.(data as Record<string, unknown>);
        break;
      case "todo":
        handlers.onTodo?.(data as Record<string, unknown>);
        break;
      case "follow_up":
        handlers.onFollowUp?.(data as Record<string, unknown>);
        break;
      case "reference":
        handlers.onReference?.(data as Record<string, unknown>);
        break;
      case "citation":
        handlers.onCitation?.(data as Record<string, unknown>);
        break;
      case "fallback_required":
        fallback = data as FallbackRequiredResolution;
        handlers.onFallbackRequired?.(fallback);
        break;
      case "routing_unsatisfied":
        routing = data as RoutingUnsatisfiedResolution;
        handlers.onRoutingUnsatisfied?.(routing);
        break;
      case "error": {
        const payload = data as { error?: string; cancelled?: boolean; busy?: boolean };
        if (payload.cancelled) throw new ChatStreamError("Cancelled.", "cancelled");
        if (payload.busy) throw new ChatStreamError(BUSY_MESSAGE, "busy");
        throw new ChatStreamError(payload.error || "The server reported an error.", "server");
      }
      case "done":
        finalResponse = data as ChatResponse;
        break;
    }
  }, { idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS });

  if (finalResponse) return finalResponse;
  if (fallback) {
    throw new ChatStreamError(fallback.reason || "The selected model cannot handle this request.", "fallback_required", { fallback });
  }
  if (routing) {
    throw new ChatStreamError(
      routing.reason || "No configured model can handle this request. Check Settings → Providers.",
      "routing_unsatisfied",
      { routing },
    );
  }
  throw new ChatStreamError("Stream ended before the chat response completed.", "server");
}

export function streamChat(body: ChatRequest, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<ChatResponse> {
  return streamChatEndpoint("/api/chat/stream", body, handlers, signal, {
    "X-Terminal-Executor": body.ideContext?.terminalExecutor === "client" ? "client" : "server",
  });
}

/**
 * Open the stream of the conversation's running turn (started here or on
 * another surface). Undefined when none is running: the messages are current.
 * The returned function reads it to the end like any chat stream.
 */
export async function openTurnStream(
  conversationId: string,
  signal?: AbortSignal,
): Promise<((handlers: ChatStreamHandlers) => Promise<ChatResponse>) | undefined> {
  const response = await apiFetch(`/api/conversations/${encodeURIComponent(conversationId)}/turn/stream`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (response.status === 204 || !response.body) {
    response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.ok) throw await errorFromResponse(response);
  const body = response.body;
  return (handlers) => consumeChatStream(body, handlers);
}

/**
 * `done` payload of resume/stream when the approval belonged to a paused
 * sub-agent: the run continues server-side and its result is posted to the
 * conversation later (signalled by a `message_updated` conversation event).
 */
export interface AgentRunResumed {
  agentRunResumed: string;
}

export function isAgentRunResumed(value: ChatResponse | AgentRunResumed): value is AgentRunResumed {
  return typeof (value as AgentRunResumed).agentRunResumed === "string";
}

/** Continue a turn that paused on an approval, after it was approved or rejected. */
export function streamApprovalResume(
  approvalId: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<ChatResponse | AgentRunResumed> {
  return streamChatEndpoint(`/api/approvals/${encodeURIComponent(approvalId)}/resume/stream`, {}, handlers, signal) as Promise<ChatResponse | AgentRunResumed>;
}

/** Approve or reject a pending approval (the caller then streams the continuation). */
export async function resolveApproval(
  approvalId: string,
  status: "approved" | "rejected",
  response?: string,
): Promise<AgentApprovalRequest> {
  const res = await apiFetch(`/api/approvals/${encodeURIComponent(approvalId)}`, {
    method: "PATCH",
    // "client": we stream the continuation ourselves via resume/stream, so the
    // server must not also resume the paused turn in the background.
    body: JSON.stringify({ status, ...(response ? { response } : {}), resumeMode: "client" }),
  });
  if (!res.ok) {
    const err = await errorFromResponse(res);
    if (res.status === 403) throw new ChatStreamError("You are not allowed to act on this approval.", "forbidden", { status: 403 });
    if (res.status === 404) throw new ChatStreamError("This approval is no longer pending (it may have been resolved elsewhere).", "server", { status: 404 });
    throw err;
  }
  return (await res.json()) as AgentApprovalRequest;
}

export async function listConversationApprovals(conversationId: string): Promise<AgentApprovalRequest[]> {
  const res = await apiFetch(`/api/conversations/${encodeURIComponent(conversationId)}/approvals`);
  if (!res.ok) throw await errorFromResponse(res);
  return (await res.json()) as AgentApprovalRequest[];
}
