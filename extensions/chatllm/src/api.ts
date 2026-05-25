import type { AppConfig } from "./chat/types";

export function getApiOrigin(): string {
  return (process.env.CHATLLM_API_ORIGIN || "").replace(/\/$/, "");
}

export function getAuthToken(): string {
  return process.env.CHATLLM_AUTH_TOKEN || "";
}

export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers = { "Content-Type": "application/json", ...(extra ?? {}) };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const origin = getApiOrigin();
  if (!origin) throw new Error("CHATLLM_API_ORIGIN is not set.");
  return fetch(path.startsWith("http") ? path : `${origin}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
}

export async function fetchConfig(): Promise<AppConfig> {
  const response = await apiFetch("/api/config");
  if (!response.ok) throw new Error(`Failed to load config (${response.status})`);
  return response.json() as Promise<AppConfig>;
}
