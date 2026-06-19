import * as path from "node:path";

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

