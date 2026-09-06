import { join } from 'node:path';
import { JsonFileStore } from '../infra/json-store.js';

const STORE_VERSION = 1 as const;
const MAX_ACKNOWLEDGEMENTS_PER_USER = 2_000;

interface AcknowledgementStoreData {
  version: typeof STORE_VERSION;
  /** user id -> conversation id -> the conversation version the user opened. */
  acknowledgements: Record<string, Record<string, string>>;
}

export interface ConversationAcknowledgementStore {
  getMany(
    userId: string,
    conversationIds: readonly string[],
  ): ReadonlyMap<string, string>;
  acknowledge(input: {
    userId: string;
    conversationId: string;
    updatedAt: string;
  }): void;
}

/**
 * Durable, user-scoped read state for the unified conversation inventory.
 *
 * The stored value is the `updatedAt` version that was actually rendered,
 * rather than the acknowledgement request's wall-clock time. A later turn
 * therefore becomes unseen again naturally, even if the acknowledgement and
 * a provider event race. This stays independent of the conversation owner so
 * it works equally for runtime transcripts and file-store conversations.
 */
export class FileConversationAcknowledgementStore
  implements ConversationAcknowledgementStore
{
  private readonly store: JsonFileStore<AcknowledgementStoreData>;

  constructor(dataDir: string) {
    this.store = new JsonFileStore(
      join(dataDir, 'conversation-acknowledgements.json'),
      { version: STORE_VERSION, acknowledgements: {} },
      { durableAtomicWrite: true, onCorruption: 'throw' },
    );
  }

  /** One fresh snapshot per inventory read; never cache across requests. */
  getMany(
    userId: string,
    conversationIds: readonly string[],
  ): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    if (conversationIds.length === 0) return result;
    const data = this.store.read();
    if (data.version !== STORE_VERSION) return result;
    const forUser = data.acknowledgements[userId];
    for (const id of conversationIds) {
      const version = forUser?.[id];
      if (version !== undefined) result.set(id, version);
    }
    return result;
  }

  acknowledge({
    userId,
    conversationId,
    updatedAt,
  }: {
    userId: string;
    conversationId: string;
    updatedAt: string;
  }): void {
    const data = this.store.read();
    const acknowledgements =
      data.version === STORE_VERSION ? data.acknowledgements : {};
    const forUser = {
      ...(acknowledgements[userId] ?? {}),
      [conversationId]: updatedAt,
    };

    const entries = Object.entries(forUser);
    if (entries.length > MAX_ACKNOWLEDGEMENTS_PER_USER) {
      entries
        .sort(([, left], [, right]) => left.localeCompare(right))
        .slice(0, entries.length - MAX_ACKNOWLEDGEMENTS_PER_USER)
        .forEach(([id]) => delete forUser[id]);
    }

    this.store.write({
      version: STORE_VERSION,
      acknowledgements: { ...acknowledgements, [userId]: forUser },
    });
  }
}
