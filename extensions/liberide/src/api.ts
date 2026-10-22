import type {
  AppConfig,
  Conversation,
  ConversationMessage,
  DocumentRecord,
  SharingFolder,
} from "./chat/types";
import { conversationAgentsStreamPath, type ApprovalGrant, type ExecutionGraph, type McpServer, type PermissionPolicy } from "@nexus/shared";
import { existsSync, mkdirSync, readFileSync, statSync, unwatchFile, watchFile, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { backoffDelay, readSseStream } from "./sse";
import { agentRunFrom, parseAgentStreamEvent, toolCallFrom, type AgentRunToolCallView, type AgentRunView, type AgentStreamEvent } from "./chat/agent-runs";

type IntegrationSnapshot = {
  apiOrigin?: string;
  authToken?: string;
  /** ISO timestamp at which `authToken` stops being accepted, when known. */
  expiresAt?: string;
  /** LiberIDE machine id (written by the desktop app, or by pairing). */
  machineId?: string;
  /** Signed-in user, when the desktop app wrote it (informational; the server trusts the token). */
  userId?: string;
  userEmail?: string;
  userName?: string;
  [key: string]: unknown;
};

let integrationPath: string | undefined;
let cachedIntegration: IntegrationSnapshot | null | undefined;
/** Path the cached snapshot was read from (written back after a token refresh). */
let cachedIntegrationSource: string | undefined;
/** mtime of `cachedIntegrationSource` when read, so a rewrite is picked up even before the watcher fires. */
let cachedIntegrationMtimeMs: number | undefined;
/** The token listeners last heard about (see {@link reloadAuth}). */
let announcedToken: string | undefined;
/** Token issued by `/api/auth/integrations/vscode` after the file's token was refreshed. */
let refreshedAuth: { token: string; expiresAt?: string } | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshInFlight: Promise<boolean> | undefined;
const authListeners = new Set<() => void>();
const integrationListeners = new Set<() => void>();

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
  clearIntegrationCache();
  announcedToken = getAuthToken();
  const watched = [...new Set(integrationCandidates())];
  for (const path of watched) {
    watchFile(path, { interval: WATCH_INTERVAL_MS, persistent: false }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
      reloadAuth();
      for (const listener of [...integrationListeners]) listener();
    });
  }
  scheduleTokenRefresh();
  return {
    dispose: () => {
      for (const path of watched) unwatchFile(path);
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = undefined;
      authListeners.clear();
      integrationListeners.clear();
    },
  };
}

/** Notified whenever the credentials may have changed (file rewritten, token refreshed). */
export function onAuthChanged(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

/** Notified whenever the integration file is rewritten (a launch may carry a conversation to open). */
export function onIntegrationFileChanged(listener: () => void): () => void {
  integrationListeners.add(listener);
  return () => integrationListeners.delete(listener);
}

/** The integration file as last read (null when there is none). */
export function getIntegrationSnapshot(): Readonly<IntegrationSnapshot> | null {
  return loadIntegrationFile();
}

/** The web app's origin (written by pairing or the desktop app), for "Continue in Browser". */
export function getWebOrigin(): string | undefined {
  const value = loadIntegrationFile()?.webOrigin;
  return typeof value === "string" && value ? value : undefined;
}

function notifyAuthChanged(): void {
  announcedToken = getAuthToken();
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
  // Compare with what listeners last heard: a lazy re-read (mtime changed) may
  // already have picked the new token up before the watcher fired.
  const before = announcedToken ?? getAuthToken();
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
  if (cachedIntegration !== undefined && cachedSnapshotFresh()) return cachedIntegration;
  for (const path of integrationCandidates()) {
    try {
      if (existsSync(path)) {
        const mtimeMs = statSync(path).mtimeMs;
        cachedIntegration = JSON.parse(readFileSync(path, "utf8")) as IntegrationSnapshot;
        cachedIntegrationSource = path;
        cachedIntegrationMtimeMs = mtimeMs;
        return cachedIntegration;
      }
    } catch {
      // try next candidate
    }
  }
  cachedIntegration = null;
  cachedIntegrationSource = undefined;
  cachedIntegrationMtimeMs = undefined;
  return null;
}

/** Whether the cached snapshot's file is unchanged on disk (a missing file is left to the watcher). */
function cachedSnapshotFresh(): boolean {
  if (!cachedIntegrationSource) return true;
  try {
    return statSync(cachedIntegrationSource).mtimeMs === cachedIntegrationMtimeMs;
  } catch {
    return false;
  }
}

export function clearIntegrationCache(): void {
  cachedIntegration = undefined;
  cachedIntegrationSource = undefined;
  cachedIntegrationMtimeMs = undefined;
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
  return launchEnvToken;
}

/**
 * Auth variables a launcher may still inject. They are read once here and
 * removed from the extension host's environment so agent commands, terminals
 * and other extensions' child processes never inherit the user's token.
 */
const AUTH_ENV_KEYS = ["LIBERIDE_AUTH_TOKEN", "CHATLLM_AUTH_TOKEN"] as const;
const launchEnvToken = AUTH_ENV_KEYS.map((key) => process.env[key]).find(Boolean) ?? "";
for (const key of AUTH_ENV_KEYS) delete process.env[key];

/** Matches LIBERIDE_* / CHATLLM_* variables that carry credentials. */
const AUTH_ENV_NAME = /^(LIBERIDE|CHATLLM)_.*(TOKEN|SECRET|PASSWORD|AUTH|KEY|COOKIE)/i;

/** `env` (default: the host's) without LiberIDE/ChatLLM credentials, for spawned commands. */
export function childProcessEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!AUTH_ENV_NAME.test(key)) out[key] = value;
  return out;
}

