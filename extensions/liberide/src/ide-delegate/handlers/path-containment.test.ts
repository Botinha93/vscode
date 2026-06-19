import { describe, expect, test } from "bun:test";
import { resolveContainedRelativePath, assertContainedGlobPattern } from "./path-containment";

describe("resolveContainedRelativePath", () => {
  const root = process.platform === "win32" ? "C:\\workspace\\project" : "/workspace/project";

  test("resolves safe relative paths", () => {
    expect(resolveContainedRelativePath(root, "src/index.ts").replace(/\\/g, "/").endsWith("/workspace/project/src/index.ts")).toBe(true);
    expect(resolveContainedRelativePath(root, "src/../package.json").replace(/\\/g, "/").endsWith("/workspace/project/package.json")).toBe(true);
  });

  test("rejects traversal escapes", () => {
    expect(() => resolveContainedRelativePath(root, "../secret.txt")).toThrow("Path escapes the allowed boundary");
    expect(() => resolveContainedRelativePath(root, "src/../../secret.txt")).toThrow("Path escapes the allowed boundary");
  });

  test("rejects absolute and Windows absolute paths", () => {
    expect(() => resolveContainedRelativePath(root, "/etc/passwd")).toThrow("Path must be relative to the project directory");
    expect(() => resolveContainedRelativePath(root, "C:\\Windows\\System32")).toThrow("Path must be relative to the project directory");
  });

  test("rejects null bytes", () => {
    expect(() => resolveContainedRelativePath(root, "src\0file.ts")).toThrow("Path contains invalid characters");
  });
});

describe("assertContainedGlobPattern", () => {
  test("allows project-local glob patterns", () => {
    expect(assertContainedGlobPattern("src/**/*.ts")).toBe("src/**/*.ts");
  });

  test("rejects escaping glob patterns", () => {
    expect(() => assertContainedGlobPattern("../**/*")).toThrow("Path escapes the allowed boundary");
  });
});
