import * as path from "node:path";
import { runLocalTerminal } from "../../terminal/local-runner";
import {
  agentOutputView,
  closeAgentTerminal,
  openAgentTerminal,
  readAgentTerminal,
  sendToAgentTerminal,
} from "../../terminal/agent-terminals";

/** `cwd` from the server, resolved against (and kept inside) the socket's folder. */
function cwdInside(root: string, requested: unknown): string {
  const base = path.resolve(root);
  const cwd = path.resolve(base, typeof requested === "string" && requested ? requested : ".");
  const rel = path.relative(base, cwd);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Terminal cwd is outside the workspace folder");
  }
  return cwd;
}

function requireSessionId(payload: Record<string, unknown>): string {
  const id = String(payload.sessionId ?? "");
  if (!id) throw new Error("sessionId is required");
  return id;
}

/**
 * One command in a visible agent terminal tab, with its real exit code and
 * separate stdout/stderr. The tab is reused per name instead of opening a new
 * terminal for every call.
 */
export async function handleTerminalSession(root: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const command = String(payload.command ?? "");
  if (!command) throw new Error("command is required");
  const cwd = cwdInside(root, payload.cwd);
  const name = String(payload.name ?? "LiberIDE Agent");
  const timeoutMs = Number(payload.timeoutMs ?? 120_000);
  const view = agentOutputView(name);
  view.write(`\x1b[36m$ ${command}\x1b[0m\n`);
  const result = await runLocalTerminal(
    { delegateId: String(payload.delegateId ?? ""), command, cwd, timeoutMs, projectPath: root },
    signal,
    { onData: (text, stream) => view.write(stream === "stderr" ? `\x1b[31m${text}\x1b[0m` : text) },
  );
  const status = result.timedOut ? "timed out" : result.cancelled ? "cancelled" : `exit code ${result.exitCode}`;
  view.write(`\x1b[2m[${status}]\x1b[0m\n\n`);
  return { ...result, visibleTerminal: true };
}

export async function handleTerminalSessionOpen(root: string, payload: Record<string, unknown>): Promise<unknown> {
  return openAgentTerminal({
    name: String(payload.name ?? "LiberIDE Session"),
    cwd: cwdInside(root, payload.cwd),
  });
}

export async function handleTerminalSessionSend(payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const input = String(payload.input ?? "");
  const waitMs = payload.waitMs === undefined ? undefined : Number(payload.waitMs);
  return sendToAgentTerminal(requireSessionId(payload), input, {
    addNewline: payload.addNewline !== false,
    waitMs: Number.isFinite(waitMs) ? waitMs : undefined,
    signal,
  });
}

export async function handleTerminalSessionRead(payload: Record<string, unknown>): Promise<unknown> {
  return readAgentTerminal(requireSessionId(payload), payload.fromStart === true);
}

export async function handleTerminalSessionClose(payload: Record<string, unknown>): Promise<unknown> {
  return closeAgentTerminal(requireSessionId(payload));
}
