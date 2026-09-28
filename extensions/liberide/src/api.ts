import type {
  AppConfig,
  Conversation,
  ConversationMessage,
  DocumentRecord,
  SharingFolder,
} from "./chat/types";
import { existsSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backoffDelay, readSseStream } from "./sse";

type IntegrationSnapshot = {
  apiOrigin?: string;
  authToken?: string;
  /** ISO timestamp at which `authToken` stops being accepted, when known. */
  expiresAt?: string;
  [key: string]: unknown;
};

let integrationPath: string | undefined;
let cachedIntegration: IntegrationSnapshot | null | undefined;
/** Path the cached snapshot was read from (written back after a token refresh). */
let cachedIntegrationSource: string | undefined;
/** Token issued by `/api/auth/integrations/vscode` after the file's token was refreshed. */
let refreshedAuth: { token: string; expiresAt?: string } | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshInFlight: Promise<boolean> | undefined;
const authListeners = new Set<() => void>();

/** Refresh the token this long before it expires. */
const REFRESH_LEAD_MS = 5 * 60_000;
const MIN_REFRESH_DELAY_MS = 30_000;
const WATCH_INTERVAL_MS = 2_000;

function integrationCandidates(): string[] {
  return [
    process.env.LIBERVOX_INTEGRATION_FILE,
    process.env.CHATLLM_INTEGRATION_FILE,
    integrationPath,
  ].filter((p): p is string => Boolean(p));
}

/**
 * Resolve the integration file location and watch it: when the desktop app
 * rewrites it (re-login, new token) the cached credentials are dropped and
 * listeners registered with {@link onAuthChanged} are notified.
 */
export function initApiFromContext(context: { globalStorageUri: { fsPath: string } }): { dispose(): void } {
  integrationPath = join(context.globalStorageUri.fsPath, "../../../libervox-integration.json");
  cachedIntegration = undefined;
  const watched = [...new Set(integrationCandidates())];
  for (const path of watched) {
    watchFile(path, { interval: WATCH_INTERVAL_MS, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      reloadAuth();
    });
  }
  scheduleTokenRefresh();
  return {
    dispose: () => {
      for (const path of watched) unwatchFile(path);
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = undefined;
      authListeners.clear();
    },
  };
}

/** Notified whenever the credentials may have changed (file rewritten, token refreshed). */
export function onAuthChanged(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function notifyAuthChanged(): void {
  for (const listener of [...authListeners]) {
    try {
      listener();
    } catch (err) {
      console.warn("[liberide] auth listener failed:", err);
    }
  }
}

/** Drop cached credentials and re-read the integration file. Returns true when the token changed. */
export function reloadAuth(): boolean {
  const before = getAuthToken();
  cachedIntegration = undefined;
  const next = loadIntegrationFile();
  // A token written by the desktop app supersedes one we refreshed ourselves.
  if (refreshedAuth && next?.authToken && next.authToken !== refreshedAuth.token) refreshedAuth = undefined;
  const changed = getAuthToken() !== before;
  scheduleTokenRefresh();
  if (changed) notifyAuthChanged();
  return changed;
}

function loadIntegrationFile(): IntegrationSnapshot | null {
  if (cachedIntegration !== undefined) return cachedIntegration;
  for (const path of integrationCandidates()) {
    try {
      if (existsSync(path)) {
        cachedIntegration = JSON.parse(readFileSync(path, "utf8")) as IntegrationSnapshot;
        cachedIntegrationSource = path;
        return cachedIntegration;
      }
    } catch {
      // try next candidate
    }
  }
  cachedIntegration = null;
  cachedIntegrationSource = undefined;
  return null;
}

export function getApiOrigin(): string {
  const fromEnv = process.env.LIBERIDE_API_ORIGIN ?? process.env.CHATLLM_API_ORIGIN;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return (loadIntegrationFile()?.apiOrigin || "").replace(/\/$/, "");
}

/**
 * Current bearer token. Precedence: a token we refreshed ourselves, then the
 * integration file (rewritten by the desktop app on re-login), then the env
 * var captured at launch (which can go stale, so it is the last resort).
 */
export function getAuthToken(): string {
  if (refreshedAuth?.token) return refreshedAuth.token;
  const fromFile = loadIntegrationFile()?.authToken;
  if (fromFile) return fromFile;
  return process.env.LIBERIDE_AUTH_TOKEN ?? process.env.CHATLLM_AUTH_TOKEN ?? "";
}

function currentExpiresAt(): number | undefined {
  const raw = refreshedAuth ? refreshedAuth.expiresAt : loadIntegrationFile()?.expiresAt;
  if (typeof raw !== "string") return undefined;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : undefined;
}

function scheduleTokenRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
  const expiresAt = currentExpiresAt();
  if (!expiresAt || !getAuthToken()) return;
  const delay = Math.max(expiresAt - Date.now() - REFRESH_LEAD_MS, MIN_REFRESH_DELAY_MS);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshAuthToken();
  }, delay);
  // Never keep the extension host alive just for this timer.
  (refreshTimer as { unref?: () => void }).unref?.();
}

