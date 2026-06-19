import { describe, expect, test } from "bun:test";
import { computeTaskReadiness, effectiveStatus, validateDag } from "./dag";
import type { TaskContract, TaskStatus } from "./schema";

function task(id: string, over: Partial<TaskContract> = {}): TaskContract {
  return {
    id,
    title: id,
    status: "pending",
    requirementRefs: [],
    designRefs: [],
    dependsOn: [],
    producesContext: [],
    expectedFiles: [],
    architectureHints: "",
    acceptance: [],
    agent: "coding",
    body: "",
    filePath: { toString: () => `mem:${id}` } as unknown as TaskContract["filePath"],
    featureId: "f",
    ...over,
  };
}

describe("validateDag", () => {
  test("topologically orders a valid DAG", () => {
    const res = validateDag([task("a"), task("b", { dependsOn: ["a"] }), task("c", { dependsOn: ["b"] })]);
    expect(res.ok).toBe(true);
    expect(res.order).toEqual(["a", "b", "c"]);
  });

  test("rejects an unknown dependency", () => {
    const res = validateDag([task("a", { dependsOn: ["ghost"] })]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown task ghost");
  });

  test("rejects a self-dependency", () => {
    const res = validateDag([task("a", { dependsOn: ["a"] })]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("cannot depend on itself");
  });

  test("detects a cycle", () => {
    const res = validateDag([task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("cycle");
  });
});

describe("computeTaskReadiness / effectiveStatus", () => {
  test("a task with no deps is ready; a dependent task is blocked until its dep completes", () => {
    const tasks = [task("a"), task("b", { dependsOn: ["a"] })];
    const r1 = computeTaskReadiness(tasks);
    expect(r1.get("a")).toEqual({ ready: true, blockedBy: [] });
    expect(r1.get("b")).toEqual({ ready: false, blockedBy: ["a"] });
    expect(effectiveStatus(tasks[1], r1)).toBe("blocked");

    const done = [task("a", { status: "completed" }), task("b", { dependsOn: ["a"] })];
    const r2 = computeTaskReadiness(done);
    expect(r2.get("b")).toEqual({ ready: true, blockedBy: [] });
    expect(effectiveStatus(done[1], r2)).toBe("ready");
  });

  test("running/completed/failed states are preserved by effectiveStatus", () => {
    for (const s of ["running", "completed", "failed"] as TaskStatus[]) {
      const t = task("x", { status: s });
      expect(effectiveStatus(t, computeTaskReadiness([t]))).toBe(s);
    }
  });
});
