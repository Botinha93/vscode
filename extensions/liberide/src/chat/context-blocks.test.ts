import { describe, expect, test } from "bun:test";
import { enrichMessageWithContext, toChips, type ContextBlock } from "./context-blocks";

const block = (over: Partial<ContextBlock> & { id: string }): ContextBlock => ({
  kind: "file",
  label: over.id,
  content: "x",
  ...over,
});

describe("enrichMessageWithContext", () => {
  test("returns content unchanged when no blocks", () => {
    expect(enrichMessageWithContext("hello", [])).toBe("hello");
  });

  test("prepends labeled fenced blocks before the message", () => {
    const out = enrichMessageWithContext("fix this", [
      block({ id: "1", kind: "selection", label: "foo.ts:1-5", content: "const a = 1;", language: "ts" }),
    ]);
    expect(out).toBe("# Context — foo.ts:1-5\n```ts\nconst a = 1;\n```\n\nfix this");
  });

  test("joins multiple blocks and preserves order", () => {
    const out = enrichMessageWithContext("go", [
      block({ id: "1", label: "a", content: "A" }),
      block({ id: "2", label: "b", content: "B" }),
    ]);
    expect(out.indexOf("— a")).toBeLessThan(out.indexOf("— b"));
    expect(out.endsWith("\n\ngo")).toBe(true);
  });
});

describe("toChips", () => {
  test("strips content, keeps id/kind/label", () => {
    expect(toChips([block({ id: "1", kind: "diff", label: "HEAD", content: "huge diff" })])).toEqual([
      { id: "1", kind: "diff", label: "HEAD" },
    ]);
  });
});
