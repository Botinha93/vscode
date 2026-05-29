import type {
  AppConfig,
  Conversation,
  ConversationMessage,
  DocumentRecord,
  SharingFolder,
} from "./chat/types";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type IntegrationSnapshot = {
  apiOrigin?: string;
  authToken?: string;
};

let integrationPath: string | undefined;
let cachedIntegration: IntegrationSnapshot | null | undefined;

export function initApiFromContext(context: { globalStorageUri: { fsPath: string } }): void {
  integrationPath = join(context.globalStorageUri.fsPath, "../../../libervox-integration.json");
  cachedIntegration = undefined;
}

function loadIntegrationFile(): IntegrationSnapshot | null {
  if (cachedIntegration !== undefined) return cachedIntegration;
  const candidates = [
    process.env.LIBERVOX_INTEGRATION_FILE,
    process.env.CHATLLM_INTEGRATION_FILE,
    integrationPath,
  ].filter((p): p is string => Boolean(p));
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        cachedIntegration = JSON.parse(readFileSync(path, "utf8")) as IntegrationSnapshot;
        return cachedIntegration;
      }
    } catch {
      // try next candidate
    }
  }
  cachedIntegration = null;
  return null;
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
      | "agentIds"
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

/**
 * Subscribe to conversation list changes (SSE with Bearer auth).
 * Falls back to 30s polling when the stream fails.
 */
export function subscribeConversationListSync(onChange: () => void): () => void {
  const origin = getApiOrigin();
  if (!origin) {
    const poll = setInterval(onChange, 30_000);
    return () => clearInterval(poll);
  }

  let closed = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  const abort = new AbortController();

  const startPoll = () => {
    if (pollTimer || closed) return;
    pollTimer = setInterval(onChange, 30_000);
  };

  void (async () => {
    try {
      const response = await fetch(`${origin}/api/conversations/stream`, {
        headers: authHeaders({ Accept: "text/event-stream" }),
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        startPoll();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            const data = JSON.parse(line.slice(6)) as { type?: string };
            if (data.type === "conversations_changed" || data.type === "folders_changed") {
              onChange();
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
    } catch {
      if (!closed) startPoll();
    }
  })();

  return () => {
    closed = true;
    abort.abort();
    if (pollTimer) clearInterval(pollTimer);
  };
}
