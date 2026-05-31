import { apiFetch } from "../api";
import type { ChatRequest, ChatResponse, TerminalDelegateEvent, ToolCallEvent } from "./types";

export async function streamChat(
  body: ChatRequest,
  handlers: {
    onToken?: (token: string) => void;
    onToolEvent?: (event: ToolCallEvent) => void;
    onMarkdown?: (content: string) => void;
    onDiff?: (payload: Record<string, unknown>) => void;
    onPlan?: (payload: Record<string, unknown>) => void;
    onTodo?: (payload: Record<string, unknown>) => void;
    onFollowUp?: (payload: Record<string, unknown>) => void;
    onTerminalDelegate?: (payload: TerminalDelegateEvent) => void | Promise<void>;
  },
  signal?: AbortSignal,
): Promise<ChatResponse> {
  const response = await apiFetch("/api/chat/stream", {
    method: "POST",
    headers: {
      "X-Terminal-Executor": body.ideContext?.terminalExecutor === "client" ? "client" : "server",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const err = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(err.error ?? response.statusText);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse: ChatResponse | undefined;

  const consume = (rawEvent: string) => {
    const event = rawEvent.match(/^event: (.+)$/m)?.[1];
    const dataLine = rawEvent.match(/^data: (.+)$/m)?.[1];
    if (!event || !dataLine) return;
    let data: unknown;
    try {
      data = JSON.parse(dataLine);
    } catch {
      // Malformed SSE chunk (debug log, partial flush, error page). Skip it
      // rather than letting a SyntaxError unwind the whole stream loop.
      console.warn("[stream-client] could not parse SSE chunk:", dataLine.slice(0, 200));
      return;
    }
    if (event === "token") handlers.onToken?.((data as { token: string }).token);
    if (event === "tool") handlers.onToolEvent?.(data as ToolCallEvent);
    if (event === "terminal_delegate") {
      void handlers.onTerminalDelegate?.(data as TerminalDelegateEvent);
    }
    if (event === "markdown") handlers.onMarkdown?.((data as { content: string }).content);
    if (event === "diff") handlers.onDiff?.(data as Record<string, unknown>);
    if (event === "plan") handlers.onPlan?.(data as Record<string, unknown>);
    if (event === "todo") handlers.onTodo?.(data as Record<string, unknown>);
    if (event === "follow_up") handlers.onFollowUp?.(data as Record<string, unknown>);
    if (event === "error") throw new Error((data as { error: string }).error);
    if (event === "done") finalResponse = data as ChatResponse;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) consume(part);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
  } finally {
    // Always release the reader so the underlying fetch connection is closed,
    // even if the loop exits due to an exception.
    reader.cancel().catch(() => undefined);
  }
  if (!finalResponse) throw new Error("Stream ended before the chat response completed.");
  return finalResponse;
}
