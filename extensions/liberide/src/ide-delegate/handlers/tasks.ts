import * as vscode from "vscode";

const taskExecutions = new Map<string, vscode.TaskExecution>();

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
  const execution = await vscode.tasks.executeTask(task);
  const runId = `${task.name}-${Date.now()}`;
  taskExecutions.set(runId, execution);
  return { runId, task: taskToJson(task) };
}

export async function handleTasksCancel(payload: Record<string, unknown>): Promise<unknown> {
  const runId = String(payload.runId ?? "");
  const execution = taskExecutions.get(runId);
  if (!execution) throw new Error(`Unknown task run id: ${runId}`);
  execution.terminate();
  taskExecutions.delete(runId);
  return { cancelled: true, runId };
}
