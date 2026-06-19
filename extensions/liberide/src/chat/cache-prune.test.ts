import { describe, expect, test } from "bun:test";
import {
  buildKeptConversationIds,
  pruneConversationCaches,
  pruneMapKeys,
  pruneObjectKeys,
} from "./cache-prune";

describe("pruneMapKeys", () => {
  test("removes keys not in kept set", () => {
    const map = new Map([["a", 1], ["b", 2], ["c", 3]]);
    pruneMapKeys(map, new Set(["a", "c"]));
    expect([...map.keys()]).toEqual(["a", "c"]);
  });
});

describe("pruneObjectKeys", () => {
  test("removes object keys not in kept set", () => {
    const obj = { a: 1, b: 2, c: 3 };
    pruneObjectKeys(obj, new Set(["b"]));
    expect(obj).toEqual({ b: 2 });
  });
});

describe("buildKeptConversationIds", () => {
  test("includes owned ids, active session, and draft session", () => {
    const kept = buildKeptConversationIds(
      ["conv-1", "conv-2"],
      "draft:abc",
      "draft:abc",
    );
    expect(kept.has("conv-1")).toBe(true);
    expect(kept.has("conv-2")).toBe(true);
    expect(kept.has("draft:abc")).toBe(true);
  });
});

describe("pruneConversationCaches", () => {
  test("preserves draft keys while removing stale conversation entries", () => {
    const messagesCache = new Map([
      ["conv-old", [{ id: "m1" }]],
      ["conv-keep", [{ id: "m2" }]],
      ["draft:xyz", []],
    ]);
    const overrides: Record<string, unknown> = {
      "conv-old": { model: "x" },
      "conv-keep": { model: "y", documentIds: ["doc-keep"] },
      "draft:xyz": { model: "z" },
    };
    const sessionKinds = new Map([
      ["conv-old", "vibe"],
      ["conv-keep", "pipeline"],
      ["draft:xyz", "vibe"],
    ]);
    const consumedPipelineCards = new Map([
      ["conv-old", new Set(["m1"])],
      ["draft:xyz", new Set()],
    ]);
    const attachmentBytes = new Map([
      ["doc-old", { data: new Uint8Array([1]), mimeType: "text/plain", name: "a" }],
      ["doc-keep", { data: new Uint8Array([2]), mimeType: "text/plain", name: "b" }],
    ]);

    const kept = buildKeptConversationIds(["conv-keep"], "draft:xyz", "draft:xyz");
    pruneConversationCaches(kept, {
      messagesCache,
      overrides,
      sessionKinds,
      consumedPipelineCards,
      attachmentBytes,
    });

    expect([...messagesCache.keys()].sort()).toEqual(["conv-keep", "draft:xyz"]);
    expect(Object.keys(overrides).sort()).toEqual(["conv-keep", "draft:xyz"]);
    expect([...sessionKinds.keys()].sort()).toEqual(["conv-keep", "draft:xyz"]);
    expect([...consumedPipelineCards.keys()].sort()).toEqual(["draft:xyz"]);
    expect([...attachmentBytes.keys()]).toEqual(["doc-keep"]);
  });
});
