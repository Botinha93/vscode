import * as path from "node:path";
import { runLocalTerminal } from "../../terminal/local-runner";

export async function handleTerminalRun(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const delegate = {
    delegateId: String(payload.delegateId ?? ""),
    command: String(payload.command ?? ""),
    cwd: String(payload.cwd ?? ""),
    timeoutMs: Number(payload.timeoutMs ?? 120_000),
    projectPath: String(payload.projectPath ?? ""),
    sessionId: payload.sessionId ? String(payload.sessionId) : undefined,
    conversationId: payload.conversationId ? String(payload.conversationId) : undefined,
  };
  // The server resolves cwd against the same folder path; refuse anything that
  // points outside the folder this socket serves.
  const root = path.resolve(delegate.projectPath);
  const cwd = path.resolve(root, delegate.cwd || ".");
  const rel = path.relative(root, cwd);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("terminal.run cwd is outside the workspace folder");
  }
  return runLocalTerminal({ ...delegate, cwd }, signal);
}
