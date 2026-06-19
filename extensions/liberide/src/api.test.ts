import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearIntegrationCache, fetchAuthenticatedUser, getApiOrigin, getAuthToken, getIntegrationIdentity, parseSseFrame, sseBackoffDelay } from "./api";

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

afterEach(() => {
  for (const key of [
    "LIBERIDE_API_ORIGIN",
    "CHATLLM_API_ORIGIN",
    "LIBERIDE_AUTH_TOKEN",
    "CHATLLM_AUTH_TOKEN",
    "LIBERVOX_INTEGRATION_FILE",
    "CHATLLM_INTEGRATION_FILE",
  ]) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = originalFetch;
  clearIntegrationCache();
});

describe("parseSseFrame", () => {
  test("parses event type and data", () => {
    expect(parseSseFrame("event: node_status\ndata: {\"nodeId\":\"a\"}")).toEqual({
      type: "node_status",
      data: '{"nodeId":"a"}',
    });
  });

  test("data without an event type", () => {
    expect(parseSseFrame("data: hello")).toEqual({ type: undefined, data: "hello" });
  });

  test("concatenates multi-line data per SSE spec", () => {
    expect(parseSseFrame("data: line1\ndata: line2")).toEqual({ type: undefined, data: "line1\nline2" });
  });

  test("returns undefined for a comment/heartbeat frame with no data", () => {
    expect(parseSseFrame(": keep-alive")).toBeUndefined();
    expect(parseSseFrame("event: ping")).toBeUndefined();
  });
});

describe("sseBackoffDelay", () => {
  test("doubles per attempt and caps", () => {
    expect(sseBackoffDelay(0, 1000, 30000)).toBe(1000);
    expect(sseBackoffDelay(1, 1000, 30000)).toBe(2000);
    expect(sseBackoffDelay(3, 1000, 30000)).toBe(8000);
    expect(sseBackoffDelay(10, 1000, 30000)).toBe(30000); // capped
  });

  test("clamps negative attempts to the base", () => {
    expect(sseBackoffDelay(-5, 1000, 30000)).toBe(1000);
  });
});

describe("integration file loading", () => {
  test("uses env origin/token before integration file", () => {
    const dir = mkdtempSync(join(tmpdir(), "liberide-api-"));
    try {
      const file = join(dir, "integration.json");
      writeFileSync(file, JSON.stringify({ apiOrigin: "http://file", authToken: "file-token" }));
      process.env.LIBERVOX_INTEGRATION_FILE = file;
      process.env.LIBERIDE_API_ORIGIN = "http://env/";
      process.env.LIBERIDE_AUTH_TOKEN = "env-token";
      clearIntegrationCache();
      expect(getApiOrigin()).toBe("http://env");
      expect(getAuthToken()).toBe("env-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to integration file and exposes identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "liberide-api-"));
    try {
      const file = join(dir, "integration.json");
      writeFileSync(file, JSON.stringify({ apiOrigin: "http://file/", authToken: "file-token", userId: "u1", userEmail: "u@example.test" }));
      delete process.env.LIBERIDE_API_ORIGIN;
      delete process.env.LIBERIDE_AUTH_TOKEN;
      process.env.LIBERVOX_INTEGRATION_FILE = file;
      clearIntegrationCache();
      expect(getApiOrigin()).toBe("http://file");
      expect(getAuthToken()).toBe("file-token");
      expect(getIntegrationIdentity()).toEqual({ id: "u1", email: "u@example.test", name: undefined });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refreshes when integration file changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "liberide-api-"));
    try {
      const file = join(dir, "integration.json");
      delete process.env.LIBERIDE_API_ORIGIN;
      delete process.env.LIBERIDE_AUTH_TOKEN;
      process.env.LIBERVOX_INTEGRATION_FILE = file;
      writeFileSync(file, JSON.stringify({ apiOrigin: "http://one", authToken: "one" }));
      clearIntegrationCache();
      expect(getApiOrigin()).toBe("http://one");
      await new Promise((resolve) => setTimeout(resolve, 10));
      writeFileSync(file, JSON.stringify({ apiOrigin: "http://two", authToken: "two" }));
      expect(getApiOrigin()).toBe("http://two");
      expect(getAuthToken()).toBe("two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fetches authenticated user from backend", async () => {
    delete process.env.LIBERVOX_INTEGRATION_FILE;
    process.env.LIBERIDE_API_ORIGIN = "http://backend.test/";
    process.env.LIBERIDE_AUTH_TOKEN = "token-1";
    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://backend.test/api/auth/me");
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer token-1");
      return Promise.resolve(
        new Response(JSON.stringify({ user: { id: "u2", email: "u2@example.test", name: "User Two" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    await expect(fetchAuthenticatedUser()).resolves.toEqual({ id: "u2", email: "u2@example.test", name: "User Two" });
  });
});
