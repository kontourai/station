import type { OrchestrationSequencedEvent } from '@kontourai/station-contracts/orchestration';
import { createStore, get, update } from 'idb-keyval';
import { buildInfo } from '../build-info';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const buster = () => `${buildInfo.version}+${buildInfo.commit}`;

const MAX_CONVERSATIONS = 20;
const MAX_COPY_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const KEY = 'reading';
let storage: ReturnType<typeof createStore> | undefined;
const store = () =>
  (storage ??= createStore('station-offline-reading', 'copies'));
interface OfflineTurn {
  role: 'user' | 'assistant';
  text: string;
}
export interface OfflineCopy {
  conversationId: string;
  savedAt: number;
  expiresAt: number;
  turns: OfflineTurn[];
  truncated: boolean;
}
interface Shelf {
  namespace: string;
  binding: string;
  buster: string;
  enabled: boolean;
  revision: number;
  copies: OfflineCopy[];
}

function changed() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event('station:offline-reading-changed'));
  if (typeof window.BroadcastChannel === 'function') {
    const channel = new BroadcastChannel('station-offline-reading');
    channel.postMessage(null);
    channel.close();
  }
}

export function subscribeOfflineReading(listener: () => void) {
  window.addEventListener('station:offline-reading-changed', listener);
  const channel =
    typeof window.BroadcastChannel === 'function'
      ? new BroadcastChannel('station-offline-reading')
      : undefined;
  channel?.addEventListener('message', listener);
  return () => {
    window.removeEventListener('station:offline-reading-changed', listener);
    channel?.close();
  };
}

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
function valid(shelf: Shelf | undefined, namespace: string): shelf is Shelf {
  return shelf?.namespace === namespace && shelf.buster === buster();
}
const freshCopies = (copies: OfflineCopy[]) =>
  copies.filter((copy) => Date.now() < copy.expiresAt);

async function retainedShelf() {
  const shelf = await get<Shelf>(KEY, store());
  if (!shelf) return undefined;
  const outdated = shelf.buster !== buster();
  const copies = outdated ? [] : freshCopies(shelf.copies);
  if (outdated || copies.length !== shelf.copies.length) {
    await update<Shelf | undefined>(
      KEY,
      (current) => {
        if (!current || current.revision !== shelf.revision) return current;
        return {
          ...current,
          buster: buster(),
          copies: outdated ? [] : freshCopies(current.copies),
          enabled: !outdated && current.enabled,
          revision: current.revision + 1,
        };
      },
      store(),
    );
    return get<Shelf>(KEY, store());
  }
  return shelf;
}

export async function readOfflineReading(namespace: string) {
  const shelf = await retainedShelf();
  return valid(shelf, namespace)
    ? { enabled: shelf.enabled, copies: freshCopies(shelf.copies) }
    : { enabled: false, copies: [] as OfflineCopy[] };
}

/** Disabling and clearing both revoke in-flight writes, including in another tab. */
export async function configureOfflineReading(
  namespace: string,
  binding: string,
  enabled: boolean,
  isCurrent: () => boolean,
) {
  await update<Shelf | undefined>(
    KEY,
    (shelf) => {
      if (!isCurrent()) return shelf;
      return {
        namespace,
        binding,
        buster: buster(),
        enabled,
        revision: (shelf?.revision ?? 0) + 1,
        copies:
          enabled && valid(shelf, namespace) ? freshCopies(shelf.copies) : [],
      };
    },
    store(),
  );
  changed();
}

export async function clearOfflineReading() {
  if (typeof indexedDB === 'undefined') return;
  // Keep a tombstone so a delayed writer cannot recreate a cleared shelf.
  await update<Shelf>(
    KEY,
    (shelf) => ({
      namespace: '',
      binding: '',
      buster: '',
      enabled: false,
      revision: (shelf?.revision ?? 0) + 1,
      copies: [],
    }),
    store(),
  );
  changed();
}

/** Only a successfully read history window calls this; live state never reads these bytes. */
export async function saveOfflineReading(
  namespace: string,
  conversationId: string,
  events: readonly OrchestrationSequencedEvent[],
  isCurrent: () => boolean,
) {
  if (new TextEncoder().encode(conversationId).length > 1024) return;
  const before = await get<Shelf>(KEY, store());
  if (!valid(before, namespace) || !before.enabled || !isCurrent()) return;
  // Persist a closed text projection: no tool arguments/results, reasoning,
  // attachments, provider metadata, resume cursors or ambient context.
  const turns: OfflineTurn[] = [];
  const ids = [
    ...new Set(
      events
        .filter(({ event }) => event.method === 'turn.started')
        .map(({ event }) => event.turnId),
    ),
  ].slice(-10);
  for (const id of ids) {
    const prompt = events.find(
      ({ event }) => event.method === 'turn.started' && event.turnId === id,
    )?.event;
    if (prompt?.method === 'turn.started' && prompt.prompt)
      turns.push({ role: 'user', text: prompt.prompt });
    const text = events
      .filter(
        ({ event }) =>
          event.method === 'content.text-delta' && event.turnId === id,
      )
      .map(({ event }) =>
        event.method === 'content.text-delta' ? event.delta : '',
      )
      .join('');
    if (text) turns.push({ role: 'assistant', text });
  }
  const copy: OfflineCopy = {
    conversationId,
    savedAt: Date.now(),
    expiresAt: Date.now() + MAX_AGE_MS,
    turns: [],
    truncated: false,
  };
  // Retain the newest text, bounded by UTF-8 bytes of the full stored record.
  for (const turn of turns.reverse()) {
    const candidate = { ...copy, turns: [turn, ...copy.turns] };
    if (bytes(candidate) <= MAX_COPY_BYTES) copy.turns.unshift(turn);
    else {
      copy.truncated = true;
      if (copy.turns.length === 0) {
        let text = turn.text;
        while (bytes({ ...copy, turns: [{ ...turn, text }] }) > MAX_COPY_BYTES)
          text = text.slice(Math.ceil(text.length / 4));
        copy.turns.unshift({ ...turn, text });
      }
      break;
    }
  }
  if (!copy.turns.length) return;
  await update<Shelf | undefined>(
    KEY,
    (shelf) => {
      if (
        !isCurrent() ||
        !valid(shelf, namespace) ||
        !shelf.enabled ||
        shelf.revision !== before.revision
      )
        return shelf;
      const copies = [
        copy,
        ...freshCopies(shelf.copies).filter(
          (old) => old.conversationId !== conversationId,
        ),
      ].slice(0, MAX_CONVERSATIONS);
      while (copies.length && bytes({ ...shelf, copies }) > MAX_TOTAL_BYTES)
        copies.pop();
      return { ...shelf, copies };
    },
    store(),
  );
  changed();
}

/** Deliberate local reading only: never hydrates a QueryClient or asserts identity. */
export async function readDeviceOfflineCopies(binding: string) {
  const shelf = await retainedShelf();
  return shelf?.enabled &&
    shelf.binding === binding &&
    shelf.buster === buster()
    ? freshCopies(shelf.copies)
    : [];
}

export async function discardForeignOfflineReading(namespace: string) {
  await update<Shelf | undefined>(
    KEY,
    (shelf) => {
      if (!shelf || shelf.namespace === namespace) return shelf;
      return {
        ...shelf,
        enabled: false,
        copies: [],
        revision: shelf.revision + 1,
      };
    },
    store(),
  );
  changed();
}
