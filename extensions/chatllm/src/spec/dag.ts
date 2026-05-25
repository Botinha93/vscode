import type { TaskContract, TaskStatus } from "./schema";

export interface DagValidationResult {
  ok: boolean;
  order: string[];
  error?: string;
}

export function validateDag(tasks: TaskContract[]): DagValidationResult {
  const ids = new Set(tasks.map((t) => t.id));
  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const task of tasks) {
    adjacency.set(task.id, []);
    indegree.set(task.id, 0);
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        return { ok: false, order: [], error: `Task ${task.id} depends on unknown task ${dep}` };
      }
      if (dep === task.id) {
        return { ok: false, order: [], error: `Task ${task.id} cannot depend on itself` };
      }
      adjacency.get(dep)?.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  if (queue.length === 0 && tasks.length > 0) {
    return { ok: false, order: [], error: "Task graph has no root nodes (possible cycle)" };
  }

  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const updated = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, updated);
      if (updated === 0) queue.push(next);
    }
  }

  if (order.length !== tasks.length) {
    return { ok: false, order: [], error: "Task dependencies contain a cycle" };
  }

  return { ok: true, order };
}

export function topoSortTasks(tasks: TaskContract[]): TaskContract[] {
  const validation = validateDag(tasks);
  if (!validation.ok) throw new Error(validation.error ?? "Invalid task DAG");
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return validation.order.map((id) => byId.get(id)).filter((t): t is TaskContract => Boolean(t));
}

export function computeTaskReadiness(tasks: TaskContract[]): Map<string, { ready: boolean; blockedBy: string[] }> {
  const statusById = new Map(tasks.map((t) => [t.id, t.status]));
  const result = new Map<string, { ready: boolean; blockedBy: string[] }>();

  for (const task of tasks) {
    const blockedBy = task.dependsOn.filter((dep) => statusById.get(dep) !== "completed");
    const depsSatisfied = blockedBy.length === 0;
    const ready =
      depsSatisfied && (task.status === "pending" || task.status === "ready") && task.status !== "completed";
    result.set(task.id, { ready, blockedBy });
  }
  return result;
}

export function effectiveStatus(task: TaskContract, readiness: Map<string, { ready: boolean; blockedBy: string[] }>): TaskStatus {
  if (task.status === "running" || task.status === "completed" || task.status === "failed") {
    return task.status;
  }
  const info = readiness.get(task.id);
  if (!info) return task.status;
  if (!info.ready && info.blockedBy.length > 0) return "blocked";
  if (info.ready && task.status === "pending") return "ready";
  return task.status;
}

export function groupTasksByStatus(tasks: TaskContract[]): Record<TaskStatus, TaskContract[]> {
  const readiness = computeTaskReadiness(tasks);
  const groups: Record<TaskStatus, TaskContract[]> = {
    running: [],
    ready: [],
    blocked: [],
    pending: [],
    completed: [],
    failed: [],
  };
  for (const task of tasks) {
    const status = effectiveStatus(task, readiness);
    groups[status].push(task);
  }
  return groups;
}
