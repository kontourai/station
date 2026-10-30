import { join } from 'node:path';
import { JsonFileStore } from '../infra/json-store.js';

interface AttentionSnooze {
  version: string;
  until: string;
}

interface SnoozeStoreData {
  version: 1;
  snoozes: Record<string, Record<string, AttentionSnooze>>;
}

/** Same synchronous fresh-read/atomic-write ownership as acknowledgement state. */
export class FileAttentionSnoozeStore {
  private readonly store: JsonFileStore<SnoozeStoreData>;

  constructor(dataDir: string) {
    this.store = new JsonFileStore(
      join(dataDir, 'attention-snoozes.json'),
      { version: 1, snoozes: {} },
      { durableAtomicWrite: true, onCorruption: 'throw' },
    );
  }

  getMany(
    userId: string,
    itemIds: readonly string[],
  ): ReadonlyMap<string, AttentionSnooze> {
    const result = new Map<string, AttentionSnooze>();
    if (itemIds.length === 0) return result;
    const data = this.store.read();
    if (data.version !== 1) return result;
    const forUser = data.snoozes[userId];
    for (const id of itemIds) {
      const snooze = forUser?.[id];
      if (snooze) result.set(id, snooze);
    }
    return result;
  }

  set(
    input: { userId: string; itemId: string; version: string; until: string },
    now: number,
  ): void {
    this.write(
      input.userId,
      input.itemId,
      { version: input.version, until: input.until },
      now,
    );
  }

  delete(userId: string, itemId: string, now: number): void {
    this.write(userId, itemId, undefined, now);
  }

  private write(
    userId: string,
    itemId: string,
    value: AttentionSnooze | undefined,
    now: number,
  ): void {
    const data = this.store.read();
    const snoozes = data.version === 1 ? data.snoozes : {};
    for (const [owner, entries] of Object.entries(snoozes)) {
      for (const [id, entry] of Object.entries(entries)) {
        if (Date.parse(entry.until) <= now) delete entries[id];
      }
      if (Object.keys(entries).length === 0) delete snoozes[owner];
    }
    if (value) {
      snoozes[userId] = { ...(snoozes[userId] ?? {}), [itemId]: value };
    } else if (snoozes[userId]) {
      delete snoozes[userId][itemId];
      if (Object.keys(snoozes[userId]).length === 0) delete snoozes[userId];
    }
    this.store.write({ version: 1, snoozes });
  }
}
