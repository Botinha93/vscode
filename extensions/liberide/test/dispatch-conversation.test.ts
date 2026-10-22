import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Uri, vscodeMock, workspace } from "./vscode-mock";

mock.module("vscode", () => vscodeMock);
// Other test files replace `../src/api` process-wide (bun module mocks are
// shared), so this one pins the pieces dispatch needs onto the fetch below.
const previousApi = { ...(await import("../src/api")) };
const testApi = {
  ...previousApi,
  getApiOrigin: () => "http://api.test",
  apiFetch: (path: string, init?: RequestInit) => fetch(path.startsWith("http") ? path : `http://api.test${path}`, init),
  getIntegrationMachineId: () => undefined,
  getIntegrationIdentity: () => undefined,
  fetchAuthenticatedUser: async () => ({ id: "user" }),
  childProcessEnv: () => ({}),
  UUID_PATTERN: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};
mock.module("../src/api", () => testApi);
const { dispatchFeature } = await import("../src/dispatch/client");
const { buildIdeContextPayload } = await import("../src/ide-delegate/context");
const links = await import("../src/dispatch/conversation-link");
const { LiberidePipelineController, formatRunCost, pickServerNodeId } = await import("../src/panel/panel");
const { ideWorkflowRunBody } = await import("../src/workflows/ide-triggers");

const originalFetch = globalThis.fetch;
type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  workspace.workspaceFolders = [{ name: "app", uri: Uri.file("/work/app") }];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/api/specs/dispatch")) return Response.json({ graphId: "g1", templateId: "t", feature: "feat" });
    // Graph subscriptions give up right away: the test only follows the dispatch.
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  mock.module("../src/api", () => previousApi);
});

