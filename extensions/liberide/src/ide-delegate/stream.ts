import * as vscode from "vscode";
import { getApiOrigin, getAuthToken } from "../api";
import type { JsonRpcRequest } from "@nexus/shared";
import { isJsonRpcRequest } from "@nexus/shared";
import type { IdeDelegateKind, IdeDelegatePayload } from "./types";
import { dispatchIdeDelegate } from "./handlers";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

function wsOrigin(httpOrigin: string): string {
  if (httpOrigin.startsWith("https://")) return `wss://${httpOrigin.slice("https://".length)}`;
  if (httpOrigin.startsWith("http://")) return `ws://${httpOrigin.slice("http://".length)}`;
  return httpOrigin;
}

export class IdeDelegateStream implements vscode.Disposable {
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private ws: WebSocket | undefined;

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
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = undefined;
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

  private buildRpcUrl(): string | undefined {
    const origin = getApiOrigin();
    const token = getAuthToken();
    if (!origin || !token) return undefined;
    const url = new URL(`${wsOrigin(origin)}/api/ide/rpc`);
    url.searchParams.set("token", token);
    url.searchParams.set("projectPath", this.target.projectPath);
    url.searchParams.set("sessionId", this.target.sessionId);
    return url.toString();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const rpcUrl = this.buildRpcUrl();
    if (!rpcUrl) {
      this.log("missing API origin or auth token");
      this.scheduleReconnect();
      return;
    }

    try {
      this.ws?.close();
    } catch {
      // ignore
    }

    const ws = new WebSocket(rpcUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.log("IDE RPC connected");
    };

    ws.onmessage = (event) => {
      void this.handleMessage(String(event.data));
    };

    ws.onerror = () => {
      this.log("IDE RPC socket error");
    };

    ws.onclose = () => {
      if (this.closed) return;
      this.log("IDE RPC disconnected");
      this.scheduleReconnect();
    };
  }

  private sendJson(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private async handleMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      if (typeof parsed === "object" && parsed && "method" in parsed && (parsed as { method?: string }).method === "connected") {
        this.log("IDE RPC handshake received");
      }
      return;
    }

    await this.handleRpcRequest(parsed);
  }

  private async handleRpcRequest(request: JsonRpcRequest): Promise<void> {
    const params = (request.params && typeof request.params === "object")
      ? request.params as Record<string, unknown>
      : {};
    const timeoutMs = Number(params.timeoutMs ?? 30_000);
    const delegateRequest: IdeDelegatePayload = {
      delegateId: request.id,
      kind: request.method as IdeDelegateKind,
      payload: {
        ...params,
        delegateId: request.id,
      },
      target: this.target,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
    };

    try {
      const result = await dispatchIdeDelegate(delegateRequest);
      this.sendJson({ jsonrpc: "2.0", id: request.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message },
      });
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
