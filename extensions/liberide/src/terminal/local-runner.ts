import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import type { TerminalDelegateEvent } from "../chat/types";
import { childProcessEnv } from "../api";

export interface LocalTerminalResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled?: boolean;
  signal?: string | null;
}

const MAX_OUTPUT = 100_000;
/** Grace period between SIGTERM and SIGKILL for the process group. */
const KILL_GRACE_MS = 2_000;

/**
 * Bounded output buffer that keeps the head and the tail: build and test
 * failures are usually at the end, so dropping everything after the cap
 * would hide the error that matters.
 */
class OutputBuffer {
  private head = "";
  private tail = "";
  private dropped = 0;

  append(text: string): void {
    const headRoom = MAX_OUTPUT / 2 - this.head.length;
    if (headRoom > 0) {
      this.head += text.slice(0, headRoom);
      text = text.slice(headRoom);
    }
    if (!text) return;
    this.tail += text;
    const excess = this.tail.length - MAX_OUTPUT / 2;
    if (excess > 0) {
      this.dropped += excess;
      this.tail = this.tail.slice(excess);
    }
  }

  toString(): string {
    if (!this.dropped) return this.head + this.tail;
    return `${this.head}\n... [${this.dropped} characters truncated] ...\n${this.tail}`;
  }
}

function shellArgv(command: string): string[] {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return [comspec, "/d", "/s", "/c", command];
  }
  const shell = process.env.SHELL ?? "/bin/sh";
  return [shell, "-c", command];
}

/**
 * Every process group this extension started and that is still running.
 * They are spawned detached (own group, so Stop can kill descendants), which
 * also means they outlive the extension host unless we kill them on the way out.
 */
const liveProcesses = new Set<ChildProcess>();

/** Track a spawned process until it exits, so shutdown can kill its group. */
export function trackProcess(proc: ChildProcess): void {
  liveProcesses.add(proc);
  proc.once("exit", () => liveProcesses.delete(proc));
  proc.once("error", () => liveProcesses.delete(proc));
}

/** Kill every tracked process group immediately (deactivate / host exit). */
export function killAllProcesses(): void {
  for (const proc of liveProcesses) {
    if (proc.pid === undefined || proc.exitCode !== null) continue;
    try {
      if (process.platform === "win32") proc.kill();
      else process.kill(-proc.pid, "SIGKILL");
    } catch {
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
  liveProcesses.clear();
}

// Synchronous last chance when the host exits without calling deactivate.
process.once("exit", killAllProcesses);

/** Signal a process's whole group (POSIX); falls back to the process itself. */
export function signalGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  try {
    if (process.platform === "win32") throw new Error("no process groups");
    process.kill(-proc.pid, signal);
  } catch {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
}

/** Kill the whole tree: `proc.kill()` alone leaves the shell's children running. */
export function killTree(proc: ChildProcess): void {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }).on("error", () => undefined);
    return;
  }
  signalGroup(proc, "SIGTERM");
  setTimeout(() => {
    if (proc.exitCode === null && proc.signalCode === null) signalGroup(proc, "SIGKILL");
  }, KILL_GRACE_MS).unref();
}

export function runLocalTerminal(
  delegate: TerminalDelegateEvent,
  signal?: AbortSignal,
  hooks: { onData?: (text: string, stream: "stdout" | "stderr") => void } = {},
): Promise<LocalTerminalResult> {
  const cwd = path.resolve(delegate.cwd || delegate.projectPath);
  const argv = shellArgv(delegate.command);
  const timeoutMs = delegate.timeoutMs > 0 ? delegate.timeoutMs : 120_000;

  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "Cancelled before start", timedOut: false, cancelled: true });
      return;
    }
    const proc = spawn(argv[0]!, argv.slice(1), {
      cwd,
      // The user's own environment (HOME, git/ssh config, caches) is what a
      // command in their workspace expects, minus LiberIDE credentials.
      env: childProcessEnv(),
      windowsHide: true,
      // Own process group so a timeout or Stop can kill every descendant.
      detached: process.platform !== "win32",
    });
    trackProcess(proc);

    const stdout = new OutputBuffer();
    const stderr = new OutputBuffer();
    let timedOut = false;
    let cancelled = false;
    // setEncoding keeps multi-byte UTF-8 characters intact across chunks.
    proc.stdout?.setEncoding("utf8");
    proc.stderr?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdout.append(chunk);
      hooks.onData?.(chunk, "stdout");
    });
    proc.stderr?.on("data", (chunk: string) => {
      stderr.append(chunk);
      hooks.onData?.(chunk, "stderr");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc);
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killTree(proc);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (result: LocalTerminalResult) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    proc.on("close", (code, killSignal) => {
      finish({
        exitCode: code,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        ...(cancelled ? { cancelled } : {}),
        ...(killSignal ? { signal: killSignal } : {}),
      });
    });

    proc.on("error", (err) => {
      finish({ exitCode: 1, stdout: "", stderr: err.message, timedOut: false });
    });
  });
}
