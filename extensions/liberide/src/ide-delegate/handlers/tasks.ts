import * as vscode from "vscode";

interface TaskRun {
  runId: string;
  execution: vscode.TaskExecution;
  name: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  state: "running" | "completed" | "terminated";
}

/** Recent task runs by id (bounded); ended runs stay queryable for status. */
const taskRuns = new Map<string, TaskRun>();
const MAX_TRACKED_RUNS = 100;
let listening = false;

function runFor(execution: vscode.TaskExecution): TaskRun | undefined {
  for (const run of taskRuns.values()) if (run.execution === execution) return run;
  return undefined;
}

/** Task events identify runs by the TaskExecution object. */
function ensureTaskListeners(): void {
  if (listening) return;
  listening = true;
  vscode.tasks.onDidEndTaskProcess((event) => {
    const run = runFor(event.execution);
    if (run && event.exitCode !== undefined) run.exitCode = event.exitCode;
  });
  vscode.tasks.onDidEndTask((event) => {
    const run = runFor(event.execution);
    if (!run || run.state !== "running") return;
    run.state = "completed";
    run.endedAt = Date.now();
  });
}

function runToJson(run: TaskRun): Record<string, unknown> {
  return {
    runId: run.runId,
    name: run.name,
    state: run.state,
    exitCode: run.exitCode ?? null,
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt ? new Date(run.endedAt).toISOString() : null,
    durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
    // VS Code exposes no API to read a task's terminal output.
    output: "unavailable: VS Code does not expose task output; run the command with the terminal tool to capture it",
  };
}

function taskToJson(task: vscode.Task): Record<string, unknown> {
  return {
    name: task.name,
    source: task.source,
    group: task.group?.id,
    detail: task.detail,
    presentationOptions: task.presentationOptions,
  };
}

export async function handleTasksList(payload: Record<string, unknown>): Promise<unknown> {
  const filter = payload.filter as string | undefined;
  const tasks = await vscode.tasks.fetchTasks(filter ? { type: filter } : undefined);
  return { tasks: tasks.map(taskToJson) };
}

export async function handleTasksRun(payload: Record<string, unknown>): Promise<unknown> {
  const taskName = String(payload.name ?? "");
  const taskSource = payload.source ? String(payload.source) : undefined;
  const tasks = await vscode.tasks.fetchTasks();
  const task = tasks.find((t) => t.name === taskName && (!taskSource || t.source === taskSource));
  if (!task) throw new Error(`Task not found: ${taskName}`);
  ensureTaskListeners();
  const execution = await vscode.tasks.executeTask(task);
  const runId = `${task.name}-${Date.now()}`;
  taskRuns.set(runId, { runId, execution, name: task.name, startedAt: Date.now(), state: "running" });
  while (taskRuns.size > MAX_TRACKED_RUNS) taskRuns.delete(taskRuns.keys().next().value!);
  return { runId, task: taskToJson(task) };
}

export async function handleTasksCancel(payload: Record<string, unknown>): Promise<unknown> {
  const runId = String(payload.runId ?? "");
  const run = taskRuns.get(runId);
  if (!run) throw new Error(`Unknown task run id: ${runId}`);
  if (run.state === "running") {
    run.execution.terminate();
    run.state = "terminated";
    run.endedAt = Date.now();
  }
  return { cancelled: true, ...runToJson(run) };
}

export async function handleTasksStatus(payload: Record<string, unknown>): Promise<unknown> {
  const runId = String(payload.runId ?? "");
  const run = taskRuns.get(runId);
  if (!run) throw new Error(`Unknown task run id: ${runId}`);
  return runToJson(run);
}
