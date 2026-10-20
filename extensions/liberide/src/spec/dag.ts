import type { TaskContract, TaskStatus } from "./schema";

export function validateDag(tasks: TaskContract[]): { ok: boolean; order: string[]; error?: string } {
  const ids = new Set(tasks.map((task) => task.id));
  const indegree = new Map(tasks.map((task) => [task.id, 0]));
  const adjacency = new Map(tasks.map((task) => [task.id, [] as string[]]));
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) return { ok: false, order: [], error: `Task ${task.id} depends on unknown task ${dep}` };
      if (dep === task.id) return { ok: false, order: [], error: `Task ${task.id} cannot depend on itself` };
      adjacency.get(dep)?.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  return order.length === tasks.length ? { ok: true, order } : { ok: false, order: [], error: "Task dependencies contain a cycle" };
}

export function computeTaskReadiness(tasks: TaskContract[]): Map<string, { ready: boolean; blockedBy: string[] }> {
  const status = new Map(tasks.map((task) => [task.id, task.status]));
  return new Map(tasks.map((task) => {
    const blockedBy = task.dependsOn.filter((dep) => status.get(dep) !== "completed");
    return [task.id, { ready: blockedBy.length === 0 && task.status !== "completed", blockedBy }];
  }));
}

export function effectiveStatus(task: TaskContract, readiness: Map<string, { ready: boolean; blockedBy: string[] }>): TaskStatus {
  if (["running", "completed", "failed"].includes(task.status)) return task.status;
  const info = readiness.get(task.id);
  if (info?.blockedBy.length) return "blocked";
  return info?.ready ? "ready" : task.status;
}

export function groupTasksByStatus(tasks: TaskContract[]): Record<TaskStatus, TaskContract[]> {
  const readiness = computeTaskReadiness(tasks);
  const groups: Record<TaskStatus, TaskContract[]> = { pending: [], ready: [], running: [], completed: [], blocked: [], failed: [] };
  for (const task of tasks) groups[effectiveStatus(task, readiness)].push(task);
  return groups;
}
