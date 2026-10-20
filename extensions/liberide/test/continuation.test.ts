import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { vscodeMock } from "./vscode-mock";

mock.module("vscode", () => ({
  ...vscodeMock,
  window: { ...vscodeMock.window, state: { focused: false }, onDidChangeWindowState: () => ({ dispose: () => undefined }) },
}));
mock.module("../src/ide-delegate/handlers", () => ({ dispatchIdeDelegate: async () => ({}) }));

const { IdeDelegateStream } = await import("../src/ide-delegate/stream");
const {
  STARTUP_REQUEST_MAX_AGE_MS,
  acceptHandoffUrl,
  continueInBrowserUrl,
  onConversationOpenRequest,
  parseConversationOpenParams,
  resetContinuationState,
  resolveContinueInBrowserUrl,
  takeStartupConversationRequest,
} = await import("../src/chat/continuation");
// Another suite mocks "../src/api" process-wide; load the real client under its own specifier.
const { createAuthHandoff } = await import("../src/api.ts?real") as typeof import("../src/api");

function notify(method: string, params: unknown) {
  const stream = new IdeDelegateStream({ userId: "u", projectPath: "/p", sessionId: "s", folderName: "p" });
  const internals = stream as unknown as { handleMessage: (raw: string) => Promise<void> };
  return internals.handleMessage(JSON.stringify({ jsonrpc: "2.0", method, params })).finally(() => stream.dispose());
}

beforeEach(() => resetContinuationState());

describe("conversation.open notification", () => {
  test("opens the named conversation in the chat view", async () => {
    const opened: string[] = [];
    const off = onConversationOpenRequest((id) => opened.push(id));
    await notify("conversation.open", { conversationId: "V1StGXR8_Z5jdHi6B-myT" });
    expect(opened).toEqual(["V1StGXR8_Z5jdHi6B-myT"]);
    off();
  });

  test("ignores malformed params", async () => {
    const opened: string[] = [];
    onConversationOpenRequest((id) => opened.push(id));
    await notify("conversation.open", { conversationId: "../etc" });
    await notify("conversation.open", {});
    await notify("conversation.open", null);
    expect(opened).toEqual([]);
  });

  test("a request before the chat view registers is delivered on registration", async () => {
    await notify("conversation.open", { conversationId: "early" });
    const opened: string[] = [];
    onConversationOpenRequest((id) => opened.push(id));
    expect(opened).toEqual(["early"]);
  });

  test("params parsing", () => {
    expect(parseConversationOpenParams({ conversationId: "abc_D-1" })).toBe("abc_D-1");
    expect(parseConversationOpenParams({ conversationId: 42 })).toBeUndefined();
    expect(parseConversationOpenParams("abc")).toBeUndefined();
  });
});

describe("continue in browser", () => {
  test("builds the web app's /c/<id> link", () => {
    expect(continueInBrowserUrl("https://chat.example.com", "abc")).toBe("https://chat.example.com/c/abc");
    expect(continueInBrowserUrl("https://chat.example.com/app/", "a b")).toBe("https://chat.example.com/app/c/a%20b");
    expect(continueInBrowserUrl("http://127.0.0.1:5173", "abc")).toBe("http://127.0.0.1:5173/c/abc");
  });

  test("no link without an origin, for drafts, or for a non-http origin", () => {
    expect(continueInBrowserUrl(undefined, "abc")).toBeUndefined();
    expect(continueInBrowserUrl("https://chat.example.com", undefined)).toBeUndefined();
    expect(continueInBrowserUrl("https://chat.example.com", "draft:123")).toBeUndefined();
    expect(continueInBrowserUrl("javascript:alert(1)", "abc")).toBeUndefined();
    expect(continueInBrowserUrl("not a url", "abc")).toBeUndefined();
  });
});

