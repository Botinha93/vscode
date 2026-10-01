import * as vscode from "vscode";
import { relativePath } from "./helpers";

/**
 * Tests through VS Code's test observer (proposed `testObserver` API, enabled
 * for this built-in extension). The stable API cannot see other extensions'
 * test controllers or read results, so this is the only way to list, run and
 * report on the tests the user sees in the Testing view.
 */

const MAX_LISTED_TESTS = 500;
const MAX_REPORTED_FAILURES = 20;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 20_000;

let observer: vscode.TestObserver | undefined;

function testObserver(): vscode.TestObserver {
  if (!vscode.tests.createTestObserver) {
    throw new Error("The test observer API is not available in this VS Code build");
  }
  observer ??= vscode.tests.createTestObserver();
  return observer;
}

function flatten(items: Iterable<vscode.TestItem>, out: vscode.TestItem[] = []): vscode.TestItem[] {
  for (const item of items) {
    out.push(item);
    flatten([...item.children].map(([, child]) => child), out);
  }
  return out;
}

function rangeJson(range: vscode.Range | undefined): Record<string, number> | undefined {
  if (!range) return undefined;
  return { startLine: range.start.line + 1, endLine: range.end.line + 1 };
}

export async function handleTestsList(): Promise<unknown> {
  const controllerOf = new Map<vscode.TestItem, string>();
  for (const root of testObserver().tests) for (const item of flatten([root])) controllerOf.set(item, root.id);
  const all = [...controllerOf.keys()];
  return {
    tests: all.slice(0, MAX_LISTED_TESTS).map((item) => ({
      id: item.id,
      controllerId: controllerOf.get(item),
      label: item.label,
      path: item.uri ? relativePath(item.uri.fsPath) : undefined,
      range: rangeJson(item.range),
      children: item.children.size,
    })),
    total: all.length,
    truncated: all.length > MAX_LISTED_TESTS,
  };
}

interface TestRunSummary {
  runId: string;
  status: "running" | "completed" | "cancelled" | "failed";
  startedAt: string;
  completedAt?: string;
  counts?: Record<string, number>;
  failures?: Array<{ id: string; label: string; path?: string; line?: number; state: string; message: string }>;
  output?: string;
  error?: string;
}

const runs = new Map<string, TestRunSummary>();

const STATE_NAMES: Record<number, string> = { 1: "queued", 2: "running", 3: "passed", 4: "failed", 5: "skipped", 6: "errored" };

function messageText(message: vscode.TestMessage): string {
  const text = typeof message.message === "string" ? message.message : message.message.value;
  const diff = message.expectedOutput !== undefined || message.actualOutput !== undefined
    ? `\nexpected: ${message.expectedOutput ?? ""}\nactual: ${message.actualOutput ?? ""}`
    : "";
  return `${text}${diff}`.slice(0, MAX_MESSAGE_CHARS);
}

/** Summarize a finished run: counts by state and the first failures with their messages. */
function summarize(result: vscode.TestRunResult, summary: TestRunSummary): void {
  const counts: Record<string, number> = {};
  const failures: NonNullable<TestRunSummary["failures"]> = [];
  const visit = (snapshot: vscode.TestResultSnapshot) => {
    if (!snapshot.children.length) {
      for (const task of snapshot.taskStates) {
        const state = STATE_NAMES[task.state] ?? String(task.state);
        counts[state] = (counts[state] ?? 0) + 1;
        if ((state === "failed" || state === "errored") && failures.length < MAX_REPORTED_FAILURES) {
          failures.push({
            id: snapshot.id,
            label: snapshot.label,
            path: snapshot.uri ? relativePath(snapshot.uri.fsPath) : undefined,
            line: snapshot.range ? snapshot.range.start.line + 1 : undefined,
            state,
            message: task.messages.map(messageText).join("\n---\n") || "(no message)",
          });
        }
      }
    }
    snapshot.children.forEach(visit);
  };
  result.results.forEach(visit);
  summary.counts = counts;
  summary.failures = failures;
  if (result.output) summary.output = result.output.slice(-MAX_OUTPUT_CHARS);
  summary.completedAt = new Date(result.completedAt).toISOString();
}

/**
 * Run tests and wait for the run to finish, so the caller gets pass/fail and
 * failure messages instead of "started". `testIds` selects tests (and their
 * children); none runs everything.
 */
export async function handleTestsRun(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const ids = new Set(Array.isArray(payload.testIds) ? payload.testIds.map(String) : []);
  const controllerId = typeof payload.controllerId === "string" && payload.controllerId ? payload.controllerId : undefined;
  // The observer's top-level items are the controllers' roots (their id is the controller id).
  const roots = testObserver().tests;
  const scoped = controllerId ? roots.filter((item) => item.id === controllerId) : [...roots];
  if (controllerId && !scoped.length) {
    throw new Error(`No test controller '${controllerId}'. Known: ${roots.map((item) => item.id).join(", ") || "(none)"}`);
  }
  const all = flatten(scoped);
  const include = ids.size ? all.filter((item) => ids.has(item.id)) : controllerId ? scoped : undefined;
  if (ids.size && !include?.length) throw new Error(`No tests found for ids: ${[...ids].join(", ")}${controllerId ? ` in controller '${controllerId}'` : ""}. Use the test list tool to get ids.`);

  const runId = `test-${Date.now()}`;
  const summary: TestRunSummary = { runId, status: "running", startedAt: new Date().toISOString() };
  runs.set(runId, summary);
  while (runs.size > 50) runs.delete(runs.keys().next().value!);

  const before = vscode.tests.testResults[0];
  const cancellation = new vscode.CancellationTokenSource();
  const onAbort = () => cancellation.cancel();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    await vscode.tests.runTests(new vscode.TestRunRequest(include), cancellation.token);
    const latest = vscode.tests.testResults[0];
    if (latest && latest !== before) summarize(latest, summary);
    summary.status = cancellation.token.isCancellationRequested ? "cancelled" : "completed";
  } catch (err) {
    summary.status = "failed";
    summary.error = err instanceof Error ? err.message : String(err);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    cancellation.dispose();
  }
  return summary;
}

export async function handleTestsStatus(payload: Record<string, unknown>): Promise<unknown> {
  const runId = String(payload.runId ?? "");
  return runs.get(runId) ?? { runId, status: "unknown" };
}
