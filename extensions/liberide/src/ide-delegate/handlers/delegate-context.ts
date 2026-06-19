import { AsyncLocalStorage } from "node:async_hooks";

export interface DelegateContextStore {
  root: string;
}

export const delegateContext = new AsyncLocalStorage<DelegateContextStore>();

export function getDelegateRoot(): string | undefined {
  return delegateContext.getStore()?.root;
}
