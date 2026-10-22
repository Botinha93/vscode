import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Uri, vscodeMock, workspace } from "./vscode-mock";

// The writer goes through workspace.fs; back it with real temp files.
Object.assign(workspace, {
  fs: {
    readFile: async (uri: Uri) => readFileSync(uri.fsPath),
    writeFile: async (uri: Uri, content: Uint8Array) => writeFileSync(uri.fsPath, content),
  },
});
mock.module("vscode", () => vscodeMock);
const { updateTaskStatus } = await import("../src/spec/writer");
const { parseTaskContract } = await import("../src/spec/schema");
const { taskIdFromNodeEvent, nodeEventError, taskStatusFromEvent } = await import("../src/dispatch/client");

const dir = mkdtempSync(path.join(tmpdir(), "liberide-tasks-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TASK = `---
id: T-8
title: Document the new Features groups
status: ready
requirement_refs: [R-2, R-3]
depends_on: [T-2]
architecture_hints: |
  Add a Features section (Portuguese, like the rest).
  State the 7, 30 and 90 day windows.
acceptance:
  - The doc lists every group, with its tables and formulas
  - Limits match the collectors
agent: coder
---
Body text.
`;

describe("task status updates from a run", () => {
  test("map the server's node ids to task ids", () => {
    expect(taskIdFromNodeEvent({ type: "node_status", nodeId: "g1_T-1", templateNodeId: "T-1", status: "failed" }, "g1")).toBe("T-1");
    // Older servers send only the prefixed node id.
    expect(taskIdFromNodeEvent({ type: "node_status", nodeId: "g1_T-2", status: "running" }, "g1")).toBe("T-2");
    expect(nodeEventError({ type: "node_status", status: "failed", error: "target_invalid: gone" })).toBe("target_invalid: gone");
    expect(nodeEventError({ type: "node_status", status: "running", error: "stale" })).toBeUndefined();
  });

  test("take swarm task status from task_status, not from the task's individual nodes", () => {
    // Swarm: a task runs as several nodes; the server folds them into task_status.
    expect(taskStatusFromEvent({ type: "task_status", taskId: "T-3", status: "failed", error: "tests failed" }, "g1"))
      .toEqual({ taskId: "T-3", status: "failed", error: "tests failed" });
    expect(taskStatusFromEvent({ type: "node_status", nodeId: "g1_map__map_2_verify", templateNodeId: "verify", taskId: "T-3", status: "failed" }, "g1"))
      .toBeUndefined();
    // One node per task: the node's own status is the task's.
    expect(taskStatusFromEvent({ type: "node_status", nodeId: "g1_T-1", templateNodeId: "T-1", status: "running" }, "g1"))
      .toEqual({ taskId: "T-1", status: "running" });
    expect(taskStatusFromEvent({ type: "graph_status", status: "failed" }, "g1")).toBeUndefined();
  });

  test("record a failure without damaging multi-line hints or comma lists, and clear it on retry", async () => {
    const file = Uri.file(path.join(dir, "T-8.md"));
    writeFileSync(file.fsPath, TASK);

    await updateTaskStatus(file, "failed", "target_invalid: The machine\nis gone");
    const failed = readFileSync(file.fsPath, "utf8");
    expect(failed).toContain("error: target_invalid: The machine is gone");
    const parsed = parseTaskContract("feature", file, failed)!;
    expect(parsed.status).toBe("failed");
    expect(parsed.architectureHints).toBe("Add a Features section (Portuguese, like the rest).\nState the 7, 30 and 90 day windows.");
    expect(parsed.acceptance).toEqual(["The doc lists every group, with its tables and formulas", "Limits match the collectors"]);
    expect(parsed.requirementRefs).toEqual(["R-2", "R-3"]);
    expect(parsed.body).toBe("Body text.");

    await updateTaskStatus(file, "running");
    const retried = readFileSync(file.fsPath, "utf8");
    expect(retried).not.toContain("error:");
    expect(parseTaskContract("feature", file, retried)!.status).toBe("running");
  });
});
