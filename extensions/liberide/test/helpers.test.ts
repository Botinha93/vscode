import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Uri, vscodeMock, workspace } from "./vscode-mock";

mock.module("vscode", () => vscodeMock);
const { isInWorkspace, resolveInsideRootSync, withRequestRoot, workspaceFolder } = await import("../src/ide-delegate/handlers/helpers");

const root = mkdtempSync(path.join(tmpdir(), "liberide-root-"));
const outside = mkdtempSync(path.join(tmpdir(), "liberide-outside-"));
mkdirSync(path.join(root, "src"));
symlinkSync(outside, path.join(root, "escape"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("resolveInsideRootSync", () => {
  test("resolves paths inside the folder, including ones that do not exist yet", () => {
    expect(resolveInsideRootSync(root, "src/a.ts")).toBe(path.join(root, "src/a.ts"));
    expect(resolveInsideRootSync(root, "new/dir/b.ts")).toBe(path.join(root, "new/dir/b.ts"));
    expect(resolveInsideRootSync(root, "..hidden")).toBe(path.join(root, "..hidden"));
  });

  test("rejects traversal, absolute paths, NUL bytes and symlink escapes", () => {
    expect(() => resolveInsideRootSync(root, "../../etc/passwd")).toThrow("escapes");
    expect(() => resolveInsideRootSync(root, "/etc/passwd")).toThrow("relative");
    expect(() => resolveInsideRootSync(root, "a\0b")).toThrow("invalid");
    expect(() => resolveInsideRootSync(root, "escape/secret.txt")).toThrow("escapes");
  });
});

describe("multi-root folder binding", () => {
  test("handlers see the folder their socket serves, not always the first", async () => {
    workspace.workspaceFolders = [
      { name: "api", uri: Uri.file("/work/api") },
      { name: "web", uri: Uri.file("/work/web") },
    ];
    expect(workspaceFolder()?.name).toBe("api");
    await withRequestRoot("/work/web", async () => {
      await Promise.resolve();
      expect(workspaceFolder()?.name).toBe("web");
      expect(isInWorkspace("/work/web/src/a.ts")).toBe(true);
      expect(isInWorkspace("/work/api/src/a.ts")).toBe(false);
    });
    workspace.workspaceFolders = [];
  });
});
