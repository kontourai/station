import { join } from 'node:path';
import { JsonFileStore } from '../infra/json-store.js';

/** Personal resolution state, independent of turn completion, read state and dismissal. */
export class ConversationWorkStateStore {
  private readonly store: JsonFileStore<{
    version: 1;
    settled: Record<string, Record<string, string>>;
  }>;
  constructor(dataDir: string) {
    this.store = new JsonFileStore(
      join(dataDir, 'conversation-work-state.json'),
      { version: 1, settled: {} },
      { durableAtomicWrite: true, onCorruption: 'throw' },
    );
  }
  read(person: string): Record<string, string> {
    return { ...this.store.read().settled[person] };
  }
  set(
    person: string,
    conversationId: string,
    settled: boolean,
    at: string,
  ): void {
    const data = this.store.read();
    const entries = settled
      ? { ...data.settled[person], [conversationId]: at }
      : { ...data.settled[person] };
    if (!settled) delete entries[conversationId];
    this.store.write({
      version: 1,
      settled: { ...data.settled, [person]: entries },
    });
  }
  /**
   * Clears the settled record for any of `conversationIds` (aliases of one
   * conversation): `person`'s only, or everyone's when `person` is absent.
   * Writes only when a record existed; answers whether one did.
   */
  reopen(conversationIds: readonly string[], person?: string): boolean {
    const data = this.store.read();
    let changed = false;
    const settled: Record<string, Record<string, string>> = {};
    for (const [key, entries] of Object.entries(data.settled)) {
      if (person !== undefined && key !== person) {
        settled[key] = entries;
        continue;
      }
      const kept = { ...entries };
      for (const id of conversationIds)
        if (Object.hasOwn(kept, id)) {
          delete kept[id];
          changed = true;
        }
      settled[key] = kept;
    }
    if (changed) this.store.write({ version: 1, settled });
    return changed;
  }
}
