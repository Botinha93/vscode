import * as path from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";

/** Lexical containment check: `candidate` is `root` or below it. */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolve a model-supplied path inside `root`. Rejects absolute paths, NUL
 * bytes, `..` escapes, dangling symlinks and symlinks whose real target leaves
 * the root. Every existing component is checked with lstat, so a link that
 * does not resolve (whose target would be created on write) cannot pass by
 * falling back to its parent. `forWrite` also refuses a symlink as the final
 * component: writes never go through links.
 */
export function resolveInsideRootSync(root: string, relative: string, options: { forWrite?: boolean } = {}): string {
  if (relative.includes("\0")) throw new Error("Path contains invalid characters");
  if (path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative)) {
    throw new Error("Path must be relative to the workspace folder");
  }
  const base = path.resolve(root);
  const full = path.resolve(base, relative);
  if (!isPathInside(base, full)) throw new Error("Path escapes the workspace folder");
  assertNoSymlinkEscape(base, full, options);
  return full;
}

/** Walk the existing components of `full` (inside `base`) and reject symlinks that leave the root. */
function assertNoSymlinkEscape(base: string, full: string, options: { forWrite?: boolean }): void {
  if (!existsSync(base)) return;
  const realBase = realpathSync(base);
  const segments = path.relative(base, full).split(path.sep).filter(Boolean);
  let current = base;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]!);
    let info;
    try {
      info = lstatSync(current, { throwIfNoEntry: false });
    } catch {
      // ENOTDIR and similar: the rest of the path cannot exist.
      break;
    }
    if (!info) break;
    if (!info.isSymbolicLink()) continue;
    if (options.forWrite && i === segments.length - 1) throw new Error("Refusing to write through a symbolic link");
    let target: string;
    try {
      target = realpathSync(current);
    } catch {
      throw new Error("Path goes through a dangling symbolic link");
    }
    if (!isPathInside(realBase, target)) throw new Error("Path escapes the workspace folder");
  }
}


export function resolveContainedRelativePath(root: string, relative: string): string {
  if (!root) throw new Error("No workspace folder open");
  if (!relative) throw new Error("Path is required");
  if (relative.includes("\0")) throw new Error("Path contains invalid characters");
  if (path.isAbsolute(relative) || /^[a-zA-Z]:[\\/]/.test(relative)) {
    throw new Error("Path must be relative to the project directory");
  }
  const rootPath = path.resolve(root);
  const fullPath = path.resolve(rootPath, relative);
  const prefix = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`;
  if (fullPath !== rootPath && !fullPath.startsWith(prefix)) {
    throw new Error("Path escapes the allowed boundary");
  }
  // Lexically contained; also refuse symlinks whose real target leaves the root.
  assertNoSymlinkEscape(rootPath, fullPath, {});
  return fullPath;
}

export function assertContainedGlobPattern(pattern: string): string {
  if (pattern.includes("\0")) throw new Error("Path contains invalid characters");
  if (path.isAbsolute(pattern) || /^[a-zA-Z]:[\\/]/.test(pattern)) {
    throw new Error("Path must be relative to the project directory");
  }
  if (pattern.split(/[\\/]/).includes("..")) {
    throw new Error("Path escapes the allowed boundary");
  }
  return pattern;
}
