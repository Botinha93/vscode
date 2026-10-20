import { resolve } from "node:path";

/**
 * Cross-surface continuation: a conversation opened from the web app (the
 * `conversation.open` notification, or a launch that names one in the
 * integration file) and "Continue in Browser" back to it.
 */

/** A launch request older than this is stale (the window was restarted later). */
export const STARTUP_REQUEST_MAX_AGE_MS = 5 * 60_000;

type Listener = (conversationId: string) => void;

const listeners = new Set<Listener>();
/** Requests that arrived before the chat view registered; delivered on registration. */
let pending: string | undefined;
let lastStartupRequest: string | undefined;

export function onConversationOpenRequest(listener: Listener): () => void {
  listeners.add(listener);
  if (pending) {
    const id = pending;
    pending = undefined;
    listener(id);
  }
  return () => listeners.delete(listener);
}

export function requestConversationOpen(conversationId: string): void {
  if (!listeners.size) {
    pending = conversationId;
    return;
  }
  for (const listener of [...listeners]) listener(conversationId);
}

/** The conversation id of a `conversation.open` notification's params. */
export function parseConversationOpenParams(params: unknown): string | undefined {
  const id = params && typeof params === "object" ? (params as { conversationId?: unknown }).conversationId : undefined;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : undefined;
}

/** `${webOrigin}/c/<id>`: the web app's deep link. Undefined without an origin or a saved conversation. */
export function continueInBrowserUrl(webOrigin: unknown, conversationId: string | null | undefined): string | undefined {
  if (typeof webOrigin !== "string" || !conversationId || conversationId.startsWith("draft:")) return undefined;
  let base: string;
  try {
    const url = new URL(webOrigin.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    base = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
  return `${base}/c/${encodeURIComponent(conversationId)}`;
}

/**
 * A one-time sign-in link from `POST /api/auth/handoff`, accepted only when it
 * is the web app's `/auth/handoff` page on the same origin as `plainUrl` with
 * the code in the fragment.
 */
export function acceptHandoffUrl(value: unknown, plainUrl: string): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== new URL(plainUrl).origin || url.pathname !== "/auth/handoff" || url.search) return undefined;
    return new URLSearchParams(url.hash.slice(1)).get("code") ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The URL "Continue in Browser" opens: a one-time sign-in link to the
 * conversation when the server mints one, else the plain deep link (older
 * servers, offline, or an unusable answer).
 */
export async function resolveContinueInBrowserUrl(
  plainUrl: string,
  conversationId: string,
  mint: (next: string) => Promise<{ url?: unknown }>,
): Promise<string> {
  try {
    const minted = await mint(`/c/${encodeURIComponent(conversationId)}`);
    return acceptHandoffUrl(minted?.url, plainUrl) ?? plainUrl;
  } catch {
    return plainUrl;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

/**
 * The conversation a launch asked this window to open, once: the request must
 * be recent and for one of this window's folders (several windows share the
 * integration file).
 */
export function takeStartupConversationRequest(
  snapshot: Readonly<Record<string, unknown>> | null | undefined,
  folders: string[],
  now = Date.now(),
): string | undefined {
  const conversationId = parseConversationOpenParams(snapshot);
  if (!snapshot || !conversationId || typeof snapshot.conversationRequestedAt !== "string") return undefined;
  const requestedAt = Date.parse(snapshot.conversationRequestedAt);
  if (!Number.isFinite(requestedAt) || now - requestedAt > STARTUP_REQUEST_MAX_AGE_MS) return undefined;
  const projectPath = typeof snapshot.projectPath === "string" ? snapshot.projectPath : "";
  if (projectPath ? !folders.some((folder) => samePath(folder, projectPath)) : folders.length > 0) return undefined;
  const key = `${conversationId}@${snapshot.conversationRequestedAt}`;
  if (key === lastStartupRequest) return undefined;
  lastStartupRequest = key;
  return conversationId;
}

/** Tests only. */
export function resetContinuationState(): void {
  listeners.clear();
  pending = undefined;
  lastStartupRequest = undefined;
}
