import { APPROVAL_MODES, DEFAULT_APPROVAL_MODE, approvalModeRank, isApprovalMode, type AgentApprovalRequest, type ApprovalMode } from "@nexus/shared";

export type { ApprovalMode } from "@nexus/shared";
export { APPROVAL_MODES, DEFAULT_APPROVAL_MODE, isApprovalMode } from "@nexus/shared";

/**
 * Per-chat approval mode (how much runs started from the chat ask before
 * acting). Distinct from the model chip's "Auto" model selection.
 */
export const APPROVAL_MODE_OPTIONS: ReadonlyArray<{ id: ApprovalMode; label: string; description: string }> = [
  { id: "ask", label: "Ask", description: "Ask before edits, commands and other gated actions." },
  { id: "auto", label: "Auto", description: "Apply edits and run normal commands; still ask for destructive or irreversible actions." },
  { id: "full", label: "Full access", description: "Never ask. Only hard-denied policies still block." },
];

export function approvalModeLabel(mode: ApprovalMode): string {
  return APPROVAL_MODE_OPTIONS.find((option) => option.id === mode)?.label ?? mode;
}

/** Whether the admin maximum allows `mode`. */
export function approvalModeAllowed(mode: ApprovalMode, max: ApprovalMode | undefined): boolean {
  return !max || approvalModeRank(mode) <= approvalModeRank(max);
}

/** The mode a conversation runs at: its stored value, else the default. */
export function conversationApprovalMode(conversation: { approvalMode?: unknown } | undefined | null): ApprovalMode {
  return isApprovalMode(conversation?.approvalMode) ? conversation.approvalMode : DEFAULT_APPROVAL_MODE;
}

/** Whether switching from `previous` to `next` loosens approvals (offer to resolve pending ones). */
export function loosensApprovals(previous: ApprovalMode, next: ApprovalMode): boolean {
  return next !== "ask" && approvalModeRank(next) > approvalModeRank(previous);
}

/** Read `maxApprovalMode` from `/api/config` (absent on older servers: no cap). */
export function maxApprovalModeFromConfig(config: { maxApprovalMode?: unknown }): ApprovalMode | undefined {
  return isApprovalMode(config.maxApprovalMode) ? config.maxApprovalMode : undefined;
}

export interface ApprovalModeChangeDeps<C extends { approvalMode?: unknown }> {
  patch: (conversationId: string, partial: { approvalMode: ApprovalMode }) => Promise<C>;
  listAutoResolvable: (conversationId: string) => Promise<{ approvals: AgentApprovalRequest[] }>;
}

export type ApprovalModeChangeResult<C> =
  | { ok: true; conversation: C; mode: ApprovalMode; resolvable: AgentApprovalRequest[] }
  | { ok: false; error: string };

/**
 * Change a saved conversation's approval mode: validate against the admin
 * maximum, PATCH it, and — when the mode got looser — list the pending
 * approvals the new mode would auto-approve so the user can resolve them.
 */
export async function changeConversationApprovalMode<C extends { approvalMode?: unknown }>(
  input: { conversationId: string; previous: ApprovalMode; next: ApprovalMode; max?: ApprovalMode },
  deps: ApprovalModeChangeDeps<C>,
): Promise<ApprovalModeChangeResult<C>> {
  if (!isApprovalMode(input.next) || !APPROVAL_MODES.includes(input.next)) return { ok: false, error: `Unknown approval mode '${String(input.next)}'.` };
  if (!approvalModeAllowed(input.next, input.max)) {
    return { ok: false, error: `${approvalModeLabel(input.next)} is not allowed by your administrator (maximum: ${approvalModeLabel(input.max!)}).` };
  }
  let conversation: C;
  try {
    conversation = await deps.patch(input.conversationId, { approvalMode: input.next });
  } catch (err) {
    return { ok: false, error: `Could not change the approval mode: ${err instanceof Error ? err.message : String(err)}` };
  }
  const mode = conversationApprovalMode(conversation);
  let resolvable: AgentApprovalRequest[] = [];
  if (loosensApprovals(input.previous, mode)) {
    resolvable = await deps.listAutoResolvable(input.conversationId).then((r) => r.approvals ?? []).catch(() => []);
  }
  return { ok: true, conversation, mode, resolvable };
}

// The active chat's approval context, read by spec dispatch (pipeline panel)
// so graphs it starts keep the chat's mode.
let activeChatApproval: { conversationId?: string; approvalMode?: ApprovalMode } = {};

export function setActiveChatApprovalContext(context: { conversationId?: string; approvalMode?: ApprovalMode }): void {
  activeChatApproval = { ...context };
}

export function activeChatApprovalContext(): { conversationId?: string; approvalMode?: ApprovalMode } {
  return { ...activeChatApproval };
}
