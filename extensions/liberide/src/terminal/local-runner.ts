import { spawn } from "child_process";
import * as path from "path";
import type { TerminalDelegateEvent } from "../chat/types";

export interface LocalTerminalResult {
  status: "completed" | "failed" | "timed_out";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  stillRunning?: boolean;
}

const MAX_OUTPUT = 100_000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_OUTPUT)}\n... [output truncated]`, truncated: true };
}

function shellArgv(command: string): { argv: string[]; cwd: string } {
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return { argv: [comspec, "/d", "/s", "/c", command], cwd: "" };
  }
  const shell = process.env.SHELL ?? "/bin/sh";
  return { argv: [shell, "-c", command], cwd: "" };
}

export function runLocalTerminal(delegate: TerminalDelegateEvent): Promise<LocalTerminalResult> {
  const cwd = path.resolve(delegate.cwd || delegate.projectPath);
  const { argv } = shellArgv(delegate.command);
  const timeoutMs = delegate.timeoutMs > 0 ? delegate.timeoutMs : 120_000;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(argv[0], argv.slice(1), {
      cwd,
      env: {
        ...process.env,
        HOME: delegate.projectPath,
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const out = truncate(stdout);
      const err = truncate(stderr);
      resolve({
        status: timedOut ? "timed_out" : code === 0 ? "completed" : "failed",
        exitCode: code,
        stdout: out.text,
        stderr: err.text,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated: out.truncated || err.truncated,
        stillRunning: false,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        status: "failed",
        exitCode: 1,
        stdout: "",
        stderr: err.message,
        timedOut: false,
        durationMs: Date.now() - startedAt,
        truncated: false,
        stillRunning: false,
      });
    });
  });
}
