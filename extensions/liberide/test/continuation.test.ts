import { beforeEach, describe, expect, mock, test } from "bun:test";
import { vscodeMock } from "./vscode-mock";

mock.module("vscode", () => ({
  ...vscodeMock,
  window: { ...vscodeMock.window, state: { focused: false }, onDidChangeWindowState: () => ({ dispose: () => undefined }) },
}));
mock.module("../src/ide-delegate/handlers", () => ({ dispatchIdeDelegate: async () => ({}) }));

const { IdeDelegateStream } = await import("../src/ide-delegate/stream");
const {
  STARTUP_REQUEST_MAX_AGE_MS,
  continueInBrowserUrl,
  onConversationOpenRequest,
  parseConversationOpenParams,
  resetContinuationState,
  takeStartupConversationRequest,
} = await import("../src/chat/continuation");

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
