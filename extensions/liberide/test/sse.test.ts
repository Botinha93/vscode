import { describe, expect, test } from "bun:test";
import { readSseStream } from "../src/sse";

function body(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readSseStream", () => {
  test("drops a frame that grows past the limit before it ends, and keeps delivering the rest", async () => {
    const huge = "x".repeat(4_400_000);
    const events: string[] = [];
    let oversized = 0;
    await readSseStream(body([
      "event: token\ndata: {\"token\":\"a\"}\n\n",
      `event: token\ndata: {"token":"${huge.slice(0, 2_100_000)}`,
      huge.slice(2_100_000, 4_200_000),
      `${huge.slice(4_200_000)}"}\n\n`,
      "event: token\ndata: {\"token\":\"b\"}\n\n",
    ]), (event) => { events.push(String((event.data as { token: string }).token)); }, { onOversizedFrame: () => { oversized += 1; } });
    expect(events).toEqual(["a", "b"]);
    expect(oversized).toBe(1);
  });
});
