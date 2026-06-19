import * as vscode from "vscode";
import { getApiOrigin, getAuthToken } from "../api";
import type { IdeNotificationMethod, JsonRpcRequest } from "@nexus/shared";
import { isJsonRpcNotification, isJsonRpcRequest } from "@nexus/shared";
import type { IdeDelegateKind, IdeDelegatePayload } from "./types";
import { dispatchIdeDelegate } from "./handlers";
import { currentIdeUserId, refreshIdeIdentity } from "./identity";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const RPC_SUBPROTOCOL = "liberide.v1";

/** Context attached to every server→IDE notification dispatched to handlers. */
export interface IdeNotificationContext {
  userId: string;
  projectPath: string;
  sessionId: string;
}

export type IdeNotificationHandler = (
  method: IdeNotificationMethod,
  params: Record<string, unknown>,
  context: IdeNotificationContext,
) => void;

function wsOrigin(httpOrigin: string): string {
  if (httpOrigin.startsWith("https://")) return `wss://${httpOrigin.slice("https://".length)}`;
  if (httpOrigin.startsWith("http://")) return `ws://${httpOrigin.slice("http://".length)}`;
  return httpOrigin;
}

/** base64url-encode a token for use as a WebSocket subprotocol (no padding). */
function base64urlEncodeToken(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class IdeDelegateStream implements vscode.Disposable {
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private ws: WebSocket | undefined;
  private authToken?: string;

  constructor(
    private readonly target: { userId: string; projectPath: string; sessionId: string },
    private readonly output?: vscode.OutputChannel,
    private readonly onNotification?: IdeNotificationHandler,
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
    this.authToken = token;
    const url = new URL(`${wsOrigin(origin)}/api/ide/rpc`);
    url.searchParams.set("projectPath", this.target.projectPath);
    url.searchParams.set("sessionId", this.target.sessionId);
    return url.toString();
  }

  private buildSubprotocols(): string[] | undefined {
    if (!this.authToken) return undefined;
    return [RPC_SUBPROTOCOL, `bearer.${base64urlEncodeToken(this.authToken)}`];
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const rpcUrl = this.buildRpcUrl();
    const subprotocols = this.buildSubprotocols();
    if (!rpcUrl || !subprotocols) {
      this.log("missing API origin or auth token");
      this.scheduleReconnect();
      return;
    }

    try {
      this.ws?.close();
    } catch {
      // ignore
    }

    const ws = new WebSocket(rpcUrl, subprotocols);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.log(`IDE RPC connected (${this.target.projectPath})`);
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
      if (isJsonRpcNotification(parsed)) {
        this.dispatchNotification(parsed.method, parsed.params);
      }
      return;
    }

    await this.handleRpcRequest(parsed);
  }

  private dispatchNotification(method: IdeNotificationMethod, rawParams: unknown): void {
    const params = (rawParams && typeof rawParams === "object")
      ? (rawParams as Record<string, unknown>)
      : {};
    if (method === "connected") {
      this.log("IDE RPC handshake received");
    } else {
      this.log(`notification: ${method}`);
    }
    try {
      this.onNotification?.(method, params, this.target);
    } catch (err) {
      this.log(`notification handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
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

class IdeDelegateStreamManager implements vscode.Disposable {
  private readonly streams = new Map<string, IdeDelegateStream>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly output?: vscode.OutputChannel,
    private readonly onNotification?: IdeNotificationHandler,
  ) {
    void refreshIdeIdentity((message) => this.output?.appendLine(`[identity] ${message}`)).finally(() => this.syncStreams());
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncStreams()),
    );
  }

  private syncStreams(): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const nextPaths = new Set(folders.map((f) => f.uri.fsPath));

    for (const [path, stream] of this.streams) {
      if (!nextPaths.has(path)) {
        stream.dispose();
        this.streams.delete(path);
      }
    }

    for (const folder of folders) {
      const path = folder.uri.fsPath;
      if (this.streams.has(path)) continue;
      const stream = new IdeDelegateStream(
        {
          userId: currentIdeUserId(),
          projectPath: path,
          sessionId: `vscode-${folder.name}`,
        },
        this.output,
        this.onNotification,
      );
      stream.start();
      this.streams.set(path, stream);
    }
  }

  dispose(): void {
    for (const stream of this.streams.values()) stream.dispose();
    this.streams.clear();
    for (const d of this.disposables) d.dispose();
  }
}

export function startIdeDelegateStream(
  output?: vscode.OutputChannel,
  onNotification?: IdeNotificationHandler,
): vscode.Disposable {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    let manager: IdeDelegateStreamManager | undefined;
    const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
        sub.dispose();
        manager = new IdeDelegateStreamManager(output, onNotification);
      }
    });
    return vscode.Disposable.from(sub, { dispose: () => manager?.dispose() });
  }
  return new IdeDelegateStreamManager(output, onNotification);
}
