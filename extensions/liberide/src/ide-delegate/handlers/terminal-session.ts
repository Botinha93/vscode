import * as vscode from "vscode";

const MAX_OUTPUT = 100_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... [output truncated]`;
}

export async function handleTerminalSession(payload: Record<string, unknown>): Promise<unknown> {
  const command = String(payload.command ?? "");
  const cwd = String(payload.cwd ?? "");
  const name = String(payload.name ?? "LiberIDE Agent");
  const timeoutMs = Number(payload.timeoutMs ?? 120_000);
  if (!command) throw new Error("command is required");

  const terminal = vscode.window.createTerminal({ name, cwd, hideFromUser: false });
  terminal.show(true);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      disposable.dispose();
      resolve(result);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      disposable.dispose();
      reject(err);
    };

    const disposable = vscode.window.onDidStartTerminalShellExecution(async (event) => {
      if (event.terminal !== terminal) return;
      try {
        const stream = event.execution.read();
        let stdout = "";
        for await (const chunk of stream) {
          stdout += chunk;
        }
        finish({
          exitCode: event.execution.exitCode ?? 0,
          stdout: truncate(stdout),
          stderr: "",
          timedOut: false,
        });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });

    const timer = setTimeout(() => {
      finish({ exitCode: null, stdout: "", stderr: "timed out", timedOut: true });
    }, timeoutMs);

    terminal.sendText(command, true);
  });
}
