import * as vscode from "vscode";
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { killAllProcesses, killTree, signalGroup, trackProcess } from "./local-runner";
import { childProcessEnv } from "../api";

/**
 * Terminals the agent drives.
 *
 * VS Code only exposes a terminal's output through shell-integration events,
 * which never fire when shell integration is unavailable. So agent terminals
 * are pseudoterminals backed by a process this extension spawns: output is
 * captured reliably, exit codes are real, Stop kills the whole process group,
 * and the user still sees (and can type into) a normal terminal tab.
 */

const MAX_SESSIONS = 8;
/** Output kept per session; older output is dropped (and reported as dropped). */
const MAX_BUFFER_CHARS = 1_000_000;
/** Largest chunk returned by one read. */
const MAX_READ_CHARS = 100_000;
const SESSION_IDLE_TTL_MS = 30 * 60_000;
/** After a send, wait for output to go quiet this long before returning it. */
const SETTLE_QUIET_MS = 400;
const DEFAULT_SEND_WAIT_MS = 2_000;
/** An ended session stays readable (final output, exit code) this long. */
const EXITED_SESSION_TTL_MS = 2 * 60_000;
const MAX_SEND_WAIT_MS = 30_000;

/** Terminals render CRLF; child output uses bare LF. */
function toTerminalText(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

/** A visible terminal tab we write to. Writes before the tab opens are queued. */
class TerminalView implements vscode.Disposable {
  readonly terminal: vscode.Terminal;
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private pending: string[] | undefined = [];
  closedByUser = false;

  constructor(name: string, handlers: { onInput?: (data: string) => void; onClose?: () => void } = {}) {
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this.writeEmitter.event,
      open: () => {
        const queued = this.pending ?? [];
        this.pending = undefined;
        for (const chunk of queued) this.writeEmitter.fire(chunk);
      },
      close: () => {
        this.closedByUser = true;
        handlers.onClose?.();
      },
      handleInput: handlers.onInput,
    };
    this.terminal = vscode.window.createTerminal({ name, pty });
  }

  write(text: string): void {
    const chunk = toTerminalText(text);
    if (this.pending) this.pending.push(chunk);
    else this.writeEmitter.fire(chunk);
  }

  dispose(): void {
    // A tab the user closed is already gone; only the emitter is left.
    if (!this.closedByUser) this.terminal.dispose();
    this.writeEmitter.dispose();
  }
}

/** Append-only text with a fixed window; offsets stay absolute across drops. */
class RollingBuffer {
  private text = "";
  private base = 0;

  append(chunk: string): void {
    this.text += chunk;
    const excess = this.text.length - MAX_BUFFER_CHARS;
    if (excess > 0) {
      this.text = this.text.slice(excess);
      this.base += excess;
    }
  }

  get end(): number {
    return this.base + this.text.length;
  }

  /** Text from absolute offset `from`, capped to the newest MAX_READ_CHARS. */
  since(from: number): { text: string; skipped: number } {
    let start = Math.max(from, this.base);
    let skipped = start - from;
    if (this.end - start > MAX_READ_CHARS) {
      skipped += this.end - MAX_READ_CHARS - start;
      start = this.end - MAX_READ_CHARS;
    }
    return { text: this.text.slice(start - this.base), skipped };
  }
}

function shellCommand(): { command: string; args: string[] } {
  if (process.platform === "win32") return { command: process.env.ComSpec ?? "cmd.exe", args: ["/Q", "/K"] };
  return { command: process.env.SHELL || "/bin/sh", args: [] };
}

export interface SessionReadResult {
  sessionId: string;
  output: string;
  /** Characters that were dropped between this read and the previous one. */
  skippedChars?: number;
  running: boolean;
  exitCode?: number | null;
}

class AgentTerminalSession {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  lastUsedAt = Date.now();
  exitedAt: number | undefined;
  private closed = false;
  private readonly proc: ChildProcess;
  private readonly view: TerminalView;
  private readonly buffer = new RollingBuffer();
  private cursor = 0;
  private exited = false;
  private exitCode: number | null | undefined;
  private lineBuffer = "";
  private readonly outputListeners = new Set<() => void>();

  constructor(readonly name: string, readonly cwd: string, private readonly onDisposed: (id: string) => void) {
    this.view = new TerminalView(name, {
      onInput: (data) => this.handleUserInput(data),
      onClose: () => this.close(),
    });
    const shell = shellCommand();
    this.proc = spawn(shell.command, shell.args, {
      cwd,
      env: childProcessEnv(),
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    trackProcess(this.proc);
    // Ctrl+C signals the whole process group; a trapped (not ignored) INT
    // keeps the shell alive while its children get the default action.
    if (process.platform !== "win32") this.proc.stdin?.write("trap : INT\n");
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stderr?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => this.output(chunk));
    this.proc.stderr?.on("data", (chunk: string) => this.output(chunk));
    this.proc.on("close", (code) => {
      this.exited = true;
      this.exitedAt = Date.now();
      this.exitCode = code;
      this.view.write(`\n\x1b[2m[session ended${code === null ? "" : ` with exit code ${code}`}]\x1b[0m\n`);
      this.notify();
    });
    this.proc.on("error", (err) => {
      this.exited = true;
      this.exitedAt = Date.now();
      this.exitCode = null;
      this.output(`${err.message}\n`);
    });
    this.view.write(`\x1b[2m[LiberIDE agent session · ${cwd}]\x1b[0m\n`);
    this.view.terminal.show(true);
  }

  get running(): boolean {
    return !this.exited;
  }

  private output(chunk: string): void {
    this.buffer.append(chunk);
    this.view.write(chunk);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.outputListeners) listener();
  }

