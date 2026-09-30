import { afterAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vscodeMock } from "./vscode-mock";

mock.module("vscode", () => vscodeMock);
const fs = await import("../src/ide-delegate/handlers/fs");

const root = mkdtempSync(path.join(tmpdir(), "liberide-undo-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("agent edit undo", () => {
  test("restores a file to its content before the agent's first edit this turn", async () => {
    writeFileSync(path.join(root, "a.ts"), "user work\n");
    fs.resetPreEditSnapshots();
    await fs.handleFsWrite(root, { path: "a.ts", content: "agent v1\n" });
    await fs.handleFsWrite(root, { path: "a.ts", content: "agent v2\n" });
    expect(await fs.restorePreEditSnapshot(path.join(root, "a.ts"))).toBe(true);
    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toBe("user work\n");
  });

  test("a file the agent created is removed, and unknown files report no snapshot", async () => {
    fs.resetPreEditSnapshots();
    await fs.handleFsWrite(root, { path: "new.ts", content: "created" });
    expect(await fs.restorePreEditSnapshot(path.join(root, "new.ts"))).toBe(true);
    expect(existsSync(path.join(root, "new.ts"))).toBe(false);
    expect(await fs.restorePreEditSnapshot(path.join(root, "other.ts"))).toBe(false);
  });

  test("a patch transaction (temp write + renames) still undoes to the original", async () => {
    writeFileSync(path.join(root, "b.ts"), "original");
    fs.resetPreEditSnapshots();
    await fs.handleFsWrite(root, { path: "b.ts.chatllm-tx.next", content: "patched" });
    await fs.handleFsRename(root, { from: "b.ts", to: "b.ts.chatllm-tx.backup", overwrite: true });
    await fs.handleFsRename(root, { from: "b.ts.chatllm-tx.next", to: "b.ts", overwrite: true });
    await fs.handleFsDelete(root, { path: "b.ts.chatllm-tx.backup" });
    expect(readFileSync(path.join(root, "b.ts"), "utf8")).toBe("patched");
    expect(await fs.restorePreEditSnapshot(path.join(root, "b.ts"))).toBe(true);
    expect(readFileSync(path.join(root, "b.ts"), "utf8")).toBe("original");
  });
});
