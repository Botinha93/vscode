/**
 * Which chat a dispatched run belongs to. A feature scaffolded from a chat
 * (Generate pipeline) remembers that chat; its dispatches, and the graphs
 * they start, report there. Stored in workspaceState (vscode-free here: any
 * Memento-like store works, which keeps it testable).
 */

export interface LinkStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const FEATURE_KEY = "liberide.featureConversations";
const GRAPH_KEY = "liberide.graphConversations";
/** Graph links kept (oldest dropped first). */
const MAX_GRAPH_LINKS = 200;

export function featureConversation(store: LinkStore, featureId: string): string | undefined {
  return store.get<Record<string, string>>(FEATURE_KEY, {})[featureId];
}

export async function linkFeatureConversation(store: LinkStore, featureId: string, conversationId: string): Promise<void> {
  const links = { ...store.get<Record<string, string>>(FEATURE_KEY, {}), [featureId]: conversationId };
  await store.update(FEATURE_KEY, links);
}

export function graphConversation(store: LinkStore, graphId: string): string | undefined {
  return store.get<Record<string, string>>(GRAPH_KEY, {})[graphId];
}

export async function linkGraphConversation(store: LinkStore, graphId: string, conversationId: string): Promise<void> {
  const links = { ...store.get<Record<string, string>>(GRAPH_KEY, {}) };
  delete links[graphId];
  links[graphId] = conversationId;
  const ids = Object.keys(links);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_GRAPH_LINKS))) delete links[id];
  await store.update(GRAPH_KEY, links);
}

/**
 * The chat a dispatch reports to, most specific first: the one the caller
 * passed (pipeline opened from a chat), the chat that generated the feature,
 * then the chat the user has open. Undefined: the caller creates one.
 */
export function resolveDispatchConversation(candidates: {
  explicit?: string;
  feature?: string;
  active?: string;
}): string | undefined {
  return candidates.explicit || candidates.feature || candidates.active || undefined;
}

/** What the pipeline, the Runs view and workflow triggers need from the chat. */
export interface ChatRunLink {
  /** The saved conversation open in the chat, if any. */
  activeConversationId(): string | undefined;
  /** The open saved conversation, else a new one (opened in the chat). */
  ensureConversation(title: string): Promise<string | undefined>;
  /** A graph started for `conversationId`: show its card there and remember the link. */
  trackGraph(conversationId: string, graphId: string): Promise<void>;
  /** The chat a graph reports to, when known. */
  conversationForGraph(graphId: string): string | undefined;
  /** Focus the chat that owns the graph and expand the node there; false when no chat owns it. */
  revealGraphNode(graphId: string, nodeId: string): Promise<boolean>;
  /** Add a note to a chat's transcript (run action results and errors). */
  postNote(conversationId: string, text: string, severity?: "info" | "warning" | "error"): void;
  /** Reload a conversation (after the server posted cards to it) and show it. */
  showConversation(conversationId: string): Promise<void>;
}
