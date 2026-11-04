/**
 * #3483: the durable conversation-level untrusted-content mark.
 *
 * Once a conversation has read content an integration classifies untrusted,
 * every later turn of it is marked, across restarts, until a person clears
 * the mark. The record lives beside the conversation acknowledgement store
 * in the Station home, keyed by conversation id.
 *
 * It is bounded. Past `MARK_LIMIT` conversations it does not forget one;
 * it records saturation instead, and then every conversation counts as
 * marked until a person clears all marks. A store Station cannot read
 * counts as marked.
 */

import { join } from 'node:path';
import { JsonFileStore } from '../infra/json-store.js';

const STORE_VERSION = 1 as const;
/** Conversations recorded individually before the store saturates. */
export const MARK_LIMIT = 10_000;
/** Clearance receipts kept; the oldest is dropped first. */
const RECEIPT_LIMIT = 50;

export interface UntrustedMarkClearance {
  /** A conversation id, or `*` for clearing every mark. */
  conversationId: string;
  at: string;
  /** The authenticated person who cleared it. */
  by: string;
}

interface MarkStoreData {
  version: typeof STORE_VERSION;
  marks: Record<string, { at: string }>;
  /** Set when a mark did not fit; every conversation then counts as marked. */
  saturatedAt?: string;
  clearances: UntrustedMarkClearance[];
}

export interface UntrustedConversationMarkStatus {
  marked: boolean;
  markedAt?: string;
  saturated: boolean;
  clearances: UntrustedMarkClearance[];
}

export class UntrustedConversationMarks {
  private readonly store: JsonFileStore<MarkStoreData>;

  constructor(homeDir: string) {
    this.store = new JsonFileStore(
      join(homeDir, 'untrusted-conversation-marks.json'),
      { version: STORE_VERSION, marks: {}, clearances: [] },
      {
        durableAtomicWrite: true,
        onCorruption: 'throw',
        maxReadBytes: 4 * 1024 * 1024,
      },
    );
  }

  private read(): MarkStoreData {
    const data = this.store.read();
    if (
      data?.version !== STORE_VERSION ||
      !data.marks ||
      typeof data.marks !== 'object' ||
      !Array.isArray(data.clearances)
    )
      throw new Error('Unreadable untrusted-content mark store');
    return data;
  }

  /** Whether any of these conversations is marked. Unreadable counts as marked. */
  isMarked(...conversationIds: (string | undefined)[]): boolean {
    const ids = conversationIds.filter((id): id is string => !!id);
    if (ids.length === 0) return false;
    try {
      const data = this.read();
      return (
        data.saturatedAt !== undefined ||
        ids.some((id) => Object.hasOwn(data.marks, id))
      );
    } catch {
      return true;
    }
  }

  mark(conversationId: string, now = new Date()): void {
    const data = this.read();
    if (Object.hasOwn(data.marks, conversationId)) return;
    if (Object.keys(data.marks).length >= MARK_LIMIT) {
      if (data.saturatedAt) return;
      this.store.write({ ...data, saturatedAt: now.toISOString() });
      return;
    }
    this.store.write({
      ...data,
      marks: { ...data.marks, [conversationId]: { at: now.toISOString() } },
    });
  }

  status(conversationId: string): UntrustedConversationMarkStatus {
    const data = this.read();
    const mark = Object.hasOwn(data.marks, conversationId)
      ? data.marks[conversationId]
      : undefined;
    return {
      marked: data.saturatedAt !== undefined || mark !== undefined,
      ...(mark ? { markedAt: mark.at } : {}),
      saturated: data.saturatedAt !== undefined,
      clearances: data.clearances.filter(
        (receipt) =>
          receipt.conversationId === conversationId ||
          receipt.conversationId === '*',
      ),
    };
  }

  /**
   * A person clears one conversation's mark (or `*`, every mark and the
   * saturation). Callers authenticate the person; this records who did it.
   * Clearing one conversation leaves saturation in place.
   */
  clear(
    conversationId: string,
    by: string,
    now = new Date(),
  ): UntrustedMarkClearance {
    const data = this.read();
    const receipt = { conversationId, at: now.toISOString(), by };
    const marks = { ...data.marks };
    if (conversationId === '*')
      for (const id of Object.keys(marks)) delete marks[id];
    else delete marks[conversationId];
    const next: MarkStoreData = {
      version: STORE_VERSION,
      marks,
      clearances: [...data.clearances, receipt].slice(-RECEIPT_LIMIT),
      ...(data.saturatedAt && conversationId !== '*'
        ? { saturatedAt: data.saturatedAt }
        : {}),
    };
    this.store.write(next);
    return receipt;
  }
}
