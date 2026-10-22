import { describe, expect, test } from "bun:test";
import {
  agentRunFrom,
  agentRunFromAnchor,
  applyAgentStreamEvent,
  isActiveAgentRunStatus,
  layoutAgentRuns,
  mergeAgentRun,
  parseAgentStreamEvent,
  type AgentRunView,
} from "../src/chat/agent-runs";
import { parseConversationListEvent } from "../src/api";

const run = (runId: string, extra: Partial<AgentRunView> = {}): AgentRunView => ({ runId, status: "running", text: "", toolCalls: [], ...extra });

describe("conversation stream events", () => {
  test("agent_run_updated, approvals_changed and models_changed reach the chat", () => {
    expect([
      parseConversationListEvent({ type: "agent_run_updated", userId: "u", conversationId: "c1", runId: "r1", graphId: "g1", nodeId: "g1_T-1", parentRunId: "r0", messageId: "m1", status: "running" }),
      parseConversationListEvent({ type: "agent_run_updated", conversationId: "c1", graphId: "g1", nodeId: "g1_T-2", nodeStatus: "running" }),
      parseConversationListEvent({ type: "approvals_changed", conversationId: "c1" }),
      parseConversationListEvent({ type: "models_changed", reason: "model_updated" }),
      parseConversationListEvent({ type: "conversations_changed" }),
    ]).toEqual([
      { type: "agent_run_updated", conversationId: "c1", runId: "r1", graphId: "g1", nodeId: "g1_T-1", parentRunId: "r0", messageId: "m1", status: "running" },
      { type: "agent_run_updated", conversationId: "c1", graphId: "g1", nodeId: "g1_T-2", nodeStatus: "running" },
      { type: "approvals_changed", conversationId: "c1" },
      { type: "models_changed" },
      { type: "conversations_changed" },
    ]);
  });

  test("unknown or malformed payloads are dropped", () => {
    expect([
      parseConversationListEvent({ type: "heartbeat" }),
      parseConversationListEvent(null),
      parseConversationListEvent("conversations_changed"),
      parseConversationListEvent({ type: "resync" }),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("agents stream events", () => {
  test("snapshot, delta, tool and status frames", () => {
    expect([
      parseAgentStreamEvent("snapshot", { runs: [{ runId: "r1", status: "running", text: "Hel", toolCalls: [{ id: "t1", name: "ide_read_file", arguments: { path: "a.ts" } }], graphId: "g", nodeId: "g_T-1", parentRunId: null }] }),
      parseAgentStreamEvent("delta", { runId: "r1", text: "lo" }),
      parseAgentStreamEvent("tool", { runId: "r1", event: { id: "t1", name: "ide_read_file", arguments: { path: "a.ts" }, result: "ok" } }),
      parseAgentStreamEvent("status", { runId: "r1", status: "failed", error: "Budget exhausted: 100k tokens", graphId: "g", nodeId: "g_T-1" }),
      parseAgentStreamEvent("message", { type: "delta", runId: "r2", text: "x" }),
      parseAgentStreamEvent("delta", { runId: "r1" }),
      parseAgentStreamEvent("ping", {}),
    ]).toEqual([
      { type: "snapshot", runs: [{ runId: "r1", status: "running", text: "Hel", toolCalls: [{ id: "t1", name: "ide_read_file", status: "running", summary: "a.ts" }], graphId: "g", nodeId: "g_T-1" }] },
      { type: "delta", runId: "r1", text: "lo" },
      { type: "tool", runId: "r1", call: { id: "t1", name: "ide_read_file", status: "complete", summary: "a.ts", result: "ok" } },
      { type: "status", runId: "r1", status: "failed", error: "Budget exhausted: 100k tokens", graphId: "g", nodeId: "g_T-1" },
      { type: "delta", runId: "r2", text: "x" },
      undefined,
      undefined,
    ]);
  });

  test("the reducer streams text, upserts tool calls and keeps the full error", () => {
    const runs = new Map<string, AgentRunView>();
    const changed = [
      applyAgentStreamEvent(runs, { type: "snapshot", runs: [run("r1", { text: "Hel", graphId: "g" }), run("r2", { status: "queued" })] }),
      applyAgentStreamEvent(runs, { type: "delta", runId: "r1", text: "lo" }),
      applyAgentStreamEvent(runs, { type: "tool", runId: "r1", call: { id: "t1", name: "terminal_run", status: "running", summary: "bun test" } }),
      applyAgentStreamEvent(runs, { type: "tool", runId: "r1", call: { id: "t1", name: "terminal_run", status: "error", result: "exit 1" } }),
      applyAgentStreamEvent(runs, { type: "status", runId: "r1", status: "failed", error: "Budget exhausted: the run used 120000 of 100000 tokens" }),
      applyAgentStreamEvent(runs, { type: "delta", runId: "r3", text: "late" }),
    ];
    expect(changed).toEqual([["r1", "r2"], ["r1"], ["r1"], ["r1"], ["r1"], ["r3"]]);
    expect([...runs.values()]).toEqual([
      {
        runId: "r1",
        status: "failed",
        text: "Hello",
        toolCalls: [{ id: "t1", name: "terminal_run", status: "error", summary: "bun test", result: "exit 1" }],
        graphId: "g",
        nodeId: undefined,
        parentRunId: undefined,
        messageId: undefined,
        agentName: undefined,
        error: "Budget exhausted: the run used 120000 of 100000 tokens",
      },
      { runId: "r2", status: "queued", text: "", toolCalls: [], graphId: undefined, nodeId: undefined, parentRunId: undefined, messageId: undefined, agentName: undefined, error: undefined },
      { runId: "r3", status: "running", text: "late", toolCalls: [] },
    ]);
  });

  test("a later snapshot (after a reconnect) replaces the streamed text", () => {
    const runs = new Map<string, AgentRunView>([["r1", run("r1", { text: "partial" })]]);
    applyAgentStreamEvent(runs, { type: "snapshot", runs: [run("r1", { text: "partial and more", status: "completed" })] });
    expect([runs.get("r1")?.text, runs.get("r1")?.status, isActiveAgentRunStatus("completed"), isActiveAgentRunStatus("waiting_approval")])
      .toEqual(["partial and more", "completed", false, true]);
  });
});

describe("run cards from the server", () => {
  test("run card messages (Message.agentRun, or raw metadata) become runs", () => {
    expect([
      agentRunFromAnchor({ id: "m1", content: "Wrote the parser", agentRun: { kind: "agent_run", agentRunId: "r1", parentRunId: "r0", graphId: "g", nodeId: "g_T-1", status: "completed", agentName: "coder", outputExcerpt: "Wrote the parser and tests" } }),
      agentRunFromAnchor({ id: "m2", content: "", metadata: { kind: "agent_run", agentRunId: "r2", agentName: "reviewer", status: "failed", error: "Budget exhausted: 120000 of 100000 tokens" } } as never),
      agentRunFromAnchor({ id: "m3", content: "plain reply" }),
    ]).toEqual([
      { runId: "r1", status: "completed", text: "Wrote the parser and tests", toolCalls: [], messageId: "m1", graphId: "g", nodeId: "g_T-1", parentRunId: "r0", agentName: "coder" },
      { runId: "r2", status: "failed", text: "", toolCalls: [], messageId: "m2", agentName: "reviewer", error: "Budget exhausted: 120000 of 100000 tokens" },
      undefined,
    ]);
  });

  test("run list rows accept id/output and keep the longer text on merge", () => {
    const listed = agentRunFrom({ id: "r1", status: "running", output: "abc", agentName: "coder" })!;
    const anchored = mergeAgentRun(listed, run("r1", { text: "ab", messageId: "m1", status: "running" }));
    expect(anchored).toEqual({ runId: "r1", status: "running", text: "abc", toolCalls: [], graphId: undefined, nodeId: undefined, parentRunId: undefined, messageId: "m1", agentName: "coder", error: undefined });
  });
});

describe("run layout", () => {
  test("nests node runs in their graph card, children under parents, and hides placed anchors", () => {
    const messages = [
      { id: "turn", graphId: "g" },
      { id: "anchor-node", agentRunId: "node-run" },
      { id: "anchor-child", agentRunId: "child" },
      { id: "anchor-bg", agentRunId: "bg" },
      { id: "reply" },
    ];
    const runs = [
      run("node-run", { graphId: "g", nodeId: "g_T-1" }),
      run("node-run-2", { graphId: "g", nodeId: "g_T-2" }),
      run("graph-level", { graphId: "g" }),
      run("child", { parentRunId: "node-run" }),
      run("grandchild", { parentRunId: "child" }),
      run("bg"),
      run("started-by-reply", { messageId: "reply" }),
      run("stray", { parentRunId: "missing" }),
    ];
    const layout = layoutAgentRuns(messages, runs);
    expect({
      hidden: [...layout.hiddenMessageIds].sort(),
      roots: Object.fromEntries(layout.rootsByMessage),
      nodes: Object.fromEntries([...layout.nodeRuns].map(([graphId, nodes]) => [graphId, Object.fromEntries(nodes)])),
      children: Object.fromEntries(layout.childrenByRun),
      orphans: layout.orphans,
    }).toEqual({
      hidden: ["anchor-child", "anchor-node"],
      roots: { turn: ["graph-level"], "anchor-bg": ["bg"], reply: ["started-by-reply"] },
      nodes: { g: { "g_T-1": ["node-run"], "g_T-2": ["node-run-2"] } },
      children: { "node-run": ["child"], child: ["grandchild"] },
      orphans: ["stray"],
    });
  });

  test("parallel runs of one node are all drawn, and a parent cycle does not hide runs", () => {
    const layout = layoutAgentRuns([{ id: "turn", graphId: "g" }], [
      run("a", { graphId: "g", nodeId: "n" }),
      run("b", { graphId: "g", nodeId: "n" }),
      run("x", { parentRunId: "y" }),
      run("y", { parentRunId: "x" }),
    ]);
    expect([layout.nodeRuns.get("g")?.get("n"), layout.orphans]).toEqual([["a", "b"], ["x", "y"]]);
  });
});
