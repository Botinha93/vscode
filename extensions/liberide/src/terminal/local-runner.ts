import { spawn } from "child_process";
import * as path from "path";
import type { TerminalDelegateEvent } from "../chat/types";

export interface LocalTerminalResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 100_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... [output truncated]`;
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
      resolve({
        exitCode: code,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: err.message,
        timedOut: false,
      });
    });
  });
}