  /** Keys typed by the user: a pipe has no line discipline, so edit and echo here. */
  private handleUserInput(data: string): void {
    for (const ch of data) {
      if (ch === "\r") {
        this.view.write("\n");
        this.writeStdin(`${this.lineBuffer}\n`);
        this.lineBuffer = "";
      } else if (ch === "\x7f") {
        if (this.lineBuffer) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
          this.view.write("\b \b");
        }
      } else if (ch === "\x03") {
        this.interrupt();
        this.lineBuffer = "";
      } else if (ch >= " " || ch === "\t") {
        this.lineBuffer += ch;
        this.view.write(ch);
      }
    }
  }

  /** Ctrl+C: SIGINT to the process group (grandchildren too); the shell traps it and keeps running. */
  interrupt(): void {
    if (this.exited || this.proc.pid === undefined) return;
    if (process.platform === "win32") return;
    signalGroup(this.proc, "SIGINT");
  }

  private writeStdin(text: string): void {
    if (this.exited) throw new Error("Terminal session has ended");
    this.proc.stdin?.write(text);
  }

  /** Send input as the agent, then wait briefly for output to settle and return it. */
  async send(input: string, options: { addNewline: boolean; waitMs?: number; signal?: AbortSignal }): Promise<SessionReadResult> {
    this.lastUsedAt = Date.now();
    const text = options.addNewline ? `${input}\n` : input;
    // Show what the agent typed, dimmed, so the user can follow along.
    this.view.write(`\x1b[36m${text}\x1b[0m`);
    const before = this.buffer.end;
    this.writeStdin(text);
    await this.waitForOutput(before, Math.min(options.waitMs ?? DEFAULT_SEND_WAIT_MS, MAX_SEND_WAIT_MS), options.signal);
    return this.read(false);
  }

  private waitForOutput(since: number, maxWaitMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        clearTimeout(deadline);
        if (quietTimer) clearTimeout(quietTimer);
        this.outputListeners.delete(onOutput);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const onOutput = () => {
        if (this.exited) return done();
        if (this.buffer.end === since) return;
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(done, SETTLE_QUIET_MS);
      };
      const deadline = setTimeout(done, maxWaitMs);
      this.outputListeners.add(onOutput);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  read(fromStart: boolean): SessionReadResult {
    this.lastUsedAt = Date.now();
    const { text, skipped } = this.buffer.since(fromStart ? 0 : this.cursor);
    this.cursor = this.buffer.end;
    return {
      sessionId: this.id,
      output: text,
      ...(skipped > 0 ? { skippedChars: skipped } : {}),
      running: this.running,
      ...(this.exited ? { exitCode: this.exitCode ?? null } : {}),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    killTree(this.proc);
    this.notify();
    this.outputListeners.clear();
    this.view.dispose();
    this.onDisposed(this.id);
  }
}

const sessions = new Map<string, AgentTerminalSession>();

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (now - session.lastUsedAt > SESSION_IDLE_TTL_MS) session.close();
    else if (session.exitedAt !== undefined && now - session.exitedAt > EXITED_SESSION_TTL_MS) session.close();
  }
}, 30_000);
sweeper.unref?.();

function sessionFor(id: string): AgentTerminalSession {
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown terminal session: ${id}. Open one with the terminal open tool first.`);
  return session;
}

export function openAgentTerminal(input: { name: string; cwd: string }): { sessionId: string; name: string; cwd: string } {
  // Ended sessions go first, then the least recently used one, rather than refusing.
  for (const session of [...sessions.values()]) if (!session.running) session.close();
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    oldest?.close();
  }
  const session = new AgentTerminalSession(input.name, input.cwd, (id) => sessions.delete(id));
  sessions.set(session.id, session);
  return { sessionId: session.id, name: input.name, cwd: input.cwd };
}

export function sendToAgentTerminal(id: string, input: string, options: { addNewline: boolean; waitMs?: number; signal?: AbortSignal }): Promise<SessionReadResult> {
  return sessionFor(id).send(input, options);
}

export function readAgentTerminal(id: string, fromStart: boolean): SessionReadResult {
  return sessionFor(id).read(fromStart);
}

export function closeAgentTerminal(id: string): { sessionId: string; closed: boolean } {
  sessionFor(id).close();
  return { sessionId: id, closed: true };
}

export function disposeAgentTerminals(): void {
  clearInterval(sweeper);
  killAllProcesses();
  for (const session of [...sessions.values()]) session.close();
  for (const view of outputViews.values()) view.dispose();
  outputViews.clear();
}

/** Reusable output tabs for one-shot agent commands, by name. */
const outputViews = new Map<string, TerminalView>();

/** A visible tab for one-shot command output; recreated if the user closed it. */
export function agentOutputView(name: string): { write: (text: string) => void } {
  let view = outputViews.get(name);
  if (!view || view.closedByUser) {
    view?.dispose();
    const created = new TerminalView(name, {
      onClose: () => {
        outputViews.delete(name);
        created.dispose();
      },
    });
    view = created;
    outputViews.set(name, view);
  }
  view.terminal.show(true);
  return view;
}
