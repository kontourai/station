import { ListenerManager } from '../core/ListenerManager.js';
import type { VoiceSessionAdapter } from './session-types.js';

export interface VoiceSessionAdapterRegistration {
  readonly adapter: VoiceSessionAdapter;
  dispose(): void;
}

interface Entry {
  readonly adapter: VoiceSessionAdapter;
}

/**
 * Incremental registry with registration-identity disposal. For matching IDs,
 * the most recently registered live adapter is the visible adapter.
 */
export class VoiceSessionAdapterRegistry extends ListenerManager {
  private readonly entries: Entry[] = [];
  private cachedAdapters: readonly VoiceSessionAdapter[] = Object.freeze([]);

  register(adapter: VoiceSessionAdapter): VoiceSessionAdapterRegistration {
    const entry: Entry = { adapter };
    this.entries.push(entry);
    this.rebuildVisibleSnapshot();

    let disposed = false;
    return {
      adapter,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const index = this.entries.indexOf(entry);
        if (index < 0) return;
        this.entries.splice(index, 1);
        this.rebuildVisibleSnapshot();
      },
    };
  }

  get(id: string): VoiceSessionAdapter | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.adapter.descriptor.id === id) return entry.adapter;
    }
    return undefined;
  }

  getAll(): readonly VoiceSessionAdapter[] {
    return this.cachedAdapters;
  }

  private rebuildVisibleSnapshot(): void {
    const seenIds = new Set<string>();
    const reversed: VoiceSessionAdapter[] = [];
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      const id = entry.adapter.descriptor.id;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        reversed.push(entry.adapter);
      }
    }
    const next = reversed.reverse();
    if (
      next.length === this.cachedAdapters.length &&
      next.every((adapter, index) => adapter === this.cachedAdapters[index])
    ) {
      return;
    }
    this.cachedAdapters = Object.freeze(next);
    this._notify();
  }
}

export const voiceSessionAdapterRegistry = new VoiceSessionAdapterRegistry();
