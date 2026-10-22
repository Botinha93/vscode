/** Pure helper: drop map/object keys not present in keptIds. Mutates inputs in place. */
export function pruneMapKeys<K>(map: Map<K, unknown>, keptIds: ReadonlySet<K>): void {
  for (const key of [...map.keys()]) {
    if (!keptIds.has(key)) map.delete(key);
  }
}

export function pruneObjectKeys<T extends Record<string, unknown>>(
  obj: T,
  keptIds: ReadonlySet<string>,
): void {
  for (const key of Object.keys(obj)) {
    if (!keptIds.has(key)) delete obj[key];
  }
}

export interface ConversationCacheMaps {
  messagesCache: Map<string, unknown>;
  overrides: Record<string, unknown>;
  sessionKinds: Map<string, unknown>;
  consumedPipelineCards: Map<string, unknown>;
  attachmentBytes: Map<string, unknown>;
}

/** Build the set of conversation ids whose cache entries should be retained. */
export function buildKeptConversationIds(
  ownedIds: Iterable<string>,
  activeSessionId: string | null,
  draftSessionId: string | null | undefined,
): Set<string> {
  const kept = new Set(ownedIds);
  if (activeSessionId) kept.add(activeSessionId);
  if (draftSessionId) kept.add(draftSessionId);
  return kept;
}

/** Prune all conversation-scoped caches to entries whose ids are in keptIds. */
export function pruneConversationCaches(
  keptIds: ReadonlySet<string>,
  maps: ConversationCacheMaps,
): void {
  pruneMapKeys(maps.messagesCache, keptIds);
  pruneObjectKeys(maps.overrides, keptIds);
  pruneMapKeys(maps.sessionKinds, keptIds);
  pruneMapKeys(maps.consumedPipelineCards, keptIds);

  const keptDocumentIds = new Set<string>();
  for (const id of keptIds) {
    const entry = maps.overrides[id];
    if (entry && typeof entry === "object" && "documentIds" in entry) {
      const docIds = (entry as { documentIds?: unknown }).documentIds;
      if (Array.isArray(docIds)) {
        for (const docId of docIds) keptDocumentIds.add(String(docId));
      }
    }
  }
  pruneMapKeys(maps.attachmentBytes, keptDocumentIds);
}
