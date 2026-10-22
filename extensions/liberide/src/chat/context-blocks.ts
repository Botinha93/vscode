/**
 * Inline chat context blocks (selection / file / terminal / git diff). Kept
 * vscode-free so the formatting logic is unit-testable. The block content is
 * prepended to the outgoing message as labeled fenced blocks, so context
 * reaches the backend without any ChatRequest schema change.
 */

export type ContextBlockKind = "selection" | "file" | "terminal" | "diff";

export interface ContextBlock {
  id: string;
  kind: ContextBlockKind;
  label: string;
  content: string;
  /** Fenced-block language hint (e.g. "ts", "diff"). */
  language?: string;
}

/** Chip metadata sent to the webview (without the potentially-large content). */
export interface ContextBlockChip {
  id: string;
  kind: ContextBlockKind;
  label: string;
}

export function toChips(blocks: ContextBlock[]): ContextBlockChip[] {
  return blocks.map((b) => ({ id: b.id, kind: b.kind, label: b.label }));
}

/**
 * Prepend context blocks to a user message as labeled fenced blocks. Returns
 * `content` unchanged when there are no blocks.
 */
export function enrichMessageWithContext(content: string, blocks: ContextBlock[]): string {
  if (blocks.length === 0) return content;
  const sections = blocks.map(
    (b) => `# Context — ${b.label}\n\`\`\`${b.language ?? ""}\n${b.content}\n\`\`\``,
  );
  return `${sections.join("\n\n")}\n\n${content}`;
}
