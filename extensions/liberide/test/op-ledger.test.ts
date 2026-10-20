import { describe, expect, mock, test } from "bun:test";
import { vscodeMock } from "./vscode-mock";

mock.module("vscode", () => ({
  ...vscodeMock,
  window: { ...vscodeMock.window, state: { focused: false }, onDidChangeWindowState: () => ({ dispose: () => undefined }) },
}));

const handled: Array<{ id: string; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
mock.module("../src/ide-delegate/handlers", () => ({
  dispatchIdeDelegate: (request: { delegateId: string }) =>
    new Promise((resolve, reject) => handled.push({ id: request.delegateId, resolve, reject })),
}));

const { IdeDelegateStream } = await import("../src/ide-delegate/stream");
const { OpLedger } = await import("../src/ide-delegate/op-ledger");

type Sent = { id: string; result?: unknown; error?: { message: string } };

/** A stream with no socket: responses land in its outbox. */
function offlineStream() {
  const stream = new IdeDelegateStream({ userId: "u", projectPath: "/p", sessionId: "s", folderName: "p" });
  const internals = stream as unknown as { handleMessage: (raw: string) => Promise<void>; outbox: string[] };
  return {
    stream,
    request: (id: string, opId?: string) =>
      internals.handleMessage(JSON.stringify({ jsonrpc: "2.0", id, method: "vscode.fs.write", params: { path: "a" }, ...(opId ? { opId } : {}) })),
    sent: () => internals.outbox.map((raw) => JSON.parse(raw) as Sent),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("durable operation ids", () => {
  test("the same opId twice runs the handler once and both get its result", async () => {
    handled.length = 0;
    const { stream, request, sent } = offlineStream();
    const first = request("r1", "run:call-a");
    await flush();
    handled[0]!.resolve({ written: 1 });
    await first;
    await request("r2", "run:call-a");
    expect(handled.length).toBe(1);
    expect(sent()).toEqual([
      { jsonrpc: "2.0", id: "r1", result: { written: 1 } } as Sent,
      { jsonrpc: "2.0", id: "r2", result: { written: 1 } } as Sent,
    ]);
    stream.dispose();
  });

  test("a concurrent duplicate attaches to the running execution", async () => {
    handled.length = 0;
    const { stream, request, sent } = offlineStream();
    const first = request("c1", "run:call-b");
    const second = request("c2", "run:call-b");
    await flush();
    expect(handled.length).toBe(1);
    handled[0]!.reject(new Error("disk full"));
    await Promise.all([first, second]);
    expect(sent().map((message) => [message.id, message.error?.message])).toEqual([["c1", "disk full"], ["c2", "disk full"]]);
    stream.dispose();
  });

  test("requests without an opId keep running per id", async () => {
    handled.length = 0;
    const { stream, request } = offlineStream();
    const runs = [request("n1"), request("n2")];
    await flush();
    expect(handled.length).toBe(2);
    for (const entry of handled) entry.resolve(null);
    await Promise.all(runs);
    stream.dispose();
  });
});

describe("OpLedger", () => {
  test("entries expire after the TTL and the oldest is evicted past the limit", async () => {
    let now = 0;
    const ledger = new OpLedger(2, 1_000, () => now);
    let runs = 0;
    const execute = async () => ({ ok: true as const, result: ++runs });
    await ledger.run("a", execute).outcome;
    expect(ledger.run("a", execute).replayed).toBe(true);
    now = 1_001;
    expect(ledger.run("a", execute).replayed).toBe(false);
    await flush();
    await ledger.run("b", execute).outcome;
    await ledger.run("c", execute).outcome;
    expect(ledger.size).toBe(2);
    expect(ledger.run("a", execute).replayed).toBe(false);
  });

  test("a retryable outcome (cancelled run) is not kept", async () => {
    const ledger = new OpLedger();
    await ledger.run("x", async () => ({ ok: false as const, message: "cancelled" }), () => true).outcome;
    await flush();
    expect(ledger.run("x", async () => ({ ok: true as const, result: 1 })).replayed).toBe(false);
  });
});
