/**
 * Pure helpers for the opt-in "diff preview before apply" gate. Kept free of
 * the `vscode` module so it can be unit-tested under bun. Operates on the raw
 * delegate payload shape consumed by `handleApplyWorkspaceEdit`.
 */

export type ConfirmEditsMode = "off" | "always" | "multiFileAndDeletes";

export interface EditSummary {
  /** Distinct files touched by the edit. */
  fileCount: number;
  /** True when the edit creates, renames, or deletes a file. */
  hasDestructive: boolean;
}

interface DocumentChange {
  kind?: string;
  path?: unknown;
  oldPath?: unknown;
  newPath?: unknown;
  textEdits?: unknown;
}

/** Summarize a workspace-edit payload: how many files it touches and whether it is destructive. */
export function summarizeEdit(payload: Record<string, unknown>): EditSummary {
  const files = new Set<string>();
  let hasDestructive = false;

  const changes = payload.changes as Record<string, unknown> | undefined;
  if (changes) for (const path of Object.keys(changes)) files.add(path);

  const documentChanges = payload.documentChanges as DocumentChange[] | undefined;
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges) {
      if (change.kind === "rename") {
        hasDestructive = true;
        if (change.oldPath) files.add(String(change.oldPath));
        if (change.newPath) files.add(String(change.newPath));
      } else if (change.kind === "create" || change.kind === "delete") {
        hasDestructive = true;
        if (change.path) files.add(String(change.path));
      } else if (change.textEdits && change.path) {
        files.add(String(change.path));
      }
    }
  }
  return { fileCount: files.size, hasDestructive };
}

/** Decide whether an edit should open the confirmation/preview, given the user's mode. */
export function shouldConfirmEdit(payload: Record<string, unknown>, mode: ConfirmEditsMode): boolean {
  if (mode === "off") return false;
  if (mode === "always") return true;
  const summary = summarizeEdit(payload);
  return summary.fileCount > 1 || summary.hasDestructive;
}
