import * as vscode from "vscode";

export async function handleDebugStart(payload: Record<string, unknown>): Promise<unknown> {
  const configName = String(payload.name ?? payload.configName ?? "");
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder open");
  const launch = vscode.workspace.getConfiguration("launch", folder.uri);
  const configurations = launch.get<Array<Record<string, unknown>>>("configurations") ?? [];
  const config = configurations.find((c) => c.name === configName);
  if (!config) throw new Error(`Debug configuration not found: ${configName}`);
  const started = await vscode.debug.startDebugging(folder, config as vscode.DebugConfiguration);
  return { started, name: configName };
}

export async function handleDebugStop(): Promise<unknown> {
  const session = vscode.debug.activeDebugSession;
  if (!session) return { stopped: false, reason: "no active session" };
  await vscode.debug.stopDebugging(session);
  return { stopped: true, name: session.name };
}

export async function handleDebugList(): Promise<unknown> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const launch = folder ? vscode.workspace.getConfiguration("launch", folder.uri) : vscode.workspace.getConfiguration("launch");
  const configurations = launch.get<Array<Record<string, unknown>>>("configurations") ?? [];
  const active = vscode.debug.activeDebugSession;
  return {
    configurations: configurations.map((c) => ({ name: c.name, type: c.type, request: c.request })),
    activeSession: active ? { name: active.name, type: active.type, id: active.id } : null,
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
    return {
      sessionId: session.id,
      threadId,
      error: error instanceof Error ? error.message : String(error),
      stackFrames: [],
    };
  }
}
