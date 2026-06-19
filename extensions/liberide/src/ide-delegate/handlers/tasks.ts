import * as vscode from "vscode";

type TaskRunState = {
  runId: string;
  execution: vscode.TaskExecution;
  startedAt: number;
  endedAt?: number;
  status: "started" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  exitCode?: number;
  task: Record<string, unknown>;
};

const taskExecutions = new Map<string, TaskRunState>();
let lifecycleRegistered = false;

function taskToJson(task: vscode.Task): Record<string, unknown> {
  return {
    name: task.name,
    source: task.source,
    group: task.group?.id,
    detail: task.detail,
    presentationOptions: task.presentationOptions,
  };
}

function ensureTaskLifecycle(): void {
  if (lifecycleRegistered) return;
  lifecycleRegistered = true;
  vscode.tasks.onDidStartTaskProcess((event) => {
    for (const run of taskExecutions.values()) {
      if (run.execution === event.execution) run.status = "running";
    }
  });
  vscode.tasks.onDidEndTaskProcess((event) => {
    for (const run of taskExecutions.values()) {
      if (run.execution !== event.execution) continue;
      run.endedAt = Date.now();
      run.exitCode = event.exitCode;
      run.status = event.exitCode === 0 ? "completed" : "failed";
    }
  });
}

export async function handleTasksList(payload: Record<string, unknown>): Promise<unknown> {
  const filter = payload.filter as string | undefined;
  const tasks = await vscode.tasks.fetchTasks(filter ? { type: filter } : undefined);
  return { tasks: tasks.map(taskToJson) };
}

export async function handleTasksRun(payload: Record<string, unknown>): Promise<unknown> {
  ensureTaskLifecycle();
  const taskName = String(payload.name ?? "");
  const taskSource = payload.source ? String(payload.source) : undefined;
  const tasks = await vscode.tasks.fetchTasks();
  const task = tasks.find((t) => t.name === taskName && (!taskSource || t.source === taskSource));
  if (!task) throw new Error(`Task not found: ${taskName}`);
  const execution = await vscode.tasks.executeTask(task);
  const runId = `${task.name}-${Date.now()}`;
  const taskJson = taskToJson(task);
  taskExecutions.set(runId, {
    runId,
    execution,
    startedAt: Date.now(),
    status: "started",
    task: taskJson,
  });
  return { runId, status: "started", startedAt: new Date().toISOString(), task: taskJson };
}

export async function handleTasksCancel(payload: Record<string, unknown>): Promise<unknown> {
  const runId = String(payload.runId ?? "");
  const run = taskExecutions.get(runId);
  if (!run) throw new Error(`Unknown task run id: ${runId}`);
  run.execution.terminate();
  run.status = "cancelled";
  run.endedAt = Date.now();
  return { cancelled: true, runId };
}

export async function handleTasksStatus(payload: Record<string, unknown>): Promise<unknown> {
  const runId = String(payload.runId ?? "");
  const run = taskExecutions.get(runId);
  if (!run) return { runId, status: "unknown" };
  return {
    runId,
    status: run.status,
    exitCode: run.exitCode ?? null,
    durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
    task: run.task,
  };
}