describe("continue in browser sign-in handoff", () => {
  const plain = "http://127.0.0.1:5173/c/abc";
  const handoff = "http://127.0.0.1:5173/auth/handoff#code=Zm9v_YmFy-123&next=%2Fc%2Fabc";

  test("accepts only a same-origin /auth/handoff link with the code in the fragment", () => {
    expect(acceptHandoffUrl(handoff, plain)).toBe(handoff);
    expect(acceptHandoffUrl("https://evil.example/auth/handoff#code=x", plain)).toBeUndefined();
    expect(acceptHandoffUrl("http://127.0.0.1:5174/auth/handoff#code=x", plain)).toBeUndefined();
    expect(acceptHandoffUrl("http://127.0.0.1:5173/auth/handoff?code=x", plain)).toBeUndefined();
    expect(acceptHandoffUrl("http://127.0.0.1:5173/auth/handoff#next=%2F", plain)).toBeUndefined();
    expect(acceptHandoffUrl("http://127.0.0.1:5173/c/abc#code=x", plain)).toBeUndefined();
    expect(acceptHandoffUrl("javascript:alert(1)//#code=x", plain)).toBeUndefined();
    expect(acceptHandoffUrl(undefined, plain)).toBeUndefined();
  });

  test("opens the minted link for the conversation", async () => {
    const asked: string[] = [];
    const url = await resolveContinueInBrowserUrl(plain, "abc", async (next) => {
      asked.push(next);
      return { url: handoff };
    });
    expect(url).toBe(handoff);
    expect(asked).toEqual(["/c/abc"]);
  });

  test("falls back to the plain link when minting fails or answers oddly", async () => {
    expect(await resolveContinueInBrowserUrl(plain, "abc", async () => { throw new Error("offline"); })).toBe(plain);
    expect(await resolveContinueInBrowserUrl(plain, "abc", async () => ({}))).toBe(plain);
    expect(await resolveContinueInBrowserUrl(plain, "abc", async () => ({ url: "https://evil.example/auth/handoff#code=x" }))).toBe(plain);
  });

  describe("through the API client", () => {
    const realFetch = globalThis.fetch;
    const calls: Array<{ url: string; method?: string; body?: unknown; auth?: string }> = [];
    let respond: () => Response | Promise<Response> = () => new Response("{}");

    beforeAll(() => {
      process.env.LIBERIDE_API_ORIGIN = "http://127.0.0.1:3999";
      globalThis.fetch = (async (input: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(input), method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined, auth: headers.Authorization });
        return respond();
      }) as typeof fetch;
    });
    afterAll(() => {
      globalThis.fetch = realFetch;
      delete process.env.LIBERIDE_API_ORIGIN;
    });
    beforeEach(() => { calls.length = 0; });

    test("posts the conversation path and opens the returned link", async () => {
      respond = () => Response.json({ url: handoff });
      expect(await resolveContinueInBrowserUrl(plain, "abc", createAuthHandoff)).toBe(handoff);
      expect(calls).toEqual([expect.objectContaining({ url: "http://127.0.0.1:3999/api/auth/handoff", method: "POST", body: { next: "/c/abc" } })]);
    });

    test("an older server (404) or a network error falls back to the plain link", async () => {
      respond = () => new Response("not found", { status: 404 });
      expect(await resolveContinueInBrowserUrl(plain, "abc", createAuthHandoff)).toBe(plain);
      respond = () => { throw new TypeError("fetch failed"); };
      expect(await resolveContinueInBrowserUrl(plain, "abc", createAuthHandoff)).toBe(plain);
    });
  });
});

describe("launch request in the integration file", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  const request = (extra: Record<string, unknown> = {}) => ({
    conversationId: "abc",
    conversationRequestedAt: new Date(now - 1_000).toISOString(),
    projectPath: "/home/me/app",
    ...extra,
  });

  test("taken once by the window serving the folder", () => {
    expect(takeStartupConversationRequest(request(), ["/home/me/other"], now)).toBeUndefined();
    expect(takeStartupConversationRequest(request(), ["/home/me/app/"], now)).toBe("abc");
    expect(takeStartupConversationRequest(request(), ["/home/me/app"], now)).toBeUndefined();
  });

  test("stale or missing requests are ignored", () => {
    const stale = request({ conversationRequestedAt: new Date(now - STARTUP_REQUEST_MAX_AGE_MS - 1).toISOString() });
    expect(takeStartupConversationRequest(stale, ["/home/me/app"], now)).toBeUndefined();
    expect(takeStartupConversationRequest(request({ conversationRequestedAt: undefined }), ["/home/me/app"], now)).toBeUndefined();
    expect(takeStartupConversationRequest(null, ["/home/me/app"], now)).toBeUndefined();
  });
});
