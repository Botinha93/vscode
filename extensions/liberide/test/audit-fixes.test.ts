import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Uri, appliedEdits, commandResults, vscodeMock, workspace } from "./vscode-mock";

mock.module("vscode", () => vscodeMock);
const helpers = await import("../src/ide-delegate/handlers/helpers");
const fs = await import("../src/ide-delegate/handlers/fs");
const redaction = await import("../src/ide-delegate/handlers/redaction");
const workspaceEdit = await import("../src/ide-delegate/handlers/workspace-edit");
const config = await import("../src/ide-delegate/handlers/config");
const lsp = await import("../src/ide-delegate/handlers/lsp");
const editors = await import("../src/ide-delegate/handlers/editors");
const { SPEC_WATCH_GLOB } = await import("../src/spec/store");

const root = mkdtempSync(path.join(tmpdir(), "liberide-audit-"));
const outside = mkdtempSync(path.join(tmpdir(), "liberide-audit-out-"));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

beforeEach(() => {
  workspace.workspaceFolders = [{ name: "root", uri: Uri.file(root) }];
  workspace.textDocuments = [];
  appliedEdits.length = 0;
});

describe("symlink-safe writes", () => {
  test("a dangling symlink pointing outside the folder is rejected, nothing is written outside", async () => {
    const target = path.join(outside, "created-by-agent.txt");
    symlinkSync(target, path.join(root, "dangling"));
    expect(() => helpers.resolveInsideRootSync(root, "dangling")).toThrow("dangling");
    await expect(fs.handleFsWrite(root, { path: "dangling", content: "pwned" })).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  test("writes never follow a symlink leaf, even one that stays inside the folder", async () => {
    writeFileSync(path.join(root, "real.txt"), "original");
    symlinkSync(path.join(root, "real.txt"), path.join(root, "link.txt"));
    expect(helpers.resolveInsideRootSync(root, "link.txt")).toBe(path.join(root, "link.txt"));
    await expect(fs.handleFsWrite(root, { path: "link.txt", content: "changed" })).rejects.toThrow("symbolic link");
    expect(readFileSync(path.join(root, "real.txt"), "utf8")).toBe("original");
  });

  test("directory listings skip symlinks", async () => {
    mkdirSync(path.join(root, "listing"));
    writeFileSync(path.join(root, "listing", "a.txt"), "a");
    symlinkSync(outside, path.join(root, "listing", "out"));
    const { entries } = await fs.handleFsList(root, { path: "listing" }) as { entries: Array<{ name: string }> };
    expect(entries.map((e) => e.name)).toEqual(["a.txt"]);
  });
});

describe("fs.read size cap", () => {
  test("ranges read part of a file and report the total size", async () => {
    writeFileSync(path.join(root, "big.txt"), "0123456789");
    expect(await fs.handleFsRead(root, { path: "big.txt", offset: 2, length: 3 })).toEqual({
      content: "234", offset: 2, length: 3, size: 10, hasMore: true,
    });
    expect(fs.MAX_READ_BYTES).toBeGreaterThan(0);
  });
});

describe("secret redaction", () => {
  test("search results from secret files are redacted; .gitignore'd files are not scanned", async () => {
    const dir = path.join(root, "search");
    mkdirSync(dir);
    writeFileSync(path.join(dir, ".env"), "API_TOKEN=supersecretvalue\n");
    writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\nbuild/\n");
    writeFileSync(path.join(dir, "ignored.txt"), "supersecretvalue here\n");
    writeFileSync(path.join(dir, "code.ts"), "const x = 'supersecretvalue';\n");
    const plain = await fs.handleFsSearch(dir, { query: "supersecretvalue" }) as { results: Array<{ file: string }> };
    expect(plain.results.map((r) => r.file)).toEqual(["code.ts"]);
    const env = await fs.handleFsSearch(dir, { query: "supersecretvalue", includePattern: ".env" }) as { results: Array<{ file: string; text: string; redacted?: boolean }> };
    expect(env.results).toEqual([{ file: ".env", line: 1, text: "API_TOKEN=[REDACTED]", redacted: true } as never]);
  });

  test("git diffs redact secret-file hunks only", () => {
    const diff = [
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-DB_PASSWORD=old",
      "+DB_PASSWORD=new",
      "diff --git a/src/a.ts b/src/a.ts",
      "+const password = 1;",
    ].join("\n");
    const out = redaction.redactUnifiedDiff(diff);
    expect(out).toContain("-DB_PASSWORD=[REDACTED]");
    expect(out).toContain("+DB_PASSWORD=[REDACTED]");
    expect(out).toContain("+const password = 1;");
    expect(redaction.isSecretFile("config/.env.example")).toBe(false);
  });

  test("dirty buffers of secret files are redacted", async () => {
    const envPath = path.join(root, ".env.local");
    workspace.textDocuments = [{ uri: Uri.file(envPath), isDirty: true, save: async () => true, getText: () => "SECRET=abc\n" }];
    (workspace.textDocuments[0] as unknown as { languageId: string }).languageId = "dotenv";
    const { buffers } = await editors.handleDirtyBuffers({}) as { buffers: Array<{ content: string; redacted?: boolean }> };
    expect(buffers[0]).toMatchObject({ content: "SECRET=[REDACTED]\n", redacted: true });
  });
});

describe("workspace edits", () => {
  test("deleting the workspace root or .git is refused before anything is applied", async () => {
    await expect(workspaceEdit.handleApplyWorkspaceEdit({
      documentChanges: [{ kind: "delete", path: ".", options: { recursive: true } }],
    })).rejects.toThrow("workspace root");
    await expect(workspaceEdit.handleApplyWorkspaceEdit({
      documentChanges: [{ kind: "delete", path: ".git/config" }],
    })).rejects.toThrow(".git");
    expect(appliedEdits.length).toBe(0);
  });

  test("text edits are snapshotted, applied and saved; [REDACTED] placeholders are refused", async () => {
    const file = path.join(root, "edit.ts");
    writeFileSync(file, "const a = 1;\n");
    let saved = false;
    workspace.textDocuments = [{ uri: Uri.file(file), isDirty: true, save: async () => (saved = true), getText: () => "1" }];
    const range = { startLine: 1, startCharacter: 10, endLine: 1, endCharacter: 11 };
    fs.resetPreEditSnapshots();
    const result = await workspaceEdit.handleApplyWorkspaceEdit({ changes: { "edit.ts": [{ range, newText: "2" }] } });
    expect(result).toMatchObject({ applied: true, changedFiles: ["edit.ts"], saved: ["edit.ts"] });
    expect(saved).toBe(true);
    // The snapshot holds the pre-edit disk content for Undo.
    writeFileSync(file, "const a = 2;\n");
    expect(await fs.restorePreEditSnapshot(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("const a = 1;\n");
    await expect(workspaceEdit.handleApplyWorkspaceEdit({ changes: { "edit.ts": [{ range, newText: "[REDACTED]" }] } })).rejects.toThrow("REDACTED");
  });
});

describe("undo snapshots per conversation", () => {
  test("a new turn in one conversation keeps another conversation's snapshots", async () => {
    const file = path.join(root, "scoped.ts");
    writeFileSync(file, "before");
    await helpers.withRequestRoot(root, () => fs.handleFsWrite(root, { path: "scoped.ts", content: "after" }), "conv-a");
    fs.resetPreEditSnapshots("conv-b");
    expect(await fs.restorePreEditSnapshot(file, "conv-b")).toBe(false);
    expect(await fs.restorePreEditSnapshot(file, "conv-a")).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("before");
  });
});

describe("config allowlist", () => {
  test("editor/formatting keys are allowed; code-executing and unknown settings are not", () => {
    const allowed = ["editor.tabSize", "editor.formatOnSave", "files.exclude", "search.exclude", "[python].editor.tabSize", "typescript.format.semicolons", "prettier.singleQuote"];
    const denied = [
      "python.defaultInterpreterPath", "typescript.tsdk", "eslint.nodePath", "terminal.integrated.shell.linux",
      "terminal.integrated.env.linux", "security.workspace.trust.enabled", "tasks", "launch", "git.path",
      "editor.someExtension.executablePath", "liberide.systemPrompt", "http.proxy", "[python].python.defaultInterpreterPath",
    ];
    expect(allowed.filter((key) => !config.isAgentConfigurableKey(key))).toEqual([]);
    expect(denied.filter((key) => config.isAgentConfigurableKey(key))).toEqual([]);
  });

  test("writes reject the global target and non-allowlisted keys", async () => {
    await expect(config.handleConfigWrite({ section: "editor", key: "tabSize", value: 2, target: "global" })).rejects.toThrow("not allowed");
    await expect(config.handleConfigWrite({ section: "python", key: "defaultInterpreterPath", value: "/tmp/x" })).rejects.toThrow("cannot be changed");
  });
});

describe("spec watcher glob", () => {
  test("matches spec markdown in any folder", () => {
    const glob = new Bun.Glob(SPEC_WATCH_GLOB);
    expect(glob.match("/work/app/.liberide/specs/feature/requirements.md")).toBe(true);
    expect(glob.match("/work/app/.liberide/specs/f/tasks/T1.md")).toBe(true);
    expect(glob.match("/work/app/src/readme.md")).toBe(false);
  });

  test("matches feature folders so folder-level create/delete refreshes", () => {
    const glob = new Bun.Glob(SPEC_WATCH_GLOB);
    expect(glob.match("/work/app/.liberide/specs/feature")).toBe(true);
    expect(glob.match("/work/app/.liberide/specs/feature/tasks")).toBe(true);
    expect(glob.match("/work/app/.liberide/other/feature")).toBe(false);
  });
});

describe("workspace symbol paging", () => {
  test("offset/maxResults page through symbols and nextCursor resumes", async () => {
    const symbol = (i: number) => ({ name: `s${i}`, kind: 11, containerName: "", location: { uri: Uri.file(path.join(root, "a.ts")), range: { start: { line: i, character: 0 } } } });
    commandResults.set("vscode.executeWorkspaceSymbolProvider", [0, 1, 2, 3, 4].map(symbol));
    const first = await lsp.handleWorkspaceSymbols({ query: "s", maxResults: 2 }) as { symbols: Array<{ name: string }>; nextCursor?: number; total: number };
    expect(first.symbols.map((s) => s.name)).toEqual(["s0", "s1"]);
    expect(first.nextCursor).toBe(2);
    const last = await lsp.handleWorkspaceSymbols({ query: "s", maxResults: 2, offset: 4 }) as { symbols: Array<{ name: string }>; nextCursor?: number; hasMore: boolean };
    expect(last.symbols.map((s) => s.name)).toEqual(["s4"]);
    expect(last.nextCursor).toBeUndefined();
    expect(last.hasMore).toBe(false);
  });
});
