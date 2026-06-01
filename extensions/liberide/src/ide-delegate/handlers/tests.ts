import * as vscode from "vscode";

const testRuns = new Map<string, { startedAt: number; command: string }>();

function collectTests(items: readonly vscode.TestItem[], out: vscode.TestItem[] = []): vscode.TestItem[] {
  for (const item of items) {
    out.push(item);
    if (item.children.size > 0) collectTests([...item.children.values()], out);
  }
  return out;
}

export async function handleTestsList(): Promise<unknown> {
  const controllers = vscode.tests?.all ?? [];
  const suites = controllers.map((controller) => {
    const items = collectTests([...controller.items.values()]);
    return {
      id: controller.id,
      label: controller.label,
      tests: items.map((item) => ({
        id: item.id,
        label: item.label,
        uri: item.uri?.fsPath,
        range: item.range
          ? {
              startLine: item.range.start.line + 1,
              startCharacter: item.range.start.character,
              endLine: item.range.end.line + 1,
              endCharacter: item.range.end.character,
            }
          : undefined,
      })),
    };
  });
  return { controllers: suites };
}

export async function handleTestsRun(payload: Record<string, unknown>): Promise<unknown> {
  const runId = `test-${Date.now()}`;
  const testIds = (payload.testIds as string[] | undefined) ?? [];
  const command = testIds.length > 0 ? "testing.runSelected" : "testing.runAll";
  await vscode.commands.executeCommand(command);
  testRuns.set(runId, { startedAt: Date.now(), command });
  return { runId, started: true, command, testCount: testIds.length };
}

export async function handleTestsStatus(payload: Record<string, unknown>): Promise<unknown> {
  const runId = String(payload.runId ?? "");
  const run = testRuns.get(runId);
  if (!run) return { runId, status: "unknown" };
  return { runId, status: "started", command: run.command, startedAt: run.startedAt };
}
