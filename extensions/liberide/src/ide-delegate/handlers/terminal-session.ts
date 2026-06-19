import * as vscode from "vscode";
import { randomUUID } from "node:crypto";

const MAX_OUTPUT = 100_000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_OUTPUT)}\n... [output truncated]`, truncated: true };
}

// ---------------------------------------------------------------------------
// Persistent terminal sessions (T3.1)
// ---------------------------------------------------------------------------

interface PersistentSession {
  id: string;
  terminal: vscode.Terminal;
  buffer: string;
  /** Read cursor so each read returns only newly captured output. */
  readOffset: number;
  lastActivity: number;
  disposables: vscode.Disposable[];
  closed: boolean;
}

const SESSION_IDLE_MS = 30 * 60_000;
const SESSION_GC_INTERVAL_MS = 5 * 60_000;
const sessions = new Map<string, PersistentSession>();
let gcTimer: ReturnType<typeof setInterval> | undefined;

function appendToSession(session: PersistentSession, chunk: string): void {
  session.buffer += chunk;
  if (session.buffer.length > MAX_OUTPUT * 4) {
    // Keep the tail; advance the read offset so reads stay consistent.
    const drop = session.buffer.length - MAX_OUTPUT * 4;
    session.buffer = session.buffer.slice(drop);
    session.readOffset = Math.max(0, session.readOffset - drop);
  }
  session.lastActivity = Date.now();
}

function disposeSession(session: PersistentSession): void {
  session.closed = true;
  for (const d of session.disposables) {
    try {
      d.dispose();
    } catch {
      // ignore
    }
  }
  try {
    session.terminal.dispose();
  } catch {
    // ignore
  }
  sessions.delete(session.id);
}

function ensureGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const session of [...sessions.values()]) {
      if (now - session.lastActivity > SESSION_IDLE_MS) disposeSession(session);
    }
    if (sessions.size === 0 && gcTimer) {
      clearInterval(gcTimer);
      gcTimer = undefined;
    }
  }, SESSION_GC_INTERVAL_MS);
  // Don't keep the extension host alive solely for GC.
  (gcTimer as unknown as { unref?: () => void }).unref?.();
}

export async function handleTerminalSessionOpen(payload: Record<string, unknown>): Promise<unknown> {
  const name = String(payload.name ?? "LiberIDE Session");
  const cwd = payload.cwd ? String(payload.cwd) : undefined;
  const id = randomUUID();
  const terminal = vscode.window.createTerminal({ name: `${name} (${id.slice(0, 6)})`, cwd, hideFromUser: false });
  terminal.show(true);

  const session: PersistentSession = {
    id,
    terminal,
    buffer: "",
    readOffset: 0,
    lastActivity: Date.now(),
    disposables: [],
    closed: false,
  };

  session.disposables.push(
    vscode.window.onDidStartTerminalShellExecution(async (event) => {
      if (event.terminal !== terminal) return;
      try {
        for await (const chunk of event.execution.read()) {
          appendToSession(session, chunk);
        }
      } catch {
        // execution read errors are non-fatal for a persistent session
      }
    }),
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal && !session.closed) disposeSession(session);
    }),
  );

  sessions.set(id, session);
  ensureGc();
  return { sessionId: id, name, cwd: cwd ?? null };
}

export async function handleTerminalSessionSend(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId ?? "");
  const input = String(payload.input ?? payload.command ?? "");
  const addNewline = payload.addNewline !== false;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown terminal session: ${sessionId}`);
  session.terminal.show(true);
  session.terminal.sendText(input, addNewline);
  session.lastActivity = Date.now();
  return { sessionId, sent: true };
}

export async function handleTerminalSessionRead(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId ?? "");
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown terminal session: ${sessionId}`);
  const fromStart = payload.fromStart === true;
  const slice = fromStart ? session.buffer : session.buffer.slice(session.readOffset);
  session.readOffset = session.buffer.length;
  session.lastActivity = Date.now();
  const out = truncate(slice);
  return { sessionId, output: out.text, truncated: out.truncated, alive: true };
}

export async function handleTerminalSessionClose(payload: Record<string, unknown>): Promise<unknown> {
  const sessionId = String(payload.sessionId ?? "");
  const session = sessions.get(sessionId);
  if (!session) return { sessionId, closed: false, note: "session not found (already closed?)" };
  disposeSession(session);
  return { sessionId, closed: true };
}

export async function handleTerminalSession(payload: Record<string, unknown>): Promise<unknown> {
  const command = String(payload.command ?? "");
  const cwd = String(payload.cwd ?? "");
  const name = String(payload.name ?? "LiberIDE Agent");
  const timeoutMs = Number(payload.timeoutMs ?? 120_000);
  if (!command) throw new Error("command is required");
  const startedAt = Date.now();

  const terminal = vscode.window.createTerminal({ name, cwd, hideFromUser: false });
  terminal.show(true);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    // The execution started for THIS terminal; the exit code is only available
    // from the `onDidEndTerminalShellExecution` event (not on the execution
    // object itself), so track the execution and resolve when it ends.
    let tracked: vscode.TerminalShellExecution | undefined;

    const disposables: vscode.Disposable[] = [];
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const d of disposables) d.dispose();
      resolve(result);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const d of disposables) d.dispose();
      reject(err);
    };

    disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (event) => {
        if (event.terminal !== terminal || tracked) return;
        tracked = event.execution;
        try {
          for await (const chunk of event.execution.read()) {
            stdout += chunk;
          }
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      }),
    );

    disposables.push(
      vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.terminal !== terminal || (tracked && event.execution !== tracked)) return;
        const out = truncate(stdout);
        finish({
          status: event.exitCode === 0 ? "completed" : "failed",
          exitCode: event.exitCode ?? 0,
          stdout: out.text,
          stderr: "",
          timedOut: false,
          durationMs: Date.now() - startedAt,
          truncated: out.truncated,
          stillRunning: false,
        });
      }),
    );

    const timer = setTimeout(() => {
      const out = truncate(stdout);
      terminal.sendText("\u0003", false);
      finish({
        status: "timed_out",
        exitCode: null,
        stdout: out.text,
        stderr: "timed out; sent interrupt to visible terminal",
        timedOut: true,
        durationMs: Date.now() - startedAt,
        truncated: out.truncated,
        stillRunning: "unknown",
      });
    }, timeoutMs);

    terminal.sendText(command, true);
  });
}
