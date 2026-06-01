import { runLocalTerminal } from "../../terminal/local-runner";

export async function handleTerminalRun(payload: Record<string, unknown>): Promise<unknown> {
  const delegate = {
    delegateId: String(payload.delegateId ?? ""),
    command: String(payload.command ?? ""),
    cwd: String(payload.cwd ?? ""),
    timeoutMs: Number(payload.timeoutMs ?? 120_000),
    projectPath: String(payload.projectPath ?? ""),
    sessionId: payload.sessionId ? String(payload.sessionId) : undefined,
    conversationId: payload.conversationId ? String(payload.conversationId) : undefined,
  };
  return runLocalTerminal(delegate);
}
