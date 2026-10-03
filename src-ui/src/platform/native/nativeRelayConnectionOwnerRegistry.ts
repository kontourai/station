import type { NativeRelayConnectionOwner } from './nativeRelayConnectionOwner';

export interface NativeRelayConnectionOwnerLease {
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  release(): void;
}

interface OwnerEntry {
  readonly controller: AbortController;
  pending?: Promise<NativeRelayConnectionOwner>;
  owner?: NativeRelayConnectionOwner;
}

const entries = new Map<string, OwnerEntry>();

function forgetEntry(key: string, entry: OwnerEntry) {
  if (entries.get(key) === entry) entries.delete(key);
  entry.controller.abort();
}

function retireEntry(key: string, entry: OwnerEntry) {
  if (entries.get(key) !== entry) return;
  if (entry.owner) entry.owner.dispose();
  if (entries.get(key) === entry) forgetEntry(key, entry);
}

export function retireNativeRelayConnectionOwners() {
  for (const [key, entry] of [...entries]) retireEntry(key, entry);
}

export function captureNativeRelayConnectionOwner(key: string | null) {
  const entry = key ? entries.get(key) : undefined;
  const owner = entry?.owner;
  return entry && !entry.controller.signal.aborted && owner?.isCurrent()
    ? owner
    : null;
}

export function prepareRegisteredNativeRelayConnectionOwner(
  key: string,
  create: (
    lease: NativeRelayConnectionOwnerLease,
  ) => Promise<NativeRelayConnectionOwner>,
): Promise<NativeRelayConnectionOwner> {
  const current = entries.get(key);
  if (current?.owner?.isCurrent()) return Promise.resolve(current.owner);
  if (current?.pending && !current.owner) return current.pending;
  if (current) retireEntry(key, current);

  for (const [otherKey, entry] of [...entries]) {
    if (otherKey !== key) retireEntry(otherKey, entry);
  }

  const entry: OwnerEntry = { controller: new AbortController() };
  const lease: NativeRelayConnectionOwnerLease = {
    signal: entry.controller.signal,
    isCurrent: () =>
      entries.get(key) === entry && !entry.controller.signal.aborted,
    release: () => forgetEntry(key, entry),
  };
  const pending = Promise.resolve()
    .then(() => create(lease))
    .then((owner) => {
      if (!lease.isCurrent() || !owner.application.isCurrent()) {
        owner.dispose();
        throw new Error('native_relay_connection_owner_retired');
      }
      entry.owner = owner;
      return owner;
    })
    .catch((error: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      entry.controller.abort();
      throw error;
    });
  entry.pending = pending;
  entries.set(key, entry);
  return pending;
}
