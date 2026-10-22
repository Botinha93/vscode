import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request delegate context: the folder (and conversation) the current RPC
 * request is for. Each delegate socket serves one folder, so handlers resolve
 * `workspaceFolder()` against this root in multi-root workspaces.
 */
export interface DelegateContextStore {
  root: string;
  conversationId?: string;
}

export const delegateContext = new AsyncLocalStorage<DelegateContextStore>();

export function getDelegateRoot(): string | undefined {
  return delegateContext.getStore()?.root;
}

export function getDelegateConversationId(): string | undefined {
  return delegateContext.getStore()?.conversationId;
}