/**
 * Exchange the current token for a fresh one via the desktop integration
 * endpoint. The new token is kept in memory and written back to the
 * integration file so other windows pick it up too.
 */
export function refreshAuthToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const origin = getApiOrigin();
    const token = getAuthToken();
    if (!origin || !token) return false;
    try {
      const res = await fetch(`${origin}/api/auth/integrations/vscode`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { token?: string; expiresAt?: string };
      if (!body.token) return false;
      refreshedAuth = { token: body.token, expiresAt: body.expiresAt };
      const snapshot = loadIntegrationFile();
      if (snapshot && cachedIntegrationSource) {
        try {
          const next = { ...snapshot, authToken: body.token, expiresAt: body.expiresAt, updatedAt: new Date().toISOString() };
          writeFileSync(cachedIntegrationSource, JSON.stringify(next), { mode: 0o600 });
          cachedIntegration = next;
        } catch {
          // read-only location: the in-memory token still works for this window
        }
      }
      scheduleTokenRefresh();
      notifyAuthChanged();
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = undefined;
    }
  })();
  return refreshInFlight;
}

/**
 * Called after the server rejected our token: re-read the integration file
 * and, failing that, try a refresh. Returns true when a different token is
 * now available (so the caller can retry once).
 */
export async function recoverFromUnauthorized(): Promise<boolean> {
  if (reloadAuth()) return true;
  return refreshAuthToken();
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(extra ?? {}) };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Authenticated fetch against the API origin. A 401 re-reads the integration
 * file (or refreshes the token) and retries once when the token changed
 * (string and FormData bodies are replayable; stream bodies are not retried).
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const origin = getApiOrigin();
  if (!origin) throw new Error("LIBERIDE_API_ORIGIN is not set.");
  const url = path.startsWith("http") ? path : `${origin}${path}`;
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const send = () => {
    const headers: Record<string, string> = { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) };
    // Let fetch set the multipart boundary.
    if (isForm) delete headers["Content-Type"];
    return fetch(url, { ...init, headers });
  };
  const response = await send();
  const replayable = init?.body === undefined || init.body === null || typeof init.body === "string" || isForm;
  if (response.status !== 401 || init?.signal?.aborted || !replayable) return response;
  if (!(await recoverFromUnauthorized())) return response;
  response.body?.cancel().catch(() => undefined);
  return send();
}

export type BackendReachability = "ok" | "unauthorized" | "unreachable" | "unconfigured";

export async function probeBackend(): Promise<BackendReachability> {
  if (!getApiOrigin()) return "unconfigured";
  try {
    const res = await apiFetch("/api/config");
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "unauthorized";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` \u2014 ${body.slice(0, 300)}` : ""}`);
  }
  return (await res.json()) as T;
}

async function readNothing(res: Response): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${body ? ` \u2014 ${body.slice(0, 300)}` : ""}`);
  }
}

export async function fetchConfig(): Promise<AppConfig> {
  return readJson<AppConfig>(await apiFetch("/api/config"));
}

export async function listConversations(): Promise<Conversation[]> {
  return readJson<Conversation[]>(await apiFetch("/api/conversations"));
}

export async function createConversation(title?: string): Promise<Conversation> {
  return readJson<Conversation>(
    await apiFetch("/api/conversations", { method: "POST", body: JSON.stringify({ title }) }),
  );
}

export async function patchConversation(
  id: string,
  partial: Partial<
    Pick<
      Conversation,
      | "title"
      | "systemPrompt"
      | "provider"
      | "model"
      | "modelSelection"
      | "chatMode"
      | "agentId"
      | "allowedAgentIds"
      | "folder"
      | "tags"
      | "pinned"
      | "archived"
    >
  >,
): Promise<Conversation> {
  return readJson<Conversation>(
    await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(partial),
    }),
  );
}

