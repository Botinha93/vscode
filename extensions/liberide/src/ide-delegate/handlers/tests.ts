import * as vscode from "vscode";

const testRuns = new Map<string, { startedAt: number; command: string; status: "started" | "unknown" }>();

export async function handleTestsList(): Promise<unknown> {
  // VS Code exposes no public API to enumerate test controllers created by
  // other extensions (`vscode.tests` only offers `createTestController`).
  // Return a structured unsupported result so the backend can fall back to a
  // command-based test run (handleTestsRun) instead of trusting a fabricated
  // empty controller list.
  return {
    supported: false,
    reason: "VS Code does not expose an API to enumerate test controllers; use tests.run instead.",
    controllers: [],
  };
}

export async function handleTestsRun(payload: Record<string, unknown>): Promise<unknown> {
  const runId = `test-${Date.now()}`;
  const testIds = (payload.testIds as string[] | undefined) ?? [];
  const command = testIds.length > 0 ? "testing.runSelected" : "testing.runAll";
  await vscode.commands.executeCommand(command);
  testRuns.set(runId, { startedAt: Date.now(), command, status: "started" });
  return {
    runId,
    status: "started",
    started: true,
    command,
    testCount: testIds.length,
    startedAt: new Date().toISOString(),
    guidance: "VS Code does not expose completion results for arbitrary test controllers here; use diagnostics or project verification commands for pass/fail output.",
  };
}

export async function handleTestsStatus(payload: Record<string, unknown>): Promise<unknown> {
  const runId = String(payload.runId ?? "");
  const run = testRuns.get(runId);
  if (!run) return { runId, status: "unknown" };
  return {
    runId,
    status: run.status,
    command: run.command,
    startedAt: new Date(run.startedAt).toISOString(),
    durationMs: Date.now() - run.startedAt,
    guidance: "Completion is not observable through the public VS Code test API from this delegate.",
  };
}