/** Must match IDE_RPC_SUBPROTOCOL on the server; echoed back on a bearer handshake. */
export const IDE_RPC_SUBPROTOCOL = "liberide.v1";

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * WebSocket subprotocols carrying the bearer token (`bearer.<base64url>`).
 * Tokens never go in the URL: the server only accepts them here.
 */
export function bearerSubprotocols(token = getAuthToken()): string[] | undefined {
  return token ? [IDE_RPC_SUBPROTOCOL, `bearer.${base64url(token)}`] : undefined;
}

export function wsOrigin(httpOrigin: string): string {
  if (httpOrigin.startsWith("https://")) return `wss://${httpOrigin.slice("https://".length)}`;
  if (httpOrigin.startsWith("http://")) return `ws://${httpOrigin.slice("http://".length)}`;
  return httpOrigin;
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
          writeIntegrationFile(cachedIntegrationSource, { ...snapshot, authToken: body.token, expiresAt: body.expiresAt });
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

/** Write the integration file (0600) and make it the cached snapshot. */
function writeIntegrationFile(path: string, snapshot: IntegrationSnapshot): void {
  const next = { ...snapshot, updatedAt: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next), { mode: 0o600 });
  // `mode` only applies when the file is created; tighten an existing one too.
  chmodSync(path, 0o600);
  cachedIntegration = next;
  cachedIntegrationSource = path;
  cachedIntegrationMtimeMs = statSync(path).mtimeMs;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Machine id from the integration file, when it carries a valid one. */
export function getIntegrationMachineId(): string | undefined {
  const value = loadIntegrationFile()?.machineId;
  return typeof value === "string" && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

/** `https://host[/prefix]` without a trailing slash, or undefined when not an http(s) URL. */
export function normalizeServerUrl(input: string): string | undefined {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/**
 * Pair this machine with a server using a code from Settings → Machines. The
 * issued token (bound to `machineId` on the server) is written to the
 * integration file, which switches this window to that server.
 */
export async function pairWithServer(input: {
  serverUrl: string;
  code: string;
  machineId: string;
  hostname?: string;
  platform?: string;
}): Promise<{ apiOrigin: string; machineId: string }> {
  const apiOrigin = normalizeServerUrl(input.serverUrl);
  if (!apiOrigin) throw new Error("Enter the server's http(s) URL.");
  const res = await fetch(`${apiOrigin}/api/machines/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: input.code, machineId: input.machineId, hostname: input.hostname, platform: input.platform }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`Pairing failed: ${body.error ?? `${res.status} ${res.statusText}`}`);
  }
  const body = (await res.json()) as { apiOrigin?: string; webOrigin?: string; authToken?: string; expiresAt?: string; machineId?: string };
  if (!body.authToken) throw new Error("Pairing failed: the server returned no token.");
  const target = cachedIntegrationSource ?? integrationCandidates()[0];
  if (!target) throw new Error("Pairing failed: no location for the LiberIDE integration file.");
  writeIntegrationFile(target, {
    ...(loadIntegrationFile() ?? {}),
    apiOrigin: body.apiOrigin ?? apiOrigin,
    webOrigin: body.webOrigin,
    authToken: body.authToken,
    expiresAt: body.expiresAt,
    machineId: body.machineId ?? input.machineId,
  });
  refreshedAuth = undefined;
  scheduleTokenRefresh();
  notifyAuthChanged();
  return { apiOrigin: body.apiOrigin ?? apiOrigin, machineId: body.machineId ?? input.machineId };
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

export interface AuthenticatedUserSnapshot {
  id: string;
  email?: string;
  name?: string;
  role?: string;
}

export function getIntegrationIdentity(): AuthenticatedUserSnapshot | undefined {
  const snapshot = loadIntegrationFile();
  if (!snapshot?.userId) return undefined;
  return {
    id: snapshot.userId,
    email: snapshot.userEmail,
    name: snapshot.userName,
  };
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

/** A one-time browser sign-in link landing on `next` (`POST /api/auth/handoff`). */
export async function createAuthHandoff(next: string): Promise<{ url?: unknown }> {
  return readJson<{ url?: unknown }>(
    await apiFetch("/api/auth/handoff", { method: "POST", body: JSON.stringify({ next }), signal: AbortSignal.timeout(5_000) }),
  );
}

export async function fetchAuthenticatedUser(): Promise<AuthenticatedUserSnapshot> {
  const payload = await readJson<{ user?: AuthenticatedUserSnapshot }>(await apiFetch("/api/auth/me"));
  if (!payload.user?.id) throw new Error("Authenticated user response did not include an id.");
  return payload.user;
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
  /**
   * agent_run_updated: a run in `conversationId` changed (`runId`, `status`…).
   * approvals_changed: an approval was created or resolved.
   * models_changed: the configured models (or their routing) changed.
   * resync: the stream reconnected; catch up on anything missed.
   */
  type: "conversations_changed" | "folders_changed" | "message_updated" | "agent_run_updated" | "approvals_changed" | "models_changed" | "resync";
  conversationId?: string;
  messageId?: string;
  runId?: string;
  graphId?: string;
  nodeId?: string;
  parentRunId?: string;
  status?: string;
  /** agent_run_updated for a graph node transition: the node's status (`runId` once the node has a run). */
  nodeStatus?: string;
  code?: string;
}

const CONVERSATION_EVENT_TYPES = new Set<ConversationListEvent["type"]>([
  "conversations_changed",
  "folders_changed",
  "message_updated",
  "agent_run_updated",
  "approvals_changed",
  "models_changed",
]);

/** A `/api/conversations/stream` payload as an event, or undefined for unknown/malformed ones. */
export function parseConversationListEvent(data: unknown): ConversationListEvent | undefined {
  if (!data || typeof data !== "object") return undefined;
  const raw = data as Record<string, unknown>;
  if (typeof raw.type !== "string" || !CONVERSATION_EVENT_TYPES.has(raw.type as ConversationListEvent["type"])) return undefined;
  const event: ConversationListEvent = { type: raw.type as ConversationListEvent["type"] };
  for (const key of ["conversationId", "messageId", "runId", "graphId", "nodeId", "parentRunId", "status", "nodeStatus", "code"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value) event[key] = value;
  }
  return event;
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
        const event = parseConversationListEvent(data);
        if (event) onChange(event);
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

// ---------------------------------------------------------------------------
// Agent runs of a conversation (chat cards)
// ---------------------------------------------------------------------------

/** `GET /api/conversations/:id/agent-runs` (array, or `{ runs }`). */
export async function listConversationAgentRuns(conversationId: string): Promise<AgentRunView[]> {
  const payload = await readJson<unknown>(await apiFetch(`/api/conversations/${encodeURIComponent(conversationId)}/agent-runs`));
  const list = Array.isArray(payload) ? payload : Array.isArray((payload as { runs?: unknown } | null)?.runs) ? (payload as { runs: unknown[] }).runs : [];
  return list.map(agentRunFrom).filter((run): run is AgentRunView => Boolean(run));
}

/** `GET /api/agent-runs/:id/tool-calls` (array, or `{ toolCalls }`). */
export async function listAgentRunToolCalls(runId: string): Promise<AgentRunToolCallView[]> {
  const payload = await readJson<unknown>(await apiFetch(`/api/agent-runs/${encodeURIComponent(runId)}/tool-calls`));
  const list = Array.isArray(payload) ? payload : Array.isArray((payload as { toolCalls?: unknown } | null)?.toolCalls) ? (payload as { toolCalls: unknown[] }).toolCalls : [];
  return list.map(toolCallFrom).filter((call): call is AgentRunToolCallView => Boolean(call));
}

export interface AgentsStreamOptions {
  /** Connection state, for a "reconnecting" hint on the cards. */
  onConnectionChange?: (connected: boolean) => void;
  log?: (message: string) => void;
}

/**
 * Follow `GET /api/conversations/:id/agents/stream`: a `snapshot` of the
 * conversation's runs, then `delta` / `tool` / `status` events. Reconnects
 * with backoff (the server re-sends the snapshot) until disposed.
 */
export function subscribeConversationAgents(
  conversationId: string,
  onEvent: (event: AgentStreamEvent) => void,
  options: AgentsStreamOptions = {},
): () => void {
  let closed = false;
  let attempt = 0;
  let abort: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = (reason: string) => {
    if (closed || retryTimer) return;
    options.onConnectionChange?.(false);
    options.log?.(`agents ${conversationId}: reconnecting (${reason})`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, backoffDelay(attempt++, 1_000, 30_000));
  };

  const connect = async () => {
    if (closed) return;
    abort = new AbortController();
    try {
      const response = await apiFetch(conversationAgentsStreamPath(conversationId), {
        headers: { Accept: "text/event-stream" },
        signal: abort.signal,
      });
      if (response.status === 404 || response.status === 403) {
        // Older server or not ours: nothing to follow.
        response.body?.cancel().catch(() => undefined);
        options.log?.(`agents ${conversationId}: stream unavailable (${response.status})`);
        return;
      }
      if (!response.ok || !response.body) {
        response.body?.cancel().catch(() => undefined);
        scheduleReconnect(`HTTP ${response.status}`);
        return;
      }
      attempt = 0;
      options.onConnectionChange?.(true);
      await readSseStream(response.body, ({ event, data }) => {
        const parsed = parseAgentStreamEvent(event, data);
        if (parsed && !closed) onEvent(parsed);
      }, { idleTimeoutMs: 90_000 });
      if (!closed) scheduleReconnect("stream ended");
    } catch (err) {
      if (closed) return;
      scheduleReconnect(err instanceof Error ? err.message : String(err));
    }
  };

  void connect();
  return () => {
    closed = true;
    abort?.abort();
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };
}

// ---------------------------------------------------------------------------
// Approval grants & permission policies (read + revoke for the Approvals view)
// ---------------------------------------------------------------------------

export async function listApprovalGrants(options?: {
  conversationId?: string;
  scope?: string;
  activeOnly?: boolean;
}): Promise<ApprovalGrant[]> {
  const params = new URLSearchParams();
  if (options?.conversationId) params.set("conversationId", options.conversationId);
  if (options?.scope) params.set("scope", options.scope);
  if (options?.activeOnly) params.set("activeOnly", "true");
  const qs = params.toString();
  return readJson<ApprovalGrant[]>(await apiFetch(`/api/approval-grants${qs ? `?${qs}` : ""}`));
}

export async function revokeApprovalGrant(id: string): Promise<void> {
  await readNothing(
    await apiFetch(`/api/approval-grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

export interface PermissionPoliciesResult {
  /** Policies when readable, or undefined when the backend denied access (manager-only). */
  policies?: PermissionPolicy[];
  /** True when the caller lacks the manager role required to read policies. */
  forbidden?: boolean;
}

/**
 * Read the workspace permission policies. The backend gates this behind the
 * manager role, so a 401/403 is surfaced as `forbidden` (the view then offers a
 * deep-link to the web app) rather than thrown.
 */
export async function listPermissionPolicies(): Promise<PermissionPoliciesResult> {
  const res = await apiFetch("/api/permission-policies");
  if (res.status === 401 || res.status === 403) return { forbidden: true };
  return { policies: await readJson<PermissionPolicy[]>(res) };
}

// ---------------------------------------------------------------------------
// MCP servers (list + per-user enable toggle)
// ---------------------------------------------------------------------------

export async function listMcpServers(): Promise<McpServer[]> {
  return readJson<McpServer[]>(await apiFetch("/api/mcp/servers"));
}

export async function setMcpServerEnabledForUser(id: string, enabled: boolean): Promise<void> {
  await readNothing(
    await apiFetch(`/api/mcp/servers/${encodeURIComponent(id)}/user`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Execution graphs (background run surfacing)
// ---------------------------------------------------------------------------

export async function listExecutionGraphs(options?: {
  status?: string;
  limit?: number;
}): Promise<ExecutionGraph[]> {
  const params = new URLSearchParams();
  if (options?.status) params.set("status", options.status);
  if (options?.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  return readJson<ExecutionGraph[]>(await apiFetch(`/api/execution-graphs${qs ? `?${qs}` : ""}`));
}

// ---------------------------------------------------------------------------
// Resilient Server-Sent Events
// ---------------------------------------------------------------------------

const SSE_RECONNECT_BASE_MS = 2_000;
const SSE_RECONNECT_MAX_MS = 30_000;
const SSE_MAX_BUFFER_BYTES = 1_000_000; // 1 MB cap against malformed/stuck streams

/** Exponential backoff delay for reconnect attempt `n` (0-based), capped. */
export function sseBackoffDelay(
  attempt: number,
  baseMs = SSE_RECONNECT_BASE_MS,
  maxMs = SSE_RECONNECT_MAX_MS,
): number {
  return Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
}

/**
 * Parse a single SSE frame (text between `\n\n` separators) into its event type
 * and concatenated data payload. Returns undefined when the frame carries no
 * `data:` line. Pure and dependency-free for unit testing.
 */
export function parseSseFrame(raw: string): { type?: string; data: string } | undefined {
  let type: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return undefined;
  return { type, data: dataLines.join("\n") };
}

export interface SseStreamOptions {
  /** Fires for each parsed frame that carries data. */
  onEvent: (event: { type?: string; data: string }) => void;
  /** Fires on every successful (re)connect. */
  onConnect?: () => void;
  /** Fires when a connect attempt fails or the stream drops; `gaveUp` is true once retries are exhausted. */
  onError?: (info: { attempt: number; gaveUp: boolean; error?: unknown }) => void;
  /** Extra request headers (Accept: text/event-stream and auth are added automatically). */
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Max consecutive reconnect attempts before giving up. Default Infinity (persistent subscription). */
  maxRetries?: number;
  /** Optional logger (kept vscode-free here; caller passes output channel's appendLine). */
  log?: (message: string) => void;
}

/**
 * Open a resilient SSE subscription: parses frames with a buffer cap, and
 * reconnects with exponential backoff on drop/failure until cancelled or
 * `maxRetries` is exhausted. Returns a cancel function.
 */
export function sseStream(path: string, options: SseStreamOptions): () => void {
  const { onEvent, onConnect, onError, headers, method, body, maxRetries = Infinity, log } = options;
  let closed = false;
  let attempt = 0;
  let controller: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleReconnect = (error?: unknown) => {
    if (closed) return;
    const gaveUp = attempt >= maxRetries;
    onError?.({ attempt, gaveUp, error });
    if (gaveUp) {
      log?.(`SSE ${path} gave up after ${attempt} attempt(s)`);
      return;
    }
    const delay = sseBackoffDelay(attempt);
    attempt += 1;
    reconnectTimer = setTimeout(() => void connect(), delay);
  };

  const connect = async (): Promise<void> => {
    if (closed) return;
    const origin = getApiOrigin();
    if (!origin) {
      scheduleReconnect(new Error("API origin not configured"));
      return;
    }
    controller = new AbortController();
    try {
      const response = await fetch(path.startsWith("http") ? path : `${origin}${path}`, {
        method,
        body,
        headers: authHeaders({ Accept: "text/event-stream", ...(headers ?? {}) }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        scheduleReconnect(new Error(`SSE ${path} responded ${response.status}`));
        return;
      }
      attempt = 0;
      onConnect?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > SSE_MAX_BUFFER_BYTES) {
          log?.(`SSE ${path} buffer exceeded ${SSE_MAX_BUFFER_BYTES} bytes — reconnecting`);
          await reader.cancel().catch(() => undefined);
          scheduleReconnect(new Error("buffer overflow"));
          return;
        }
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const frame = parseSseFrame(part);
          if (frame) onEvent(frame);
        }
      }
      // Clean end (server closed): reconnect for a persistent subscription.
      if (!closed) scheduleReconnect();
    } catch (error) {
      if (closed || (error instanceof DOMException && error.name === "AbortError")) return;
      scheduleReconnect(error);
    }
  };

  void connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    controller?.abort();
  };
}
