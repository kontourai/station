import { join } from 'node:path';
import { JsonFileStore } from '../infra/json-store.js';

/** Hidden third-party sessions kept per person; the oldest beyond this are dropped. */
export const MAX_HIDDEN_SESSIONS_PER_PERSON = 1000;

/** Personal resolution state, independent of turn completion, read state and dismissal. */
export class ConversationWorkStateStore {
  private readonly store: JsonFileStore<{
    version: 1;
    settled: Record<string, Record<string, string>>;
  }>;
  /**
   * Third-party sessions a person hid from their inbox, keyed by Session
   * thread id. A separate file, so a writer of the settled map can never drop
   * hidden records.
   */
  private readonly hiddenStore: JsonFileStore<{
    version: 1;
    hidden: Record<string, Record<string, string>>;
  }>;
  constructor(dataDir: string) {
    this.store = new JsonFileStore(
      join(dataDir, 'conversation-work-state.json'),
      { version: 1, settled: {} },
      { durableAtomicWrite: true, onCorruption: 'throw' },
    );
    this.hiddenStore = new JsonFileStore(
      join(dataDir, 'conversation-inbox-hidden.json'),
      { version: 1, hidden: {} },
      { durableAtomicWrite: true, onCorruption: 'throw' },
    );
  }
  readHidden(person: string): Record<string, string> {
    return { ...this.hiddenStore.read().hidden[person] };
  }
  setHidden(
    person: string,
    sessionId: string,
    hidden: boolean,
    at: string,
  ): void {
    const data = this.hiddenStore.read();
    const entries = { ...data.hidden[person] };
    if (hidden) entries[sessionId] = at;
    else if (Object.hasOwn(entries, sessionId)) delete entries[sessionId];
    else return;
    const bounded = Object.fromEntries(
      Object.entries(entries)
        .sort((left, right) => right[1].localeCompare(left[1]))
        .slice(0, MAX_HIDDEN_SESSIONS_PER_PERSON),
    );
    this.hiddenStore.write({
      version: 1,
      hidden: { ...data.hidden, [person]: bounded },
    });
  }
  /**
   * Drops every person's settled and hidden records for `ids` (a deleted
   * conversation and its aliases), so the per-person maps do not outlive
   * what they describe. Writes only a map that held one of them.
   */
  forget(ids: readonly string[]): void {
    const prune = (map: Record<string, Record<string, string>>) => {
      let changed = false;
      const next: Record<string, Record<string, string>> = {};
      for (const [person, entries] of Object.entries(map)) {
        const kept = { ...entries };
        for (const id of ids)
          if (Object.hasOwn(kept, id)) {
            delete kept[id];
            changed = true;
          }
        next[person] = kept;
      }
      return changed ? next : null;
    };
    const settledData = this.store.read();
    const settled = prune(settledData.settled);
    if (settled) this.store.write({ ...settledData, settled });
    const hiddenData = this.hiddenStore.read();
    const hidden = prune(hiddenData.hidden);
    if (hidden) this.hiddenStore.write({ ...hiddenData, hidden });
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
