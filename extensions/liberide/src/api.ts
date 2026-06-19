import type {
  AppConfig,
  Conversation,
  ConversationMessage,
  DocumentRecord,
  SharingFolder,
} from "./chat/types";
import type { ApprovalGrant, ExecutionGraph, McpServer, PermissionPolicy } from "@nexus/shared";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type IntegrationSnapshot = {
  apiOrigin?: string;
  authToken?: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
};

let integrationPath: string | undefined;
let cachedIntegration: { path: string; mtimeMs: number; snapshot: IntegrationSnapshot | null } | undefined;

export function initApiFromContext(context: { globalStorageUri: { fsPath: string } }): void {
  integrationPath = join(context.globalStorageUri.fsPath, "../../../libervox-integration.json");
  cachedIntegration = undefined;
}

function loadIntegrationFile(): IntegrationSnapshot | null {
  const candidates = [
    process.env.LIBERVOX_INTEGRATION_FILE,
    process.env.CHATLLM_INTEGRATION_FILE,
    integrationPath,
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const mtimeMs = statSync(path).mtimeMs;
        if (cachedIntegration?.path === path && cachedIntegration.mtimeMs === mtimeMs) {
          return cachedIntegration.snapshot;
        }
        const snapshot = JSON.parse(readFileSync(path, "utf8")) as IntegrationSnapshot;
        cachedIntegration = { path, mtimeMs, snapshot };
        return snapshot;
      }
    } catch {
      // try next candidate
    }
  }
  cachedIntegration = { path: "", mtimeMs: 0, snapshot: null };
  return null;
}

export function clearIntegrationCache(): void {
  cachedIntegration = undefined;
}

export function getApiOrigin(): string {
  const fromEnv = process.env.LIBERIDE_API_ORIGIN ?? process.env.CHATLLM_API_ORIGIN;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return (loadIntegrationFile()?.apiOrigin || "").replace(/\/$/, "");
}

export function getAuthToken(): string {
  const fromEnv = process.env.LIBERIDE_AUTH_TOKEN ?? process.env.CHATLLM_AUTH_TOKEN;
  if (fromEnv) return fromEnv;
  return loadIntegrationFile()?.authToken || "";
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

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const origin = getApiOrigin();
  if (!origin) throw new Error("LIBERIDE_API_ORIGIN is not set.");
  return fetch(path.startsWith("http") ? path : `${origin}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
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
  const token = getAuthToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await apiFetch("/api/documents", { method: "POST", body: form, headers });
  const payload = await readJson<{ document: DocumentRecord }>(response);
  return payload.document;
}

export async function pingBackend(): Promise<boolean> {
  return (await probeBackend()) === "ok";
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

/**
 * Subscribe to conversation list changes (SSE with Bearer auth). Reconnects
 * with exponential backoff on drop; no unbounded polling fallback.
 */
export function subscribeConversationListSync(
  onChange: () => void,
  log?: (message: string) => void,
): () => void {
  return sseStream("/api/conversations/stream", {
    log,
    onEvent: ({ data }) => {
      try {
        const parsed = JSON.parse(data) as { type?: string };
        if (parsed.type === "conversations_changed" || parsed.type === "folders_changed") onChange();
      } catch {
        // ignore malformed chunks
      }
    },
  });
}