function memento(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: <T>(key: string, defaultValue?: T) => (values.has(key) ? values.get(key) as T : defaultValue as T),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

const task = (id: string, dependsOn: string[] = []) => ({
  id,
  title: `Task ${id}`,
  status: "ready" as const,
  requirementRefs: [],
  designRefs: [],
  dependsOn,
  producesContext: [],
  expectedFiles: [],
  architectureHints: "",
  acceptance: [],
  agent: "coder",
  body: "Do it.",
  filePath: Uri.file(`/work/app/.liberide/specs/feat/tasks/${id}.md`),
  featureId: "feat",
});

const feature = {
  id: "feat",
  name: "Feature",
  status: "tasks" as const,
  rootUri: Uri.file("/work/app/.liberide/specs/feat"),
  requirementIds: [],
  designIds: [],
  tasks: [task("T-1"), task("T-2", ["T-1"])],
};

function fakeChat(active?: string) {
  const log: string[] = [];
  return {
    log,
    activeConversationId: () => active,
    ensureConversation: async (title: string) => {
      log.push(`ensure:${title}`);
      return "new-chat";
    },
    trackGraph: async (conversationId: string, graphId: string) => {
      log.push(`track:${conversationId}:${graphId}`);
    },
    conversationForGraph: () => undefined,
    revealGraphNode: async () => false,
    postNote: (conversationId: string, text: string) => {
      log.push(`note:${conversationId}:${text}`);
    },
    showConversation: async () => undefined,
  };
}

function controller(chat: ReturnType<typeof fakeChat>, state = memento()) {
  const store = {
    onDidChange: () => ({ dispose: () => undefined }),
    getFeature: (id: string) => (id === feature.id ? feature : undefined),
    getFeatures: () => [feature],
    getActiveFeature: () => feature,
  };
  const runsTree = { trackRun: () => undefined, getRunMeta: () => undefined, serverNodeIdFor: () => undefined };
  const output = { appendLine: () => undefined };
  const context = { workspaceState: state, extensionUri: Uri.file("/ext") };
  return new LiberidePipelineController(context as never, store as never, output as never, runsTree as never, chat as never);
}

const dispatchBody = () => calls.find((call) => call.url.endsWith("/api/specs/dispatch"))?.body;

describe("dispatch reports to a chat", () => {
  test("dispatchFeature sends the conversation id with the IDE context", async () => {
    await dispatchFeature(feature as never, { conversationId: "c1", ideContext: buildIdeContextPayload("c1") });
    const body = dispatchBody()!;
    expect([body.conversationId, (body.ideContext as { conversationId?: string }).conversationId]).toEqual(["c1", "c1"]);
  });

  test("the chat that generated the feature wins over the open chat", async () => {
    const state = memento();
    await links.linkFeatureConversation(state, "feat", "generator-chat");
    const chat = fakeChat("open-chat");
    const panel = controller(chat, state);
    await panel.dispatch("feat");
    panel.dispose();
    const body = dispatchBody()!;
    expect({
      conversationId: body.conversationId,
      ideConversationId: (body.ideContext as { conversationId?: string }).conversationId,
      chat: chat.log,
    }).toEqual({ conversationId: "generator-chat", ideConversationId: "generator-chat", chat: ["track:generator-chat:g1"] });
  });

  test("a pipeline opened from a chat dispatches to that chat", async () => {
    const chat = fakeChat("open-chat");
    const panel = controller(chat);
    panel.show("pipeline-chat");
    await panel.dispatch("feat", ["T-1"]);
    panel.dispose();
    expect([dispatchBody()?.conversationId, chat.log]).toEqual(["pipeline-chat", ["track:pipeline-chat:g1"]]);
  });

  test("with no chat at all, one is created", async () => {
    const chat = fakeChat(undefined);
    const panel = controller(chat);
    await panel.dispatch("feat");
    panel.dispose();
    expect([dispatchBody()?.conversationId, chat.log]).toEqual(["new-chat", ["ensure:Dispatch: Feature", "track:new-chat:g1"]]);
  });

  test("links resolve most specific first and graph links are capped", async () => {
    const state = memento();
    for (let i = 0; i < 205; i++) await links.linkGraphConversation(state, `g${i}`, `c${i}`);
    expect([
      links.resolveDispatchConversation({ explicit: "a", feature: "b", active: "c" }),
      links.resolveDispatchConversation({ feature: "b", active: "c" }),
      links.resolveDispatchConversation({ active: "c" }),
      links.resolveDispatchConversation({}),
      links.graphConversation(state, "g204"),
      links.graphConversation(state, "g0"),
      Object.keys(state.values.get("liberide.graphConversations") as Record<string, string>).length,
    ]).toEqual(["a", "b", "c", undefined, "c204", undefined, 200]);
  });

  test("workflow runs carry the chat id", () => {
    expect(ideWorkflowRunBody("/review", "  ", { source: "liberide" }, "c1")).toEqual({
      command: "/review",
      input: undefined,
      payload: { source: "liberide", conversationId: "c1" },
      conversationId: "c1",
    });
  });
});

describe("run actions", () => {
  test("replay resolves the server's node id from a task id", () => {
    const ids = ["g1_T-1", "g1_T-2_implement", "g1_T-2_verify"];
    expect([
      pickServerNodeId("g1", "g1_T-1", ids),
      pickServerNodeId("g1", "T-1", ids),
      pickServerNodeId("g1", "T-2", ids),
      pickServerNodeId("g1", "T-9", ids),
    ]).toEqual(["g1_T-1", "g1_T-1", "g1_T-2_implement", undefined]);
  });

  test("run cost is a chat note with a per-node table", () => {
    expect(formatRunCost({
      inputTokens: 1200,
      outputTokens: 300,
      estimatedCostUsd: 0.0123,
      callCount: 3,
      perNode: [{ nodeId: "g1_T-1", title: "Parser", inputTokens: 1200, outputTokens: 300, estimatedCostUsd: 0.0123 }],
    })).toBe([
      "**Run cost:** $0.0123 · 1200 in / 300 out tokens · 3 calls",
      "",
      "| Node | Cost | Tokens in/out |",
      "| --- | --- | --- |",
      "| Parser | $0.0123 | 1200/300 |",
    ].join("\n"));
  });
});
