import * as vscode from "vscode";
import { getApiOrigin, getAuthToken, onAuthChanged, probeBackend } from "../api";
import type { JsonRpcRequest } from "@nexus/shared";
import { isJsonRpcRequest } from "@nexus/shared";
import type { IdeDelegateKind, IdeDelegatePayload } from "./types";
import { dispatchIdeDelegate } from "./handlers";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
/** Must match IDE_RPC_SUBPROTOCOL on the server; echoed back on a bearer handshake. */
const IDE_RPC_SUBPROTOCOL = "liberide.v1";

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
  /** Set when the server rejected our token; reconnects wait for new credentials. */
  private authBlocked = false;
  /** Requests being handled, by JSON-RPC id, so the server can cancel them. */
  private readonly running = new Map<string, AbortController>();
  private readonly offAuth: () => void;

  constructor(
    private readonly target: { userId: string; projectPath: string; sessionId: string },
    private readonly output?: vscode.OutputChannel,
  ) {
    this.offAuth = onAuthChanged(() => {
      if (this.closed) return;
      const wasBlocked = this.authBlocked;
      this.authBlocked = false;
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.log(wasBlocked ? "credentials changed; reconnecting" : "credentials changed; reconnecting with the new token");
      void this.connect();
    });
  }

  start(): void {
    if (this.closed) return;
    void this.connect();
  }

  dispose(): void {
    this.closed = true;
    this.offAuth();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
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
    if (this.closed || this.authBlocked) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  /** The token travels in the `bearer.<base64url>` subprotocol, never in the URL. */
  private buildRpcRequest(): { url: string; protocols: string[] } | undefined {
    const origin = getApiOrigin();
    const token = getAuthToken();
    if (!origin || !token) return undefined;
    const url = new URL(`${wsOrigin(origin)}/api/ide/rpc`);
    url.searchParams.set("projectPath", this.target.projectPath);
    url.searchParams.set("sessionId", this.target.sessionId);
    return { url: url.toString(), protocols: [IDE_RPC_SUBPROTOCOL, `bearer.${base64url(token)}`] };
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const request = this.buildRpcRequest();
    if (!request) {
      this.log("missing API origin or auth token; waiting for credentials");
      // onAuthChanged reconnects as soon as the integration file provides them.
      this.authBlocked = !getAuthToken();
      this.scheduleReconnect();
      return;
    }

    const previous = this.ws;
    this.ws = undefined;
    try {
      previous?.close();
    } catch {
      // ignore
    }

    let opened = false;
    const ws = new WebSocket(request.url, request.protocols);
    this.ws = ws;

    ws.onopen = () => {
      opened = true;
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
      // A superseded socket (reconnect with new credentials) must not reschedule.
      if (this.closed || this.ws !== ws) return;
      this.ws = undefined;
      if (opened) {
        this.log("IDE RPC disconnected");
        this.scheduleReconnect();
        return;
      }
      // The handshake failed. Browsers' WebSocket hides the HTTP status, so
      // probe the REST API to tell a rejected token from a network error.
      void probeBackend().then((reachability) => {
        if (this.closed || this.ws) return;
        if (reachability === "unauthorized") {
          this.authBlocked = true;
          this.log("IDE RPC rejected the auth token (401); waiting for re-authentication");
          return;
        }
        this.log(`IDE RPC handshake failed (${reachability})`);
        this.scheduleReconnect();
      });
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
      const method = typeof parsed === "object" && parsed && "method" in parsed ? (parsed as { method?: string }).method : undefined;
      if (method === "connected") {
        this.log("IDE RPC handshake received");
      } else if (method === "$/cancelRequest") {
        const id = String((parsed as { params?: { id?: unknown } }).params?.id ?? "");
        const controller = this.running.get(id);
        if (controller) {
          this.log(`cancelling request ${id}`);
          controller.abort();
        }
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
    // A retransmitted id must not run the same command twice.
    if (this.running.has(request.id)) return;
    const controller = new AbortController();
    this.running.set(request.id, controller);
    const delegateRequest: IdeDelegatePayload = {
      delegateId: request.id,
      kind: request.method as IdeDelegateKind,
      payload: {
        ...params,
        delegateId: request.id,
      },
      target: this.target,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30_000,
      signal: controller.signal,
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
    } finally {
      this.running.delete(request.id);
    }
  }
}

function streamTarget(folder: vscode.WorkspaceFolder): { userId: string; projectPath: string; sessionId: string } {
  return {
    userId: "default",
    projectPath: folder.uri.fsPath,
    sessionId: `vscode-${folder.name}`,
  };
}

/**
 * Serve IDE delegate RPC for every workspace folder: one socket per folder,
 * added and disposed as folders come and go.
 */
export function startIdeDelegateStream(output?: vscode.OutputChannel): vscode.Disposable {
  const streams = new Map<string, IdeDelegateStream>();

  const sync = () => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const wanted = new Map(folders.map((folder) => [folder.uri.fsPath, folder] as const));
    for (const [path, stream] of streams) {
      if (wanted.has(path)) continue;
      stream.dispose();
      streams.delete(path);
    }
    for (const [path, folder] of wanted) {
      if (streams.has(path)) continue;
      const stream = new IdeDelegateStream(streamTarget(folder), output);
      streams.set(path, stream);
      stream.start();
    }
  };

  sync();
  const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(sync);
  return new vscode.Disposable(() => {
    folderSub.dispose();
    for (const stream of streams.values()) stream.dispose();
    streams.clear();
  });
}
