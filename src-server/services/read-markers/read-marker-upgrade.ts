import type { FileReadMarkerStore } from './read-marker-store.js';

/**
 * #3075 owner design: converts first-format read state into content
 * versions, once, so nobody reads unread on upgrade.
 *
 * - The runtime baseline becomes the event store sequence as of the old
 *   time baseline.
 * - Each recorded view (the acknowledgement store, which held agent
 *   conversation markers as times) becomes the conversation's content
 *   version as of that time. A file-backed conversation keeps its time,
 *   which is still its version space.
 *
 * A hosted tenant key (`tenant:<id>`, no person) is a last-viewed record,
 * never a person's marker, and is not converted. Returns whether an upgrade
 * ran.
 */
export function upgradeReadMarkerStore(input: {
  store: Pick<FileReadMarkerStore, 'pendingUpgrade' | 'completeUpgrade'>;
  acknowledgements: {
    entries(): ReadonlyArray<{
      key: string;
      conversationId: string;
      updatedAt: string;
    }>;
  };
  events: {
    globalSequenceAsOfTime(time: string): number;
    hasConversation(conversationId: string): boolean;
    conversationContentVersionAsOfTime(
      conversationId: string,
      time: string,
    ): number | undefined;
  };
  now: Date;
}): boolean {
  const pending = input.store.pendingUpgrade();
  if (!pending) return false;
  const markers: Array<{ principalId: string; key: string; version: number }> =
    [];
  for (const {
    key,
    conversationId,
    updatedAt,
  } of input.acknowledgements.entries()) {
    if (/^tenant:[^#]+$/.test(key)) continue;
    const viewedAt = Date.parse(updatedAt);
    if (!Number.isSafeInteger(viewedAt) || viewedAt < 0) continue;
    const version = input.events.hasConversation(conversationId)
      ? input.events.conversationContentVersionAsOfTime(
          conversationId,
          new Date(viewedAt).toISOString(),
        )
      : viewedAt;
    if (version === undefined) continue;
    markers.push({
      principalId: key,
      key: `agent-conversation:${conversationId}`,
      version,
    });
  }
  input.store.completeUpgrade({
    baselineSequence: input.events.globalSequenceAsOfTime(
      new Date(pending.createdAt).toISOString(),
    ),
    markers,
    now: input.now,
  });
  return true;
}
