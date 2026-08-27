/**
 * `KnownEnvironment` registry (station#1096 R2) — CRUD + persistence for the
 * unified "environments I know how to reach" model defined in
 * `@kontourai/station-contracts`'s `known-environment.ts`.
 *
 * This is deliberately a NEW, smaller store, not a rename of
 * `ConnectionStore`/`SavedConnection` above. `ConnectionStore` already owns
 * the richer, reconnect-state-tracking persistence behind the device-pairing
 * UI (credential refs, endpoint candidates, access-method selection) and
 * keeps that job. `KnownEnvironmentRegistry` exists for two things
 * `ConnectionStore` does not do:
 *   1. entries with NO credential concept at all (a manually-noted address,
 *      a CLI host, a read-adapted SSH profile) — see the "no secrets" rule
 *      on `KnownEnvironment` itself;
 *   2. a persistence shape defined against the SAME `StorageAdapter`
 *      interface `ConnectionStore` already uses, so a Node/CLI-backed
 *      adapter is a drop-in, not a rewrite. Today only the browser side is
 *      actually wired (`LocalStorageAdapter`, `./storage`, used by the
 *      Connections hub); a Node adapter exists (`NodeFileStorageAdapter`,
 *      `./nodeStorage`) and is tested, but nothing in `packages/cli`
 *      constructs a registry with it yet — see that file's own doc comment
 *      for the current, honest state of that gap.
 *
 * The identity-merge logic below (`attachEnvironmentDescriptor`) mirrors
 * `ConnectionStore.reconcileHandshake`'s shape (stable-environment-wins,
 * endpoints combined, no duplicate `KnownEnvironment` per `environmentId`)
 * but is simpler: there is no credential state, endpoint-candidate
 * confirmation flow, or access-method selection to reconcile — just
 * endpoints.
 */
import type {
  AccessEndpoint,
  AccessEndpointKind,
  KnownEnvironment,
  KnownEnvironmentSource,
} from '@kontourai/station-contracts';
import { KNOWN_ENVIRONMENT_SCHEMA_VERSION } from '@kontourai/station-contracts';
import { normalizeBaseUrl } from '@kontourai/station-contracts/http';
import { defaultStorage } from './storage';
import type { StorageAdapter } from './types';

const DEFAULT_STORAGE_KEY = 'station-known-environments';

function uuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface CreateKnownEnvironmentInput {
  label: string;
  httpBaseUrl: string;
  source: KnownEnvironmentSource;
  kind?: AccessEndpointKind;
  /** Pre-known identity, e.g. an SSH profile that already verified once. */
  environmentId?: string;
  now?: number;
}

/**
 * Canonicalizes any producer's endpoint URL to the bare origin (drops path,
 * trailing slash, query, fragment) before it ever reaches `httpBaseUrl` or
 * the dedup/merge logic below. Exported so every producer of a
 * `KnownEnvironment` endpoint — this module's own `createEndpoint`, the SSH
 * adapter (`packages/sdk/src/query-domains/knownEnvironments.ts`), the
 * paired/manual adapter (`src-ui/src/views/connections-hub/knownEnvironmentAdapters.ts`),
 * and the CLI adapter (`packages/cli/src/commands/hosts.ts`) — normalizes
 * through the SAME function, not four independent ones. `mergeIntoStable`'s
 * dedup below only compares `httpBaseUrl` by raw string equality; two
 * producers disagreeing on trailing-slash/casing would silently defeat that
 * dedup and AC1's whole premise (fix round 1, station#1096).
 */
// Re-exported for existing connect consumers; the implementation lives in
// contracts so the published SDK can use it without importing connect.
export { normalizeBaseUrl };

function createEndpoint(
  httpBaseUrl: string,
  kind: AccessEndpointKind,
  now: number,
): AccessEndpoint {
  return {
    id: `endpoint:${kind}:${encodeURIComponent(normalizeBaseUrl(httpBaseUrl))}`,
    httpBaseUrl: normalizeBaseUrl(httpBaseUrl),
    kind,
    addedAt: now,
  };
}

/** Builds a new, not-yet-persisted `KnownEnvironment` from scratch. */
export function createKnownEnvironment(
  input: CreateKnownEnvironmentInput,
): KnownEnvironment {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: KNOWN_ENVIRONMENT_SCHEMA_VERSION,
    id: uuid(),
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    label: input.label,
    source: input.source,
    endpoints: [createEndpoint(input.httpBaseUrl, input.kind ?? 'direct', now)],
    createdAt: now,
    updatedAt: now,
  };
}

/** Adds `endpoint` to `environment`, deduping by `httpBaseUrl`. */
export function addEndpoint(
  environment: KnownEnvironment,
  endpoint: AccessEndpoint,
  now = Date.now(),
): KnownEnvironment {
  const exists = environment.endpoints.some(
    (candidate) => candidate.httpBaseUrl === endpoint.httpBaseUrl,
  );
  if (exists) return environment;
  return {
    ...environment,
    endpoints: [...environment.endpoints, endpoint],
    updatedAt: now,
  };
}

