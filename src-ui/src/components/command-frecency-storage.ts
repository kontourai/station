/** Device-local persistence adapter for the palette's bounded frecency data. */

import {
  type CommandFrecencyEntry,
  normalizeCommandFrecency,
  recordCommandFrecency,
} from './command-frecency';

export const COMMAND_FRECENCY_STORAGE_KEY = 'station-command-frecency-v1';

export interface CommandFrecencyStorage {
  read(): readonly CommandFrecencyEntry[];
  record(commandId: string): boolean;
  reset(): boolean;
  /** Retire only stale Settings command ids; unrelated command history stays. */
  reconcileSettings(validIds: ReadonlySet<string>): boolean;
  subscribe(listener: () => void): () => void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface CommandFrecencyStorageOptions {
  storage?: StorageLike | null;
  now?: () => number;
}

function readEntries(storage: StorageLike | null | undefined) {
  if (!storage) return [];
  try {
    const raw = storage.getItem(COMMAND_FRECENCY_STORAGE_KEY);
    return raw === null ? [] : normalizeCommandFrecency(JSON.parse(raw));
  } catch {
    return [];
  }
}

function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * All mutations publish only after `setItem` succeeds. A failed or unavailable
 * localStorage therefore leaves both the current ranking and the in-memory
 * snapshot untouched instead of creating a misleading session-only history.
 */
export function createCommandFrecencyStorage(
  options: CommandFrecencyStorageOptions = {},
): CommandFrecencyStorage {
  const storage =
    options.storage === undefined ? browserStorage() : options.storage;
  const now = options.now ?? Date.now;
  let entries = readEntries(storage);
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((listener) => listener());
  const write = (next: CommandFrecencyEntry[]) => {
    if (!storage) return false;
    try {
      storage.setItem(COMMAND_FRECENCY_STORAGE_KEY, JSON.stringify(next));
      entries = next;
      notify();
      return true;
    } catch {
      return false;
    }
  };

  return {
    read: () => entries,
    record: (commandId) =>
      write(recordCommandFrecency(entries, commandId, now())),
    reset: () => write([]),
    reconcileSettings: (validIds) => {
      const next = entries.filter(
        (entry) =>
          !entry.commandId.startsWith('settings:') ||
          validIds.has(entry.commandId),
      );
      if (next.length === entries.length) return true;
      return write(next);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The palette's one device-local store; no settings envelope or server sync. */
export const commandFrecencyStorage = createCommandFrecencyStorage();
