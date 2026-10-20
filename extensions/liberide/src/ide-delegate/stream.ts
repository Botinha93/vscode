import * as vscode from "vscode";
import { hostname } from "node:os";
import { bearerSubprotocols, getApiOrigin, getAuthToken, onAuthChanged, probeBackend, wsOrigin } from "../api";
import type { IdeHelloParams, JsonRpcRequest } from "@nexus/shared";
import { isJsonRpcRequest } from "@nexus/shared";
import type { IdeDelegateKind, IdeDelegatePayload } from "./types";
import { dispatchIdeDelegate } from "./handlers";
import { currentExtensionVersion, currentMachineId, setWorkspaceId } from "./machine";

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const OUTBOX_LIMIT = 100;
/** Server close codes: bad hello, revoked token/machine, machine revoked or token bound elsewhere. */
const CLOSE_BAD_HELLO = 4400;
const CLOSE_FORBIDDEN = 4403;

type StreamTarget = { userId: string; projectPath: string; sessionId: string; folderName: string };

export class IdeDelegateStream implements vscode.Disposable {
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private ws: WebSocket | undefined;
  /** Set when the server rejected our token; reconnects wait for new credentials. */
  private authBlocked = false;
  /** Requests being handled, by JSON-RPC id, so the server can cancel them. */
  private readonly running = new Map<string, AbortController>();
  /**
   * Responses finished while the socket was down. The server keeps the calls
   * open across a short reconnect, so they are delivered on the next socket.
   */
  private outbox: string[] = [];
  /** API origin of the current socket; a different origin needs a new one. */
  private connectedOrigin: string | undefined;
  private readonly offAuth: () => void;
  private readonly focusSub: vscode.Disposable;

  constructor(
    private readonly target: StreamTarget,
    private readonly output?: vscode.OutputChannel,
  ) {
    this.offAuth = onAuthChanged(() => {
      if (this.closed) return;
      // A refreshed token does not invalidate an open socket (the server
      // re-checks it on its own); reconnecting would drop in-flight calls.
      if (!this.authBlocked && this.ws?.readyState === WebSocket.OPEN && this.connectedOrigin === getApiOrigin()) {
        this.log("credentials changed; keeping the open connection");
        return;
      }
      const wasBlocked = this.authBlocked;
      this.authBlocked = false;
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.log(wasBlocked ? "credentials changed; reconnecting" : "credentials changed; reconnecting with the new token");
      void this.connect();
    });
    this.focusSub = vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) this.announceFocus();
    });
  }

  private helloParams(): IdeHelloParams {
    return {
      machineId: currentMachineId(),
      hostname: hostname(),
      platform: process.platform,
      pathStyle: process.platform === "win32" ? "win" : "posix",
      extensionVersion: currentExtensionVersion(),
      capabilities: {
        trusted: vscode.workspace.isTrusted,
        terminal: typeof vscode.window.createTerminal === "function",
        fs: Boolean(vscode.workspace.fs),
        git: Boolean(vscode.extensions.getExtension("vscode.git")),
      },
      workspace: { rootPath: this.target.projectPath, name: this.target.folderName },
    };
  }

  /** Tell the server this window is in use, so its calls come here. */
  private announceFocus(): void {
    if (!vscode.window.state.focused) return;
    this.sendJson({ jsonrpc: "2.0", method: "window.focus", params: { windowId: vscode.env.sessionId } }, false);
  }

  start(): void {
    if (this.closed) return;
    void this.connect();
  }

  dispose(): void {
    this.closed = true;
    this.offAuth();
    this.focusSub.dispose();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    this.outbox = [];
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
    const protocols = bearerSubprotocols();
    if (!origin || !protocols) return undefined;
    const url = new URL(`${wsOrigin(origin)}/api/ide/rpc`);
    url.searchParams.set("projectPath", this.target.projectPath);
    url.searchParams.set("sessionId", this.target.sessionId);
    // Several windows can serve the same folder; the server routes per window.
    url.searchParams.set("windowId", vscode.env.sessionId);
    // Identifies the machine; the server then waits for `hello` before routing calls here.
    url.searchParams.set("machineId", currentMachineId());
    return { url: url.toString(), protocols };
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
      this.connectedOrigin = getApiOrigin();
      this.log(`IDE RPC connected (${this.target.projectPath})`);
      // Must be the first message on the socket.
      ws.send(JSON.stringify({ jsonrpc: "2.0", method: "hello", params: this.helloParams() }));
      this.announceFocus();
      const pending = this.outbox;
      this.outbox = [];
      for (const message of pending) ws.send(message);
    };

    ws.onmessage = (event) => {
      void this.handleMessage(String(event.data));
    };

    ws.onerror = () => {
      this.log("IDE RPC socket error");
    };

    ws.onclose = (event) => {
      // A superseded socket (reconnect with new credentials) must not reschedule.
      if (this.closed || this.ws !== ws) return;
      this.ws = undefined;
      if (event.code === CLOSE_FORBIDDEN) {
        // Revoked machine, or a token paired to another machine: retrying cannot help.
        this.authBlocked = true;
        this.log(`IDE RPC refused this machine (${event.reason || "forbidden"}); pair again with "LiberIDE: Pair with Server…"`);
        return;
      }
      if (event.code === CLOSE_BAD_HELLO) this.log(`IDE RPC rejected the handshake (${event.reason || "bad hello"})`);
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

  private sendJson(payload: unknown, queueWhileDisconnected = true): void {
    const message = JSON.stringify(payload);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
      return;
    }
    if (!queueWhileDisconnected) return;
    this.outbox.push(message);
    // Bounded: the server stops waiting for these after its reconnect grace.
    if (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
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
      } else if (method === "hello.ack") {
        const workspaceId = (parsed as { params?: { workspaceId?: unknown } }).params?.workspaceId;
        if (typeof workspaceId === "string") {
          setWorkspaceId(this.target.projectPath, workspaceId);
          this.log(`IDE RPC registered as workspace ${workspaceId}`);
        }
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
      target: { userId: this.target.userId, projectPath: this.target.projectPath, sessionId: this.target.sessionId },
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

function streamTarget(folder: vscode.WorkspaceFolder): StreamTarget {
  return {
    userId: "default",
    projectPath: folder.uri.fsPath,
    sessionId: `vscode-${folder.name}`,
    folderName: folder.name,
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
