import { describe, expect, mock, test } from "bun:test";
import type { AgentApprovalRequest } from "@nexus/shared";

const apiCalls: Array<{ path: string; init?: RequestInit }> = [];
mock.module("../src/api", () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    apiCalls.push({ path, init });
    return new Response(JSON.stringify({ graphId: "g1", templateId: "t1", feature: "f" }), { status: 200 });
  },
  getApiOrigin: () => "http://api.test",
}));

const {
  APPROVAL_MODE_OPTIONS,
  activeChatApprovalContext,
  approvalModeAllowed,
  changeConversationApprovalMode,
  conversationApprovalMode,
  loosensApprovals,
  maxApprovalModeFromConfig,
  setActiveChatApprovalContext,
} = await import("../src/chat/approval-mode");
const { dispatchFeature } = await import("../src/dispatch/client");

const pending = (id: string): AgentApprovalRequest => ({ id, action: `Allow ${id}`, reason: "r", risk: "medium", status: "pending", createdAt: new Date().toISOString() });

describe("approval mode options", () => {
  test("offers Ask, Auto and Full access with an explanation each", () => {
    expect(APPROVAL_MODE_OPTIONS.map((o) => o.label)).toEqual(["Ask", "Auto", "Full access"]);
    for (const option of APPROVAL_MODE_OPTIONS) expect(option.description.length).toBeGreaterThan(10);
  });

  test("the admin maximum disables more permissive modes", () => {
    expect(approvalModeAllowed("full", "auto")).toBe(false);
    expect(approvalModeAllowed("auto", "auto")).toBe(true);
    expect(approvalModeAllowed("ask", "ask")).toBe(true);
    expect(approvalModeAllowed("full", undefined)).toBe(true);
    expect(maxApprovalModeFromConfig({ maxApprovalMode: "auto" })).toBe("auto");
    expect(maxApprovalModeFromConfig({})).toBeUndefined();
  });

  test("a conversation without a stored mode runs at the default (auto)", () => {
    expect(conversationApprovalMode({})).toBe("auto");
    expect(conversationApprovalMode({ approvalMode: "ask" })).toBe("ask");
    expect(conversationApprovalMode({ approvalMode: "bogus" })).toBe("auto");
  });

  test("only a looser mode offers to resolve pending approvals", () => {
    expect(loosensApprovals("ask", "auto")).toBe(true);
    expect(loosensApprovals("auto", "full")).toBe(true);
    expect(loosensApprovals("full", "auto")).toBe(false);
    expect(loosensApprovals("auto", "ask")).toBe(false);
  });
});

describe("changeConversationApprovalMode", () => {
  test("PATCHes the conversation and lists approvals the looser mode would auto-approve", async () => {
    const patches: unknown[] = [];
    const result = await changeConversationApprovalMode(
      { conversationId: "c1", previous: "ask", next: "auto", max: "full" },
      {
        patch: async (id, partial) => { patches.push({ id, ...partial }); return { id, approvalMode: partial.approvalMode }; },
        listAutoResolvable: async () => ({ approvals: [pending("a1"), pending("a2")] }),
      },
    );
    expect(patches).toEqual([{ id: "c1", approvalMode: "auto" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("auto");
      expect(result.resolvable.map((a) => a.id)).toEqual(["a1", "a2"]);
    }
  });

  test("tightening the mode does not offer anything", async () => {
    let listed = false;
    const result = await changeConversationApprovalMode(
      { conversationId: "c1", previous: "full", next: "ask" },
      {
        patch: async (id, partial) => ({ id, approvalMode: partial.approvalMode }),
        listAutoResolvable: async () => { listed = true; return { approvals: [pending("a1")] }; },
      },
    );
    expect(listed).toBe(false);
    expect(result.ok && result.resolvable).toEqual([]);
  });

  test("a mode above the admin maximum is refused without a PATCH", async () => {
    let patched = false;
    const result = await changeConversationApprovalMode(
      { conversationId: "c1", previous: "auto", next: "full", max: "auto" },
      {
        patch: async (id, partial) => { patched = true; return { id, approvalMode: partial.approvalMode }; },
        listAutoResolvable: async () => ({ approvals: [] }),
      },
    );
    expect(patched).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("a failed PATCH is reported, not applied", async () => {
    const result = await changeConversationApprovalMode(
      { conversationId: "c1", previous: "auto", next: "full" },
      {
        patch: async () => { throw new Error("400 Bad Request"); },
        listAutoResolvable: async () => ({ approvals: [] }),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("400");
  });

  test("the server's answer wins (it may clamp the mode)", async () => {
    const result = await changeConversationApprovalMode(
      { conversationId: "c1", previous: "ask", next: "full" },
      {
        patch: async (id) => ({ id, approvalMode: "auto" }),
        listAutoResolvable: async () => ({ approvals: [] }),
      },
    );
    expect(result.ok && result.mode).toBe("auto");
  });
});

describe("spec dispatch inherits the chat's approval mode", () => {
  test("the active chat context is sent with the dispatch", async () => {
    setActiveChatApprovalContext({ conversationId: "c1", approvalMode: "full" });
    expect(activeChatApprovalContext()).toEqual({ conversationId: "c1", approvalMode: "full" });
    apiCalls.length = 0;
    const feature = {
      id: "feat",
      name: "Feature",
      tasks: [{ id: "T1", title: "Task", dependsOn: [], requirementRefs: [], designRefs: [], producesContext: [], expectedFiles: [], acceptance: [], body: "do it", architectureHints: "" }],
    } as unknown as Parameters<typeof dispatchFeature>[0];
    await dispatchFeature(feature, { approvalMode: activeChatApprovalContext().approvalMode });
    const body = JSON.parse(String(apiCalls[0]?.init?.body)) as Record<string, unknown>;
    expect(apiCalls[0]?.path).toBe("/api/specs/dispatch");
    expect(body.approvalMode).toBe("full");
  });

  test("no mode is sent when the chat has none (the server uses the conversation's)", async () => {
    apiCalls.length = 0;
    const feature = { id: "feat", name: "Feature", tasks: [{ id: "T1", title: "Task", dependsOn: [], requirementRefs: [], designRefs: [], producesContext: [], expectedFiles: [], acceptance: [], body: "x", architectureHints: "" }] } as unknown as Parameters<typeof dispatchFeature>[0];
    await dispatchFeature(feature, {});
    const body = JSON.parse(String(apiCalls[0]?.init?.body)) as Record<string, unknown>;
    expect("approvalMode" in body).toBe(false);
  });
});
