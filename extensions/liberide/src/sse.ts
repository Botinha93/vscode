/**
 * Minimal server-sent-events reader shared by the chat, graph and
 * conversation-list streams.
 *
 * Handles both `event: <name>\ndata: <json>` frames and data-only frames
 * (`data: {"type": ...}`), multi-line `data:` fields, comment heartbeats and
 * an idle timeout so a silently stalled connection surfaces as an error.
 */

export interface SseEvent {
  /** Value of the `event:` field, or `data.type` for data-only frames, or "message". */
  event: string;
  data: unknown;
}

export class SseIdleTimeoutError extends Error {
  constructor(ms: number) {
    super(`Stream idle for ${Math.round(ms / 1000)}s — the server may be stuck.`);
    this.name = "SseIdleTimeoutError";
  }
}

const MAX_BUFFER_CHARS = 4_000_000;

function parseFrame(raw: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  const text = dataLines.join("\n");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Malformed chunk (debug log, partial flush, HTML error page): skip it
    // rather than unwinding the whole stream.
    console.warn("[liberide.sse] could not parse SSE data:", text.slice(0, 200));
    return null;
  }
  if (!event) {
    const type = data && typeof data === "object" ? (data as { type?: unknown }).type : undefined;
    event = typeof type === "string" ? type : "message";
  }
  return { event, data };
}

/**
 * Read an SSE body until it ends, calling `onEvent` per frame. A throw from
 * `onEvent` stops reading and propagates. The reader is always released.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
  options: { idleTimeoutMs?: number } = {},
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const idleMs = options.idleTimeoutMs;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = idleMs
        ? await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new SseIdleTimeoutError(idleMs)), idleMs);
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          })
        : await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (buffer.length > MAX_BUFFER_CHARS) throw new Error("SSE frame exceeded the buffer limit.");
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const frame = parseFrame(part);
        if (frame) onEvent(frame);
      }
      if (chunk.done) break;
    }
    if (buffer.trim()) {
      const frame = parseFrame(buffer);
      if (frame) onEvent(frame);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/** Exponential backoff delay with jitter. */
export function backoffDelay(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
  const exp = Math.min(baseMs * 2 ** attempt, maxMs);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}
