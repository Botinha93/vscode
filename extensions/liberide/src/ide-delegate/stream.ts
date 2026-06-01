import * as vscode from "vscode";
import { apiFetch, getApiOrigin, getAuthToken } from "../api";
import type { IdeDelegatePayload } from "./types";
import { dispatchIdeDelegate } from "./handlers";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

export class IdeDelegateStream implements vscode.Disposable {
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private abort?: AbortController;

  constructor(
    private readonly target: { userId: string; projectPath: string; sessionId: string },
    private readonly output?: vscode.OutputChannel,
  ) {}

  start(): void {
    if (this.closed) return;
    void this.connect();
  }

  dispose(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.abort?.abort();
  }

  private log(message: string): void {
    this.output?.appendLine(`[ide-delegate] ${message}`);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private async connect(): Promise<void> {
    if (this.closed || !getApiOrigin()) return;
    this.abort?.abort();
    this.abort = new AbortController();
    const params = new URLSearchParams({
      projectPath: this.target.projectPath,
      sessionId: this.target.sessionId,
    });
    try {
      const response = await fetch(`${getApiOrigin()}/api/ide/delegate/stream?${params.toString()}`, {
        headers: {
          Accept: "text/event-stream",
          ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
        },
        signal: this.abort.signal,
      });
      if (!response.ok || !response.body) {
        this.log(`stream failed: ${response.status}`);
        this.scheduleReconnect();
        return;
      }
      this.reconnectAttempt = 0;
      this.log("delegate stream connected");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          await this.consumeEvent(part);
        }
      }
    } catch (err) {
      if (!this.closed && !(err instanceof DOMException && err.name === "AbortError")) {
        this.log(err instanceof Error ? err.message : String(err));
      }
    }
    if (!this.closed) this.scheduleReconnect();
  }

  private async consumeEvent(raw: string): Promise<void> {
    const event = raw.match(/^event: (.+)$/m)?.[1];
    const dataLine = raw.match(/^data: (.+)$/m)?.[1];
    if (!event || !dataLine) return;
    if (event !== "delegate") return;
    let request: IdeDelegatePayload;
    try {
      request = JSON.parse(dataLine) as IdeDelegatePayload;
    } catch {
      return;
    }
    try {
      const result = await dispatchIdeDelegate(request);
      await apiFetch(`/api/ide/delegate/${encodeURIComponent(request.delegateId)}/complete`, {
        method: "POST",
        body: JSON.stringify({ ok: true, result }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await apiFetch(`/api/ide/delegate/${encodeURIComponent(request.delegateId)}/complete`, {
        method: "POST",
        body: JSON.stringify({ ok: false, error: message }),
      }).catch(() => undefined);
    }
  }
}

export function startIdeDelegateStream(output?: vscode.OutputChannel): vscode.Disposable {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (vscode.workspace.workspaceFolders?.[0]) {
        sub.dispose();
        startIdeDelegateStream(output);
      }
    });
    return sub;
  }
  const stream = new IdeDelegateStream(
    {
      userId: "default",
      projectPath: folder.uri.fsPath,
      sessionId: `vscode-${folder.name}`,
    },
    output,
  );
  stream.start();
  const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    stream.dispose();
    startIdeDelegateStream(output);
  });
  return vscode.Disposable.from(stream, folderSub);
}