export async function deleteConversation(id: string): Promise<void> {
  await readNothing(
    await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

export async function listConversationMessages(id: string): Promise<ConversationMessage[]> {
  return readJson<ConversationMessage[]>(
    await apiFetch(`/api/conversations/${encodeURIComponent(id)}/messages`),
  );
}

export async function listFolders(filter: "mine" | "shared" | "all" = "mine"): Promise<SharingFolder[]> {
  return readJson<SharingFolder[]>(
    await apiFetch(`/api/folders?filter=${encodeURIComponent(filter)}`),
  );
}

export async function createFolder(input: {
  name: string;
  color?: string;
  icon?: string;
  parentFolderId?: string;
}): Promise<SharingFolder> {
  return readJson<SharingFolder>(
    await apiFetch("/api/folders", { method: "POST", body: JSON.stringify(input) }),
  );
}

export async function addConversationToFolder(folderId: string, conversationId: string): Promise<void> {
  await readNothing(
    await apiFetch(
      `/api/folders/${encodeURIComponent(folderId)}/conversations/${encodeURIComponent(conversationId)}`,
      { method: "POST" },
    ),
  );
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  return readJson<DocumentRecord[]>(await apiFetch("/api/documents"));
}

export async function uploadDocument(file: { name: string; bytes: Uint8Array; mimeType?: string }): Promise<DocumentRecord> {
  const form = new FormData();
  const bytes = file.bytes.slice();
  const blob = new Blob([bytes], { type: file.mimeType ?? "application/octet-stream" });
  form.append("file", blob, file.name);
  const response = await apiFetch("/api/documents", { method: "POST", body: form });
  const payload = await readJson<{ document: DocumentRecord }>(response);
  return payload.document;
}

export async function pingBackend(): Promise<boolean> {
  return (await probeBackend()) === "ok";
}

export interface ConversationListEvent {
  type: "conversations_changed" | "folders_changed" | "message_updated" | "resync";
  conversationId?: string;
  messageId?: string;
}

/**
 * Subscribe to conversation list changes (SSE with Bearer auth). Reconnects
 * with backoff when the stream drops (emitting a `resync` so callers can
 * catch up on anything missed) and polls every 30s while disconnected.
 */
export function subscribeConversationListSync(onChange: (event: ConversationListEvent) => void): () => void {
  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let abort: AbortController | null = null;
  let attempt = 0;
  /** Bumped per connection so a superseded one never schedules a reconnect. */
  let generation = 0;

  const startPoll = () => {
    if (pollTimer || closed) return;
    pollTimer = setInterval(() => onChange({ type: "resync" }), 30_000);
  };
  const stopPoll = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };
  const scheduleReconnect = () => {
    if (closed || retryTimer) return;
    startPoll();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, backoffDelay(attempt++, 2_000, 60_000));
  };

  const connect = async () => {
    if (closed) return;
    const gen = ++generation;
    const origin = getApiOrigin();
    if (!origin) {
      scheduleReconnect();
      return;
    }
    abort = new AbortController();
    try {
      const response = await fetch(`${origin}/api/conversations/stream`, {
        headers: authHeaders({ Accept: "text/event-stream" }),
        signal: abort.signal,
      });
      if (response.status === 401) {
        response.body?.cancel().catch(() => undefined);
        // A changed token fires onAuthChanged, which reconnects right away.
        if (!(await recoverFromUnauthorized()) && gen === generation) scheduleReconnect();
        return;
      }
      if (!response.ok || !response.body) {
        response.body?.cancel().catch(() => undefined);
        scheduleReconnect();
        return;
      }
      const wasReconnect = attempt > 0;
      attempt = 0;
      stopPoll();
      if (wasReconnect) onChange({ type: "resync" });
      // The server heartbeats every 15s; 60s of silence means a dead socket.
      await readSseStream(response.body, ({ data }) => {
        const event = data as Partial<ConversationListEvent> | null;
        if (!event || typeof event !== "object") return;
        if (event.type === "conversations_changed" || event.type === "folders_changed" || event.type === "message_updated") {
          onChange({ type: event.type, conversationId: event.conversationId, messageId: event.messageId });
        }
      }, { idleTimeoutMs: 60_000 });
    } catch {
      // fall through to reconnect
    }
    if (!closed && gen === generation) {
      attempt = Math.max(attempt, 1);
      scheduleReconnect();
    }
  };

  const offAuth = onAuthChanged(() => {
    // New credentials: reconnect immediately instead of waiting out the backoff.
    if (closed) return;
    abort?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    attempt = 1;
    void connect();
  });

  void connect();

  return () => {
    closed = true;
    offAuth();
    abort?.abort();
    stopPoll();
    if (retryTimer) clearTimeout(retryTimer);
  };
}