/**
 * Merges `stable`'s and `candidate`'s endpoints (union, deduped by
 * `httpBaseUrl`) into a `KnownEnvironment` that keeps `stable`'s identity
 * (`id`, `createdAt`, `source`, `label`) — the "stable entry wins" rule
 * `ConnectionStore.mergeStableEnvironment` also follows, so an environment's
 * local id and label never change out from under a caller just because a
 * second, newer-registered endpoint turned out to be the same station.
 */
export function mergeIntoStable(
  stable: KnownEnvironment,
  candidate: KnownEnvironment,
  now = Date.now(),
): KnownEnvironment {
  const seen = new Set(
    stable.endpoints.map((endpoint) => endpoint.httpBaseUrl),
  );
  const merged = [
    ...stable.endpoints,
    ...candidate.endpoints.filter(
      (endpoint) => !seen.has(endpoint.httpBaseUrl),
    ),
  ];
  return { ...stable, endpoints: merged, updatedAt: now };
}

/**
 * Attaches `environmentId` to `environment` (the first-handshake upgrade
 * path) against the rest of `list`. If another entry in `list` already
 * carries this `environmentId`, the two are the same station: the result is
 * `list` with `environment` removed and its endpoints folded into the
 * existing stable entry (station#1096 AC1). Otherwise `environment` is
 * returned in place with `environmentId` newly set.
 */
export function attachEnvironmentDescriptor(
  list: readonly KnownEnvironment[],
  environmentId: string,
  targetId: string,
  now = Date.now(),
): KnownEnvironment[] {
  const target = list.find((item) => item.id === targetId);
  if (!target) return [...list];
  const stable = list.find(
    (item) => item.id !== targetId && item.environmentId === environmentId,
  );
  if (stable) {
    const merged = mergeIntoStable(stable, target, now);
    return list
      .filter((item) => item.id !== targetId && item.id !== stable.id)
      .concat(merged);
  }
  return list.map((item) =>
    item.id === targetId ? { ...item, environmentId, updatedAt: now } : item,
  );
}

/**
 * Folds `incoming` into `list` by `environmentId` when both are known,
 * otherwise appends it as a distinct entry. Used to merge read-adapted
 * environments (SSH profiles, CLI hosts) into a registry's own list for
 * display, without mutating either source. Pure — does not persist.
 */
export function mergeKnownEnvironments(
  list: readonly KnownEnvironment[],
  incoming: KnownEnvironment,
  now = Date.now(),
): KnownEnvironment[] {
  if (!incoming.environmentId) return [...list, incoming];
  const stable = list.find(
    (item) => item.environmentId === incoming.environmentId,
  );
  if (!stable) return [...list, incoming];
  return list.map((item) =>
    item.id === stable.id ? mergeIntoStable(item, incoming, now) : item,
  );
}

export interface KnownEnvironmentRegistryOptions {
  storage?: StorageAdapter;
  storageKey?: string;
}

/**
 * CRUD + persistence for locally-registered `KnownEnvironment`s (manual
 * entries, plus any entry a caller wants durably remembered). Read-adapted
 * entries from other mechanisms (SSH profiles, paired `SavedConnection`s)
 * are NOT stored here — they are folded in at read time by the consumer
 * (see the Connections hub adoption, station#1096 R4) via
 * `mergeKnownEnvironments`, so this registry never becomes a second source
 * of truth for data another store already owns.
 */
export class KnownEnvironmentRegistry {
  private storage: StorageAdapter;
  private storageKey: string;
  private listeners = new Set<() => void>();
  // `useSyncExternalStore` requires a referentially-stable snapshot between
  // renders that didn't write — without this cache, `getAll()` re-parsing
  // JSON on every call returns a new array each time and React treats every
  // render as a store change, looping forever (mirrors `ConnectionStore`'s
  // identical cache for the identical reason).
  private cached: KnownEnvironment[] | null = null;

  constructor(options: KnownEnvironmentRegistryOptions = {}) {
    this.storage = options.storage ?? defaultStorage;
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  }

  private read(): KnownEnvironment[] {
    if (this.cached) return this.cached;
    try {
      const raw = this.storage.get(this.storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      this.cached = Array.isArray(parsed) ? (parsed as KnownEnvironment[]) : [];
    } catch {
      this.cached = [];
    }
    return this.cached;
  }

  private write(list: KnownEnvironment[]): void {
    this.storage.set(this.storageKey, JSON.stringify(list));
    this.cached = list;
    for (const listener of this.listeners) listener();
  }

  getAll(): KnownEnvironment[] {
    return this.read();
  }

  get(id: string): KnownEnvironment | undefined {
    return this.read().find((item) => item.id === id);
  }

  add(input: CreateKnownEnvironmentInput): KnownEnvironment {
    const list = this.read();
    const created = createKnownEnvironment(input);
    this.write([...list, created]);
    return created;
  }

  remove(id: string): void {
    this.write(this.read().filter((item) => item.id !== id));
  }

  /** See `attachEnvironmentDescriptor` — this is its persisted counterpart. */
  attachEnvironmentDescriptor(
    id: string,
    environmentId: string,
    now = Date.now(),
  ): KnownEnvironment | null {
    const list = this.read();
    if (!list.some((item) => item.id === id)) return null;
    const updated = attachEnvironmentDescriptor(list, environmentId, id, now);
    this.write(updated);
    return (
      updated.find((item) => item.id === id) ??
      updated.find((item) => item.environmentId === environmentId) ??
      null
    );
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
