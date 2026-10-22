import * as vscode from "vscode";
import { workspaceFolder } from "./helpers";

let lastDebugError: string | undefined;
let lifecycleRegistered = false;

function ensureDebugLifecycle(): void {
  if (lifecycleRegistered) return;
  lifecycleRegistered = true;
  vscode.debug.onDidStartDebugSession(() => {
    lastDebugError = undefined;
  });
  vscode.debug.onDidTerminateDebugSession(() => {
    lastDebugError = undefined;
  });
}

export async function handleDebugStart(payload: Record<string, unknown>): Promise<unknown> {
  ensureDebugLifecycle();
  const configName = String(payload.name ?? payload.configName ?? "");
  const folder = workspaceFolder();
  if (!folder) throw new Error("No workspace folder open");
  const launch = vscode.workspace.getConfiguration("launch", folder.uri);
  const configurations = launch.get<Array<Record<string, unknown>>>("configurations") ?? [];
  const config = configurations.find((c) => c.name === configName);
  if (!config) throw new Error(`Debug configuration not found: ${configName}`);
  const started = await vscode.debug.startDebugging(folder, config as vscode.DebugConfiguration);
  return { started, status: started ? "running" : "failed", name: configName, activeSession: activeSessionJson() };
}

export async function handleDebugStop(): Promise<unknown> {
  ensureDebugLifecycle();
  const session = vscode.debug.activeDebugSession;
  if (!session) return { stopped: false, reason: "no active session" };
  await vscode.debug.stopDebugging(session);
  return { stopped: true, status: "stopped", name: session.name };
}

export async function handleDebugList(): Promise<unknown> {
  ensureDebugLifecycle();
  const folder = workspaceFolder();
  const launch = folder ? vscode.workspace.getConfiguration("launch", folder.uri) : vscode.workspace.getConfiguration("launch");
  const configurations = launch.get<Array<Record<string, unknown>>>("configurations") ?? [];
  const active = vscode.debug.activeDebugSession;
  return {
    configurations: configurations.map((c) => ({ name: c.name, type: c.type, request: c.request })),
    activeSession: activeSessionJson(active),
    status: active ? "running" : "stopped",
    stackTraceAvailable: Boolean(active),
    lastError: lastDebugError,
  };
}

export async function handleDebugStackTrace(payload: Record<string, unknown>): Promise<unknown> {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { available: false, reason: "no active debug session" };
  const threadId = Number(payload.threadId ?? 1);
  try {
    const response = await session.customRequest("stackTrace", {
      threadId,
      startFrame: Number(payload.startFrame ?? 0),
      levels: Number(payload.levels ?? 20),
    });
    return { sessionId: session.id, threadId, stackFrames: response?.stackFrames ?? [] };
  } catch (error) {
    lastDebugError = error instanceof Error ? error.message : String(error);
    return {
      sessionId: session.id,
      threadId,
      error: error instanceof Error ? error.message : String(error),
      stackFrames: [],
    };
  }
}

function activeSessionJson(session = vscode.debug.activeDebugSession): { name: string; type: string; id: string } | null {
  return session ? { name: session.name, type: session.type, id: session.id } : null;
}
