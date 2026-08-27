import {
  createDirectHttpAccessMethod,
  createHostTunnelAccessMethod,
} from './accessMethods';
import { classifyConnectionFailure } from './connectionFailureClassification';
import {
  deriveCredentialState,
  isSameConnectionOrigin,
  mergeHostAccessProfiles,
  normalizeConnectionProfile,
} from './connectionProfile';
import { recordConnectionSuccess } from './connectionSuccess';
import { createAccessEndpoint } from './environmentProfiles';
import { defaultCredentialStorage, defaultStorage } from './storage';
import type {
  AccessEndpoint,
  InjectedConnection,
  SavedConnection,
  StationHandshakeIdentity,
  StorageAdapter,
} from './types';

const DEFAULT_KEY = 'station-connect-connections';
const ACTIVE_KEY_SUFFIX = '-active';
const CREDENTIAL_KEY_SUFFIX = '-credentials';
const GENERATION_KEY_PREFIX = '-generation:';
const AUTHORITY_KEY_PREFIX = '-credential-authority:';
/**
 * Tombstones. One per retired counter per removed connection, holding the
 * first value a connection recreated under that same id is allowed to use.
 */
const RETIRED_GENERATION_KEY_PREFIX = '-retired-generation:';
const RETIRED_AUTHORITY_KEY_PREFIX = '-retired-credential-authority:';

function uuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * The slice of the Web Locks API this store uses, named structurally so the
 * package stays testable and free of a DOM-lib dependency for it.
 */
export interface ConnectionStoreLockManager {
  request(name: string, callback: () => void | Promise<void>): Promise<unknown>;
}

/**
 * The browser's own lock manager, when the page has one. Absent in Node, in
 * SSR, in a non-secure context, and in jsdom — every one of which is a single
 * document, where the synchronous fallback IS serialization.
 */
function defaultLockManager(): ConnectionStoreLockManager | undefined {
  const locks = (
    globalThis as {
      navigator?: { locks?: Partial<ConnectionStoreLockManager> };
    }
  ).navigator?.locks;
  return locks && typeof locks.request === 'function'
    ? (locks as ConnectionStoreLockManager)
    : undefined;
}

export class ConnectionStore {
  private storage: StorageAdapter;
  private storageKey: string;
  private activeKey: string;
  private credentialKey: string;
  private generationPrefix: string;
  private authorityPrefix: string;
  /**
   * Live counter prefix → the prefix holding its retired epochs, so every read
   * of a counter can find the floor a removal left behind (#3626).
   */
  private retiredCounterPrefixes: ReadonlyMap<string, string>;
  private locks: ConnectionStoreLockManager | undefined;
  private lockName: string;
  /**
   * Depth of the currently held serialization, so a nested mutation (a
   * rejection bumping a counter inside an already-serialized sequence) runs
   * straight through instead of deadlocking on the exclusive lock it is
   * already inside.
   */
  private lockDepth = 0;
  /**
   * This document's own view of each counter, never lower than what it has
   * written. Reads take the MAXIMUM of this and shared storage, so a counter
   * can never regress for this document even while a serialized write is
   * still queued, and a request issued in the same tick as a pairing captures
   * the invalidation the pairing just made.
   */
  private counterView = new Map<string, number>();
  /**
   * This document's own profile snapshot while a serialized write of it is
   * still queued, and the number of those queued writes.
   *
   * Every writer of shared storage now takes the same lock (review, HIGH): a
   * lock that pairing bypassed gave no exclusion against the writer that
   * matters most, so an old 401's reporter could take the lock, read a shared
   * generation that a queued pairing had not reached yet, and flip the freshly
   * paired profile back to `required`.
   *
   * Taking the lock would ordinarily make a pairing's effect asynchronous,
   * which is the race `captureCredentialEvidence` exists to prevent. So the
   * profile is applied HERE synchronously — `read()` prefers it, and every
   * same-tick reader (evidence capture, the snapshot the UI renders, this
   * document's own reporters) therefore sees the pairing immediately — while
   * only the shared-storage write waits for the lock.
   *
   * It exists exactly as long as a write is in flight: with no lock manager
   * the flush is synchronous and the overlay is retired within the same call,
   * so a store with no locks reads shared storage on every operation exactly
   * as it did before.
   *
   * PER CONNECTION, and only for connections this document actually changed
   * (delta review 2, MEDIUM). A whole-list snapshot shadowed every other
   * connection too, so another tab's update stayed invisible here — and was
   * then overwritten — until this document's unrelated write drained. The
   * overlay is applied over freshly read shared state on every read AND at
   * flush time, so a write publishes a merge rather than a snapshot.
   */
  private pendingConnections = new Map<string, SavedConnection>();
  /**
   * The subset of `pendingConnections` this document CREATED — ids that were
   * absent from the snapshot their write was computed from.
   *
   * Only these may be appended to shared storage by a flush (#3626 review,
   * H2). An overlay entry for an id that shared storage no longer has is
   * otherwise indistinguishable from a new connection, so a queued write for a
   * connection ANOTHER document removed in the meantime re-added it — the
   * removal was durable against counters and not against overlays.
   */
  private pendingCreated = new Set<string>();
  /**
   * The retired-epoch floor each overlay entry was claimed against. A removal
   * landing afterwards raises it, which is how a flush tells "shared storage
   * has not seen this yet" from "this connection has since been removed".
   */
  private pendingRetiredFloor = new Map<string, number>();
  private pendingRemovals = new Set<string>();
  private pendingActive: { value: string | null } | null = null;
  private pendingWrites = 0;
  private credentialStorage: StorageAdapter;
  private listeners: Set<() => void> = new Set();

  // Stable snapshot cache — useSyncExternalStore requires referential stability
  private _cachedAll: SavedConnection[] | null = null;
  private _cachedActive: SavedConnection | null = null;
  private _cacheValid = false;

  // Host-injected connection (bundled-server loopback or CLI base). Never
  // persisted; composed into the connection list at read time.
  private injected: SavedConnection | null = null;

  constructor(
    opts: {
      storage?: StorageAdapter;
      credentialStorage?: StorageAdapter;
      storageKey?: string;
      /**
       * Cross-document serialization for the counter and reporter paths.
       * Defaults to the page's own `navigator.locks`; pass one explicitly to
       * drive the serialized path in a test, or `null` to force the
       * synchronous fallback.
       */
      locks?: ConnectionStoreLockManager | null;
    } = {},
  ) {
    this.storage = opts.storage ?? defaultStorage;
    this.credentialStorage =
      opts.credentialStorage ?? opts.storage ?? defaultCredentialStorage;
    this.storageKey = opts.storageKey ?? DEFAULT_KEY;
    this.activeKey = this.storageKey + ACTIVE_KEY_SUFFIX;
    this.credentialKey = this.storageKey + CREDENTIAL_KEY_SUFFIX;
    this.generationPrefix = this.storageKey + GENERATION_KEY_PREFIX;
    this.authorityPrefix = this.storageKey + AUTHORITY_KEY_PREFIX;
    this.retiredCounterPrefixes = new Map([
      [this.generationPrefix, this.storageKey + RETIRED_GENERATION_KEY_PREFIX],
      [this.authorityPrefix, this.storageKey + RETIRED_AUTHORITY_KEY_PREFIX],
    ]);
    this.locks =
      opts.locks === undefined
        ? defaultLockManager()
        : (opts.locks ?? undefined);
    this.lockName = `station-connect:${this.storageKey}`;
  }

  /**
   * Runs a check-then-write sequence with cross-document exclusion when the
   * page has the Web Locks API, and synchronously when it does not.
   *
   * The sequences that need it are the two REPORTER paths — a rejection and an
   * accepted authenticated response. Both read the current profile and
   * generation, decide whether the report is still current, and only then
   * write; another document pairing or rejecting between the decision and the
   * write is exactly the lost update #3600 set out to close, and the previous
   * revision closed only the read side of it.
   *
   * Deliberately NOT applied to the pairing/credential-set paths. Those are
   * user intent rather than a report about an in-flight request: last writer
   * wins is the correct rule for them, and deferring their profile write to a
   * lock callback would leave a request issued in the same tick as the pairing
   * authenticated against the pre-pairing snapshot — the race
   * `captureCredentialEvidence` exists to prevent.
   *
   * Fire-and-forget on purpose: both callers are SDK response reporters that
   * already ignore the result, and the store notifies its listeners when the
   * write lands. When the lock cannot be acquired at all, the work still runs
   * — an unserialized write is the previous behaviour, and skipping it would
   * silently drop the evidence.
   */
  private serialize(work: () => void): void | Promise<void> {
    if (!this.locks || this.lockDepth > 0) {
      this.runSerialized(work);
      return;
    }
    let ran = false;
    return this.locks
      .request(this.lockName, () => {
        ran = true;
        this.runSerialized(work);
      })
      .then(
        () => undefined,
        (error: unknown) => {
          // A lock that could not be ACQUIRED must not lose the work: an
          // unserialized write is the no-lock behaviour, and dropping it
          // would silently discard the evidence this call carries.
          if (!ran) {
            this.runSerialized(work);
            return;
          }
          // The work itself threw. It used to be swallowed here, which turned
          // a failed storage write into silence in the locked path only
          // (review, lock-release note).
          this.reportSerializedFailure(error);
        },
      );
  }

  private runSerialized(work: () => void): void {
    this.lockDepth += 1;
    try {
      work();
    } finally {
      this.lockDepth -= 1;
    }
  }

  private reportSerializedFailure(error: unknown): void {
    try {
      console.error('[station-connect] serialized store write failed', error);
    } catch {
      // A host without a usable console must not turn a write failure into a
      // second, louder one.
    }
  }

  /**
   * Observes another tab's writes to the profile, active-pointer, generation
   * and credential-authority keys this store owns, so this tab's cached snapshot is not
   * left contradicting shared storage (#3600). The browser only delivers
   * `storage` events for writes made by OTHER documents, which is exactly the
   * set this needs: a local write already invalidates the cache itself.
   *
   * Notification-only, like `reload()`: nothing is validated or merged here,
   * the next read re-normalizes from storage. The caller owns the lifetime —
   * `ConnectionsProvider` registers it for the app; a test registers it for
   * the tab it is playing.
   */
  observeStorageEvents(): () => void {
    if (typeof window === 'undefined') return () => {};
    const listener = (event: StorageEvent) => {
      // `key: null` is the spec's "the whole store was cleared".
      if (event.key !== null && !this.ownsStorageKey(event.key)) return;
      this.reload();
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  }

  private ownsStorageKey(key: string): boolean {
    return (
      key === this.storageKey ||
      key === this.activeKey ||
      key.startsWith(this.generationPrefix) ||
      key.startsWith(this.authorityPrefix) ||
      [...this.retiredCounterPrefixes.values()].some((prefix) =>
        key.startsWith(prefix),
      )
    );
  }

  private normalize(connection: Partial<SavedConnection>): SavedConnection {
    const rawUrl = connection.url ?? '';
    return normalizeConnectionProfile(
      connection,
      this.endpointFor(rawUrl),
      connection.id ?? uuid(),
    );
  }

  private endpointFor(url: string, priority = 100): AccessEndpoint {
    try {
      return createAccessEndpoint(url, { priority });
    } catch {
      return {
        endpointVersion: 1,
        id: `endpoint:manual:${encodeURIComponent(url)}`,
        url,
        kind: 'manual',
        priority,
      };
    }
  }

  private capabilitiesForHandshake(
    handshake: StationHandshakeIdentity,
  ): SavedConnection['capabilities'] {
    if (!handshake.transports) return null;
    return {
      capabilityVersion: handshake.schemaVersion ?? 1,
      sessionIndex: handshake.transports.http >= 1,
      eventStream:
        handshake.transports.sse >= 1 || handshake.transports.websocket >= 1,
    };
  }

  private read(): { connections: SavedConnection[]; activeId: string | null } {
    // This document's own queued changes are newer than shared storage, and
    // the operation being computed right now must build on them rather than on
    // the state they are about to replace — but only for the connections they
    // actually cover. Everything else comes from shared storage, so another
    // document's update is visible immediately.
    const shared = this.readShared();
    return this.hasPendingChanges() ? this.applyLocalOverlay(shared) : shared;
  }

  /**
   * Whether a connection was retired after this document claimed its overlay
   * entry — the entry then describes a connection that no longer exists.
   */
  private overlayEntryWasRetired(id: string): boolean {
    const claimedAgainst = this.pendingRetiredFloor.get(id);
    if (claimedAgainst === undefined) return false;
    return this.retiredCounterFloor(this.generationPrefix, id) > claimedAgainst;
  }

  private forgetOverlayEntry(id: string): void {
    this.pendingConnections.delete(id);
    this.pendingCreated.delete(id);
    this.pendingRetiredFloor.delete(id);
  }

  private hasPendingChanges(): boolean {
    return (
      this.pendingConnections.size > 0 ||
      this.pendingRemovals.size > 0 ||
      this.pendingActive !== null
    );
  }

  private applyLocalOverlay(shared: {
    connections: SavedConnection[];
    activeId: string | null;
  }): { connections: SavedConnection[]; activeId: string | null } {
    const seen = new Set<string>();
    const connections: SavedConnection[] = [];
    for (const item of shared.connections) {
      seen.add(item.id);
      if (this.pendingRemovals.has(item.id)) continue;
      const local = this.pendingConnections.get(item.id);
      // An entry claimed before a removal describes a connection that no
      // longer exists — publishing it over whatever holds that id now would
      // restore a profile the user deleted.
      connections.push(
        local && !this.overlayEntryWasRetired(item.id) ? local : item,
      );
    }
    // Connections this document CREATED that shared storage has not seen yet,
    // in the order they were created. An entry for an id this document did not
    // create is absent from shared storage because someone REMOVED it, and
    // appending it here is a resurrection (#3626 review, H2).
    for (const [id, local] of this.pendingConnections) {
      if (seen.has(id)) continue;
      if (!this.pendingCreated.has(id)) continue;
      if (this.overlayEntryWasRetired(id)) continue;
      connections.push(local);
    }
    return {
      connections,
      activeId: this.pendingActive ? this.pendingActive.value : shared.activeId,
    };
  }

  private readShared(): {
    connections: SavedConnection[];
    activeId: string | null;
  } {
    try {
      const raw = this.storage.get(this.storageKey);
      const parsed: Partial<SavedConnection>[] = raw ? JSON.parse(raw) : [];
      const connections = Array.isArray(parsed)
        ? parsed.map((connection) => this.normalize(connection))
        : [];
      if (
        Array.isArray(parsed) &&
        this.pendingWrites === 0 &&
        JSON.stringify(parsed) !== JSON.stringify(connections)
      ) {
        // Migration rewrite. Skipped while a local write is in flight: that
        // write publishes the normalized list anyway, and this one is not
        // serialized.
        this.storage.set(this.storageKey, JSON.stringify(connections));
      }
      const activeId = this.storage.get(this.activeKey);
      return { connections, activeId };
    } catch {
      return { connections: [], activeId: null };
    }
  }

  private invalidateCache(): void {
    this._cacheValid = false;
    this._cachedAll = null;
    this._cachedActive = null;
  }

  private ensureCache(): void {
    if (this._cacheValid && this._cachedAll !== null) return;
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    // The injected connection (if any) is prepended and never persisted. A
    // mobile default is only a cold-boot routing hint: when a native paired
    // profile already names the same normalized origin, showing both would
    // duplicate one Station and hide the profile that owns its credential.
    // A desktop-managed loopback is different: same-origin profiles can be
    // distinct paired Stations, so it may coalesce only with the saved local
    // profile whose host-owned service identity exactly matches the injected
    // sidecar. That keeps the saved profile (and therefore its native
    // credential/default selection) as the one visible connection.
    const injected = this.injected;
    const matchingMobileDefault =
      injected?.injectedSource === 'mobile-default'
        ? connections.find((connection) =>
            isSameConnectionOrigin(connection.url, injected.url),
          )
        : undefined;
    const matchingManagedLoopback =
      injected?.injectedSource === 'managed-loopback' && injected.ownerId
        ? connections.find(
            (connection) => connection.ownerId === injected.ownerId,
          )
        : undefined;
    const listedInjected =
      matchingMobileDefault || matchingManagedLoopback ? null : injected;
    const composed = listedInjected
      ? [listedInjected, ...connections]
      : connections;
    this._cachedAll = composed;
    // Active resolution: an explicit active id wins, but a url-less injected
    // connection (a not-running supervised bundled server) is never selectable
    // — there is no base to talk to — so it is excluded here even if an
    // `activeId` somehow names it. It still appears in `composed`. Otherwise the
    // injected connection wins when it is usable as a base, else the first saved
    // connection. The url-carrying path (a running loopback or a CLI base) is
    // byte-for-byte the prior behavior.
    const injectedActive =
      listedInjected && this.injectedIsActive(listedInjected)
        ? listedInjected
        : null;
    const explicit = activeId
      ? composed.find((c) => c.id === activeId)
      : undefined;
    // Don't let an explicit id resolve onto a down injected connection. Today
    // `setActive` already refuses ids outside the persisted list, but that is a
    // cross-file invariant — enforce it here so active resolution is correct on
    // its own terms regardless of how `activeId` was set.
    const usableExplicit =
      explicit && (!explicit.injected || this.injectedIsActive(explicit))
        ? explicit
        : undefined;
    this._cachedActive =
      usableExplicit ??
      injectedActive ??
      matchingMobileDefault ??
      matchingManagedLoopback ??
      connections[0] ??
      null;
    this._cacheValid = true;
  }

  /**
   * Publishes a mutation's result.
   *
   * `input` is the snapshot the mutation was COMPUTED FROM — the same `read()`
   * whose contents it transformed — and it is what decides which connections
   * this document is claiming (delta review 3, MEDIUM). Classifying against a
   * freshly read baseline instead misread every connection another document
   * had changed in the meantime as locally changed: the operation's untouched
   * copy of Y differed from the fresh Y, so Y entered the overlay and the
   * flush published the stale copy over the newer one. Only connections whose
   * OUTPUT differs from their own INPUT are claimed here.
   */
  private write(
    connections: SavedConnection[],
    activeId: string | null,
    input: { connections: SavedConnection[]; activeId: string | null },
    /**
     * Published INSIDE the same locked turn as this write, immediately after
     * the profile list lands (#3626 review, H1). A removal's tombstone is the
     * only user: written before the turn, it retires the epoch while every
     * other document can still read — and therefore still capture against —
     * the connection that has not been removed yet, which is precisely the
     * capture the tombstone exists to invalidate.
     */
    publishAfter?: () => void,
  ): void {
    const previous = input;
    const previousById = new Map(
      previous.connections.map((item) => [item.id, item] as const),
    );
    const nextIds = new Set(connections.map((item) => item.id));
    for (const item of previous.connections) {
      if (nextIds.has(item.id)) continue;
      this.pendingRemovals.add(item.id);
      this.forgetOverlayEntry(item.id);
    }
    for (const item of connections) {
      this.pendingRemovals.delete(item.id);
      const before = previousById.get(item.id);
      // Only genuinely changed connections join the overlay. Claiming the
      // untouched ones is what shadowed another document's updates.
      if (!before || JSON.stringify(before) !== JSON.stringify(item)) {
        this.pendingConnections.set(item.id, item);
        // An id absent from the snapshot this operation was computed from is
        // one this DOCUMENT created, and only such an id may be appended to
        // shared storage at flush time (#3626 review, H2).
        if (!before) this.pendingCreated.add(item.id);
        // The retirement state this claim was made against. A removal that
        // lands afterwards raises it, which is how the flush recognizes that
        // this entry describes a connection that no longer exists.
        if (!this.pendingRetiredFloor.has(item.id)) {
          this.pendingRetiredFloor.set(
            item.id,
            this.retiredCounterFloor(this.generationPrefix, item.id),
          );
        }
      }
    }
    if (activeId !== previous.activeId || this.pendingActive) {
      this.pendingActive = { value: activeId };
    }
    this.pendingWrites += 1;
    // Synchronous when there is no lock manager, so the storage write still
    // lands BEFORE the notification exactly as it always did.
    this.serialize(() => {
      try {
        // Merge, don't snapshot: shared storage may have moved on for
        // connections this document did not touch.
        const merged = this.applyLocalOverlay(this.readShared());
        this.storage.set(this.storageKey, JSON.stringify(merged.connections));
        if (merged.activeId) {
          this.storage.set(this.activeKey, merged.activeId);
        } else {
          this.storage.remove(this.activeKey);
        }
        // After the profile, never before it: no reader may observe a retired
        // epoch for a connection this store is still publishing.
        publishAfter?.();
      } finally {
        this.pendingWrites -= 1;
        // Retire the overlay once nothing of ours is in flight: from here
        // shared storage is authoritative again, including whatever another
        // document wrote while this one was waiting.
        if (this.pendingWrites === 0) {
          this.pendingConnections.clear();
          this.pendingCreated.clear();
          this.pendingRetiredFloor.clear();
          this.pendingRemovals.clear();
          this.pendingActive = null;
        }
      }
    });
    this.invalidateCache();
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  getAll(): SavedConnection[] {
    this.ensureCache();
    return this._cachedAll!;
  }

  getActive(): SavedConnection | null {
    this.ensureCache();
    return this._cachedActive;
  }

  /**
   * Re-read host-owned storage after an external writer changes it. This is
   * intentionally a notification-only operation: the host remains responsible
   * for validating and projecting its backing store before it asks consumers
   * to observe the new snapshot.
   */
  reload(): void {
    this.invalidateCache();
    this.notify();
  }

  add(name: string, url: string): SavedConnection {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    // Avoid duplicate URLs
    const existing = connections.find((c) => c.url === url);
    if (existing) {
      // Just activate it
      this.write(connections, existing.id, snapshot);
      return existing;
    }
    const conn: SavedConnection = this.normalize({
      id: uuid(),
      name: name || url,
      url,
    });
    const updated = [...connections, conn];
    this.write(updated, activeId ?? conn.id, snapshot);
    return conn;
  }

  addHostTunnel(
    name: string,
    input: { hostAlias: string; remoteProjectPath: string },
  ): SavedConnection {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    const existing = connections.find((connection) =>
      connection.accessMethods.some(
        (method) =>
          method.kind === 'host-tunnel' &&
          method.adapter === 'ssh' &&
          method.hostAlias === input.hostAlias.trim() &&
          method.remoteProjectPath === input.remoteProjectPath.trim(),
      ),
    );
    if (existing) {
      const method = existing.accessMethods.find(
        (candidate) =>
          candidate.kind === 'host-tunnel' &&
          candidate.adapter === 'ssh' &&
          candidate.hostAlias === input.hostAlias.trim() &&
          candidate.remoteProjectPath === input.remoteProjectPath.trim(),
      );
      const selected = method
        ? { ...existing, selectedAccessMethodId: method.id }
        : existing;
      this.write(
        connections.map((connection) =>
          connection.id === existing.id ? selected : connection,
        ),
        existing.id,
        snapshot,
      );
      return selected;
    }
    const id = uuid();
    const method = createHostTunnelAccessMethod({
      id: `access:ssh:${id}`,
      hostAlias: input.hostAlias,
      remoteProjectPath: input.remoteProjectPath,
    });
    const connection = this.normalize({
      id,
      name: name || method.hostAlias,
      url: '',
      endpoints: [],
      selectedEndpointId: '',
      accessMethods: [method],
      selectedAccessMethodId: method.id,
      credentialState: 'required',
    });
    this.write(
      [...connections, connection],
      activeId ?? connection.id,
      snapshot,
    );
    return connection;
  }

  remove(id: string): void {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    const removed = connections.find((c) => c.id === id);
    if (removed) {
      const credentials = this.readCredentials();
      delete credentials[this.credentialRef(removed)];
      this.credentialStorage.set(
        this.credentialKey,
        JSON.stringify(credentials),
      );
    }
    const updated = connections.filter((c) => c.id !== id);
    const newActive = activeId === id ? (updated[0]?.id ?? null) : activeId;
    // Retire the counters globally rather than merely deleting them here: a
    // deleted key reads as 0 in shared storage while other documents keep
    // their own higher view, and an id recreated exactly would inherit it.
    //
    // Published in the SAME locked turn as the removal, and after it (#3626
    // review, H1). Retiring them here — synchronously, while the profile write
    // waits for the lock — opened a window in which another document still
    // read the connection as present while `counter()` already returned the
    // new floor. A request issued in that window captures the floor itself, so
    // a same-id restoration begins at exactly the captured value and the stale
    // report passes the equality guard: the one outcome the tombstone exists
    // to prevent. The local overlay is applied synchronously by `write`, so
    // THIS document still reads the connection as gone immediately.
    this.write(updated, newActive, snapshot, () => {
      this.retireCounter(this.generationPrefix, id);
      this.retireCounter(this.authorityPrefix, id);
    });
  }

  update(
    id: string,
    changes: Partial<Pick<SavedConnection, 'name' | 'url' | 'sshForward'>>,
  ): void {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    // Changing the address changes what the connection MEANS, so nothing in
    // flight against the previous one is evidence about it any more.
    if (changes.url) this.invalidateCredentialGeneration(id);
    const updated = connections.map((original) => {
      if (original.id !== id) return original;
      // ...and for the same reason, a device session displaced at the previous
      // address is not provenance about the new one. Endpoint SELECTION among
      // a connection's own verified endpoints is deliberately not this: those
      // are addresses for the same Station, and the pairing survives them.
      const c =
        changes.url && changes.url !== original.url
          ? ConnectionStore.withoutDisplacedCredentialState(original)
          : original;
      const { url, ...safeChanges } = changes;
      if (url && url !== c.url && c.environmentId) {
        return {
          ...c,
          ...safeChanges,
          endpointCandidate: { url, state: 'unverified' as const },
        };
      }
      if (url && url !== c.url) {
        const endpoint = this.endpointFor(url);
        const accessMethod = createDirectHttpAccessMethod(endpoint);
        return {
          ...c,
          ...changes,
          endpoints: [endpoint],
          selectedEndpointId: endpoint.id,
          accessMethods: [
            ...c.accessMethods.filter(
              (method) => method.kind === 'host-tunnel',
            ),
            accessMethod,
          ],
          selectedAccessMethodId: accessMethod.id,
        };
      }
      return { ...c, ...changes };
    });
    this.write(updated, activeId, snapshot);
  }

  private readCredentials(): Record<string, string> {
    try {
      const parsed = JSON.parse(
        this.credentialStorage.get(this.credentialKey) ?? '{}',
      );
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }

  private credentialRef(connection: SavedConnection): string {
    return `${connection.credentialRef.kind}:${connection.credentialRef.id}`;
  }

  /**
   * Drops the state a rejection displaced. Written as a key removal rather
   * than `displacedCredentialState: undefined` so the persisted profile and
   * the in-memory one are the same object shape — `JSON.stringify` omits an
   * undefined value, and `read()` re-writes storage whenever the normalized
   * profile differs from what it parsed.
   */
  private static withoutDisplacedCredentialState(
    connection: SavedConnection,
  ): SavedConnection {
    if (connection.displacedCredentialState === undefined) return connection;
    const { displacedCredentialState: _retired, ...rest } = connection;
    return rest;
  }

  /**
   * One key per connection per counter, rather than one shared JSON document
   * for all of them (#3600 review, HIGH). A document rewriting a whole map it
   * read a moment ago can erase a counter for a connection it never touched;
   * a per-connection key makes the blast radius of a lost update the one
   * connection whose counter is actually being changed, and the monotonic
   * merge below closes what remains of it.
   */
  private counterKey(prefix: string, id: string): string {
    return prefix + id;
  }

  private readStoredCounter(key: string): number {
    const raw = this.storage.get(key);
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  /**
   * The counter as this document must see it: the higher of shared storage,
   * anything this document has already decided, and the floor a removal
   * retired. Taking the maximum is what makes a counter unable to REGRESS —
   * the failure mode that would let a response captured against an older value
   * look current again.
   */
  private counter(prefix: string, id: string): number {
    const key = this.counterKey(prefix, id);
    return Math.max(
      this.readStoredCounter(key),
      this.counterView.get(key) ?? 0,
      this.retiredCounterFloor(prefix, id),
    );
  }

  /**
   * The first counter value a connection recreated under `id` may use (#3626).
   *
   * `remove()` used to only DELETE this connection's counter keys, which is a
   * regression dressed as cleanup: shared storage went back to 0 while every
   * other document kept its own `counterView` entry (a `storage` event reloads
   * profiles, not counter views), and an increment already queued behind the
   * lock could recreate the key afterwards. The consequence is not the counter
   * itself but the equality contract built on it — an id recreated exactly
   * (native profile projection, an imported profile, any externally restored
   * id) inherited the old high value, so an old tab's in-flight report about
   * the connection that was REMOVED could compare current against the new one
   * and write a credential state that describes a different Station.
   *
   * A tombstone closes it from the read side, which is the only side every
   * document shares: the removal publishes the retired epoch + 1, every
   * `counter()` in every document takes the maximum against it, and the
   * recreated id therefore starts strictly ABOVE anything captured before the
   * removal. A stale capture can then only be strictly lower, which is exactly
   * what the equality guard drops.
   *
   * Stored as the floor rather than the retired value so absence and "removed
   * before anything bumped" stay distinguishable: a connection whose counter
   * was still 0 must also invalidate captures of 0.
   *
   * Per connection and per counter, like the live keys and for the same reason
   * (#3600 review): one shared tombstone document would let a document
   * rewriting it erase a tombstone for a connection it never touched. They are
   * deliberately never expired — a tombstone that outlives the tabs it
   * protects costs one small key, while one that expires first is a floor that
   * silently stops holding.
   */
  private retiredCounterFloor(prefix: string, id: string): number {
    const retiredPrefix = this.retiredCounterPrefixes.get(prefix);
    if (!retiredPrefix) return 0;
    return this.readStoredCounter(this.counterKey(retiredPrefix, id));
  }

  /**
   * Publishes the tombstone for one counter, then drops the live key. Order
   * matters: the floor is computed from the counter that is about to be
   * deleted.
   */
  private retireCounter(prefix: string, id: string): void {
    const retiredPrefix = this.retiredCounterPrefixes.get(prefix);
    if (retiredPrefix) {
      const key = this.counterKey(retiredPrefix, id);
      // `counter()` already folds in the existing floor, so a second removal
      // of the same id can only raise it.
      this.storage.set(key, String(this.counter(prefix, id) + 1));
    }
    this.clearCounter(prefix, id);
  }

  /**
   * Publishes an invalidation IMMEDIATELY and synchronously — deliberately not
   * behind the lock (delta review 2, HIGH root cause).
   *
   * Queueing it was what left the original failure reachable: a pairing bumped
   * its counter into the lock queue, an older 401's reporter that was already
   * queued ahead of it took the lock, re-read a shared generation the pairing
   * had not reached yet, accepted the stale rejection and wrote `required`.
   * The final state came out right only because the pairing's own profile
   * write landed afterwards and overwrote it — ordered last-writer-wins, not
   * suppression of a stale report. A pairing tab that closed before that flush
   * left `required` as the durable state, and other tabs could see it in the
   * meantime.
   *
   * Writing it here instead makes the bump visible to that reporter INSIDE its
   * lock turn, so the stale rejection is dropped rather than applied-and-undone.
   *
   * It is safe without the lock, unlike the profile:
   * - the write is one key holding one number, so it cannot damage a
   *   neighbouring connection or a neighbouring field;
   * - readers take `max(shared, local)`, so no reader can go backwards;
   * - the contract is EQUALITY against a captured value, and a captured value
   *   is always strictly below anything a bump produces. Two simultaneous
   *   pairings can lose one increment to each other, but the surviving value
   *   is still above every capture that preceded them — a lost increment
   *   cannot resurrect a stale capture, which is the only thing this counter
   *   is asked to prevent.
   */
  private bumpCounter(prefix: string, id: string): void {
    const key = this.counterKey(prefix, id);
    const next = this.counter(prefix, id) + 1;
    this.counterView.set(key, next);
    this.storage.set(key, String(next));
  }

  private clearCounter(prefix: string, id: string): void {
    const key = this.counterKey(prefix, id);
    this.counterView.delete(key);
    this.storage.remove(key);
  }

  /**
   * The current credential generation for a connection. Capture this when a
   * request STARTS and pass it to `recordAuthenticatedSuccess`; anything that
   * invalidates the credential in the meantime bumps it, so a delayed
   * acceptance cannot retire newer evidence.
   *
   * Read through to shared storage on every call rather than cached in the
   * store (#3600). Connection profiles are shared across every tab on this
   * origin while this counter used to be per-store memory, so a tab whose
   * request predates ANOTHER tab's rejection carried a generation that looked
   * current to it and overwrote the newer `required`. A cached copy would
   * reintroduce exactly that staleness; the document is one small object and
   * is read once per request.
   */
  credentialGeneration(id: string): number {
    return this.counter(this.generationPrefix, id);
  }

  /** Retires every credential observation currently in flight for `id`. */
  private invalidateCredentialGeneration(id: string): void {
    this.bumpCounter(this.generationPrefix, id);
  }

  /**
   * How many times this connection has GAINED a credential able to
   * authenticate it: a bearer saved, a device session established, or an
   * authenticated request accepted after a rejection.
   *
   * The signal a parked probe waits on (#3602). A browser device session has
   * no credential VALUE — it is `undefined` before pairing and `undefined`
   * after — so consumers that compared values never saw re-pairing happen and
   * left a terminally parked SSE attempt and a `blocked` health supervisor
   * waiting for unrelated traffic or a manual retry.
   *
   * Deliberately NOT `credentialGeneration`, which is the ordering counter for
   * evidence and is also bumped by a recorded endpoint failure and by every
   * rebind. Waking on that one would re-probe immediately after each failure
   * the supervisor itself records, which is the hot loop station#1094 removed.
   * Deliberately not bumped by REMOVAL either: losing a credential cannot
   * unblock anything, and bumping there would let a 401 storm re-trigger
   * probes past their backoff.
   */
  credentialAuthorityGeneration(id: string): number {
    return this.counter(this.authorityPrefix, id);
  }

  private recordCredentialAuthority(id: string): void {
    this.bumpCounter(this.authorityPrefix, id);
  }

  getCredential(id: string): string | null {
    const connection = this.getAll().find((item) => item.id === id);
    if (!connection) return null;
    return this.readCredentials()[this.credentialRef(connection)] ?? null;
  }

  setCredential(id: string, credential: string): void {
    const value = credential.trim();
    if (!value) {
      this.removeCredential(id);
      return;
    }
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    const connection = connections.find((item) => item.id === id);
    if (!connection) return;
    const credentials = this.readCredentials();
    credentials[this.credentialRef(connection)] = value;
    this.credentialStorage.set(this.credentialKey, JSON.stringify(credentials));
    this.invalidateCredentialGeneration(id);
    this.recordCredentialAuthority(id);
    this.write(
      connections.map((item) =>
        item.id === id
          ? ConnectionStore.withoutDisplacedCredentialState({
              ...item,
              credentialState: 'saved',
            })
          : item,
      ),
      activeId,
      snapshot,
    );
  }

  markDeviceSession(id: string): void {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    const connection = connections.find((item) => item.id === id);
    if (!connection) return;
    const credentials = this.readCredentials();
    delete credentials[this.credentialRef(connection)];
    this.credentialStorage.set(this.credentialKey, JSON.stringify(credentials));
    this.invalidateCredentialGeneration(id);
    this.recordCredentialAuthority(id);
    this.write(
      connections.map((item) =>
        item.id === id
          ? ConnectionStore.withoutDisplacedCredentialState({
              ...item,
              credentialState: 'device-session',
            })
          : item,
      ),
      activeId,
      snapshot,
    );
  }

  removeCredential(id: string): void {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    const connection = connections.find((item) => item.id === id);
    if (!connection) return;
    const credentials = this.readCredentials();
    delete credentials[this.credentialRef(connection)];
    this.credentialStorage.set(this.credentialKey, JSON.stringify(credentials));
    this.invalidateCredentialGeneration(id);
    // A rejection that finds the connection ALREADY `required` displaces
    // nothing: the state it would record is `required` itself, and the fact
    // worth keeping is the one the first rejection displaced.
    const displaced =
      connection.credentialState === 'required'
        ? connection.displacedCredentialState
        : connection.credentialState;
    this.write(
      connections.map((item) =>
        item.id === id
          ? {
              ...item,
              credentialState: 'required',
              ...(displaced ? { displacedCredentialState: displaced } : {}),
            }
          : item,
      ),
      activeId,
      snapshot,
    );
  }

  /**
   * Records that a request's credential was REJECTED.
   *
   * `generation` is the one captured when that request was issued, and a
   * report from an overtaken generation is dropped. The equality guard below
   * cannot stand alone: a device session has no credential value at all, so a
   * late 401 carrying `undefined` compares equal to a freshly paired session
   * that also has `undefined`, and deleting on that basis undoes the pairing
   * the user just completed. Omit `generation` only for a report that is not
   * about a specific in-flight request (a person saying "this credential is
   * wrong" in the UI).
   */
  markCredentialRequired(
    id: string,
    rejectedCredential?: string,
    generation?: number,
  ): void | Promise<void> {
    // Both reads and the write are one serialized sequence: another document
    // completing a pairing between the generation check and the removal is a
    // 401 deleting a credential that answered a request it never saw.
    //
    // The returned promise (locked path only) settles when the transition has
    // been applied, so the SDK can order a response's resolution after the
    // state it reports — see `reportUnauthorized` (#3601/#3602 review,
    // MEDIUM). Undefined on the synchronous path, where it already has.
    return this.serialize(() => {
      if (
        generation !== undefined &&
        generation !== this.credentialGeneration(id)
      )
        return;
      const currentCredential = this.getCredential(id) ?? undefined;
      if (currentCredential !== rejectedCredential) return;
      // ACCEPTED RESIDUAL (delta review 3; re-examined and re-affirmed for
      // station#3624): the check above and the write below are two adjacent
      // synchronous statements, and the counter they check is bumped by other
      // documents WITHOUT this lock — deliberately, because queuing that bump
      // is what made a stale rejection reach shared storage at all. So
      // another document's pairing bump landing between these two statements
      // is not excluded.
      //
      // Both closures #3624 proposed fail for the same structural reason,
      // which is worth naming so the next reader does not re-derive it:
      //  - Taking this lock around the BUMP as well. A generation only the
      //    pairing document can see orders nothing across documents, so the
      //    bump would have to be published from inside a lock turn — the
      //    queued shape this replaced, whose failure is pinned by
      //    `ConnectionStore.cross-tab.test.ts`'s "leaves the pre-pairing
      //    profile durable when the pairing tab dies before its flush".
      //    Broadcasting the value over a `BroadcastChannel` instead does not
      //    help: a message is delivered in a TASK, and this window is inside
      //    one synchronous block, which no task can enter.
      //  - Moving counters + profile into a transactional store (IndexedDB).
      //    Every read on this store is synchronous — `credentialGeneration`,
      //    `getCredential`, `getAll`, the `useSyncExternalStore` snapshot —
      //    and `captureCredentialEvidence` reads the generation in the same
      //    tick as a pairing. An asynchronous store is only readable here
      //    through a mirror, and a cached generation is precisely the
      //    staleness #3600 removed.
      //
      // Consequence if it happens: ONE stale report is accepted, and the next
      // authenticated response corrects it. That sentence is a contract, not
      // a hope — it is pinned, with its negative control, by "the residual
      // check-write window is self-correcting (station#3624)" in
      // `ConnectionStore.cross-tab.test.ts`. This is the floor of the
      // primitive, not an oversight.
      this.removeCredential(id);
    });
  }

  private migrateHandshakeCredential(
    candidateId: string,
    environmentId: string,
    replace: boolean,
  ): { credentials: Record<string, string>; stableRef: string } {
    const credentials = this.readCredentials();
    const provisionalRef = `connection:${candidateId}`;
    const stableRef = `environment:${environmentId}`;
    if (credentials[provisionalRef] && (replace || !credentials[stableRef])) {
      credentials[stableRef] = credentials[provisionalRef];
    }
    delete credentials[provisionalRef];
    this.credentialStorage.set(this.credentialKey, JSON.stringify(credentials));
    return { credentials, stableRef };
  }

  private reconcilePendingCandidate(
    candidate: SavedConnection,
    handshake: StationHandshakeIdentity,
    connections: SavedConnection[],
    activeId: string | null,
    snapshot: { connections: SavedConnection[]; activeId: string | null },
  ): SavedConnection {
    const sameEnvironment = candidate.environmentId === handshake.environmentId;
    const staged: SavedConnection = {
      ...candidate,
      capabilities:
        this.capabilitiesForHandshake(handshake) ?? candidate.capabilities,
      endpointCandidate: {
        ...candidate.endpointCandidate!,
        state: sameEnvironment
          ? 'confirmation-required'
          : 'verification-failed',
      },
    };
    this.write(
      connections.map((item) => (item.id === candidate.id ? staged : item)),
      activeId,
      snapshot,
    );
    return staged;
  }

  private mergeStableEnvironment(
    candidate: SavedConnection,
    stable: SavedConnection,
    handshake: StationHandshakeIdentity,
    connections: SavedConnection[],
    activeId: string | null,
    snapshot: { connections: SavedConnection[]; activeId: string | null },
  ): SavedConnection {
    const { credentials, stableRef } = this.migrateHandshakeCredential(
      candidate.id,
      handshake.environmentId,
      true,
    );
    const hostMerged = mergeHostAccessProfiles(stable, candidate);
    const merged: SavedConnection = {
      ...(hostMerged ?? stable),
      capabilities:
        this.capabilitiesForHandshake(handshake) ?? stable.capabilities,
      credentialState: credentials[stableRef]
        ? 'saved'
        : stable.credentialState,
      ...(hostMerged
        ? {}
        : {
            endpointCandidate: {
              url: candidate.url,
              state: 'confirmation-required' as const,
            },
          }),
    };
    this.write(
      connections
        .filter((item) => item.id !== candidate.id && item.id !== stable.id)
        .concat(merged),
      activeId === candidate.id || activeId === stable.id
        ? merged.id
        : activeId,
      snapshot,
    );
    return merged;
  }

  private bindNewEnvironment(
    candidate: SavedConnection,
    handshake: StationHandshakeIdentity,
    connections: SavedConnection[],
    activeId: string | null,
    snapshot: { connections: SavedConnection[]; activeId: string | null },
  ): SavedConnection {
    const { credentials, stableRef } = this.migrateHandshakeCredential(
      candidate.id,
      handshake.environmentId,
      false,
    );
    const merged: SavedConnection = {
      // A displaced credential state is provenance about the connection this
      // WAS. Binding gives it a server-owned identity and moves its credential
      // reference, so a device session displaced before the bind says nothing
      // about the bound subject and must not decide its recovery (#3599
      // review, LOW). `credentialState` below is re-derived for the same
      // reason, from `candidate.credentialState` — the state the connection
      // actually holds now, not one a past rejection displaced.
      ...ConnectionStore.withoutDisplacedCredentialState(candidate),
      environmentId: handshake.environmentId,
      authProtocolVersion: handshake.authentication.protocolVersion,
      credentialRef: {
        credentialVersion: 1,
        kind: 'environment',
        id: handshake.environmentId,
      },
      capabilities: this.capabilitiesForHandshake(handshake),
      // Shared with `recordAuthenticatedSuccess` — see `deriveCredentialState`.
      // Binding has observed no accepted authenticated request, so an
      // unrecognised remote connection still needs credentials.
      credentialState: deriveCredentialState({
        hasStoredCredential: Boolean(credentials[stableRef]),
        previousState: candidate.credentialState,
        url: candidate.url,
        authenticatedRequestAccepted: false,
      }),
    };
    const updated = connections
      .filter((item) => item.id !== candidate.id)
      .concat(merged);
    // Binding moves the credential reference, so nothing in flight against the
    // pre-bind identity is evidence about the bound one.
    this.invalidateCredentialGeneration(merged.id);
    this.write(
      updated,
      activeId === candidate.id ? merged.id : activeId,
      snapshot,
    );
    return merged;
  }

  /**
   * Applies identity only after a schema-validated public handshake. If the
   * environment is already known, its stable profile wins and only its mutable
   * endpoint is refreshed.
   */
  reconcileHandshake(
    id: string,
    handshake: StationHandshakeIdentity,
  ): SavedConnection | null {
    if (
      !handshake.environmentId ||
      handshake.authentication.scheme !== 'bearer' ||
      !Number.isInteger(handshake.authentication.protocolVersion)
    ) {
      return null;
    }
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    const candidate = connections.find((item) => item.id === id);
    if (!candidate) return null;
    if (candidate.endpointCandidate) {
      return this.reconcilePendingCandidate(
        candidate,
        handshake,
        connections,
        activeId,
        snapshot,
      );
    }
    // Native Desktop has already committed this exact identity to the shared
    // profile store before it asks the ConnectionStore to refresh its runtime
    // view. Rebinding it as if it were an unverified browser candidate would
    // replace the profile's keyring-reference-derived credential identity.
    if (candidate.environmentId === handshake.environmentId) {
      const refreshed: SavedConnection = {
        ...candidate,
        authProtocolVersion: handshake.authentication.protocolVersion,
        capabilities:
          this.capabilitiesForHandshake(handshake) ?? candidate.capabilities,
      };
      this.write(
        connections.map((item) => (item.id === id ? refreshed : item)),
        activeId,
        snapshot,
      );
      return refreshed;
    }
    const stable = connections.find(
      (item) =>
        item.id !== id && item.environmentId === handshake.environmentId,
    );
    if (stable) {
      return this.mergeStableEnvironment(
        candidate,
        stable,
        handshake,
        connections,
        activeId,
        snapshot,
      );
    }
    return this.bindNewEnvironment(
      candidate,
      handshake,
      connections,
      activeId,
      snapshot,
    );
  }

  commitEndpointCandidate(id: string): SavedConnection | null {
    // Same as `selectEndpoint`: this is a rebind.
    this.invalidateCredentialGeneration(id);
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    let committed: SavedConnection | null = null;
    const updated = connections.map((item) => {
      if (
        item.id !== id ||
        item.endpointCandidate?.state !== 'confirmation-required'
      ) {
        return item;
      }
      const { endpointCandidate: _candidate, ...profile } = item;
      const endpoint = this.endpointFor(item.endpointCandidate.url);
      const endpoints = [
        ...profile.endpoints.filter(
          (candidate) => candidate.id !== endpoint.id,
        ),
        endpoint,
      ];
      const accessMethod = createDirectHttpAccessMethod(endpoint);
      committed = {
        ...profile,
        url: endpoint.url,
        endpoints,
        selectedEndpointId: endpoint.id,
        accessMethods: [
          ...profile.accessMethods.filter(
            (method) =>
              method.kind === 'host-tunnel' ||
              (method.kind === 'direct-http' &&
                method.endpointId !== endpoint.id),
          ),
          accessMethod,
        ],
        selectedAccessMethodId: accessMethod.id,
      };
      return committed;
    });
    if (committed) this.write(updated, activeId, snapshot);
    return committed;
  }

  failEndpointCandidate(id: string): void {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    this.write(
      connections.map((item) =>
        item.id === id && item.endpointCandidate
          ? {
              ...item,
              endpointCandidate: {
                ...item.endpointCandidate,
                state: 'verification-failed',
              },
            }
          : item,
      ),
      activeId,
      snapshot,
    );
  }

  recordEndpointSuccess(
    id: string,
    url: string,
    at = Date.now(),
    bootId?: string,
    accessMethodId?: string,
  ): void {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    this.write(
      connections.map((item) => {
        if (item.id !== id) return item;
        return recordConnectionSuccess(item, {
          url,
          at,
          ...(bootId ? { bootId } : {}),
          ...(accessMethodId ? { accessMethodId } : {}),
          endpointFor: (value) => this.endpointFor(value),
        });
      }),
      activeId,
      snapshot,
    );
  }

  /**
   * Records that this Station accepted an AUTHENTICATED request on `url`.
   *
   * `recordEndpointSuccess` retires `lastError`, but that is only half the
   * stale evidence a rejected credential leaves behind: the "Request access to
   * reconnect" banner is rendered from `credentialState === 'required'`
   * (`OnboardingGate.tsx`), which `markCredentialRequired` set on the 401 and
   * which no success path cleared. Clearing one and not the other is what
   * produced the contradiction — header chip "Connected", banner "Request
   * access", on every route, surviving reload.
   *
   * A connection ID is NOT enough to make an acceptance current, which is what
   * the delta review found. Two orderings a same-ID check lets through:
   *
   *   1. Request A is accepted but slow; request B meets a revoked credential
   *      and records `required`; A then lands and erases it. The user is
   *      locked out with no banner and no way back.
   *   2. A connection keeps its ID while its endpoint changes. An in-flight
   *      2xx from the OLD address clears the NEW address's requirement — and
   *      `recordConnectionSuccess` would reselect the old URL as verified.
   *
   * So `generation` is captured by the caller when the request STARTS and
   * checked here: anything that invalidates a credential in the meantime — a
   * rejection, a recorded failure, a rebind, a credential change — has bumped
   * it, and a stale acceptance is dropped. `url`'s origin is checked against
   * the connection's CURRENT address independently, because a rebind is a
   * change of subject rather than of credential.
   *
   * The "is there anything stale to retire?" question is answered HERE, from
   * current store state, and the method is a no-op when the answer is no. A
   * caller firing on every accepted response therefore cannot write on every
   * request, and cannot skip a recovery because the failure was recorded after
   * its own closure was captured.
   */
  recordAuthenticatedSuccess(
    id: string,
    url: string,
    generation: number,
    at = Date.now(),
  ): void | Promise<void> {
    // One serialized sequence, for the same reason as `markCredentialRequired`:
    // another document recording a rejection between the generation check and
    // the write is the lost update this acceptance must not win. The returned
    // promise settles when the transition has been applied.
    return this.serialize(() =>
      this.applyAuthenticatedSuccess(id, url, generation, at),
    );
  }

  private applyAuthenticatedSuccess(
    id: string,
    url: string,
    generation: number,
    at: number,
  ): void {
    if (generation !== this.credentialGeneration(id)) return;
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    const current = connections.find((item) => item.id === id);
    if (!current) return;
    if (!isSameConnectionOrigin(url, current.url)) return;
    if (!current.lastError && current.credentialState !== 'required') return;
    // ACCEPTED RESIDUAL (delta review 3), same window as
    // `markCredentialRequired`, whose comment carries the full argument for
    // why neither a lock-arbitrated bump nor a transactional store closes it
    // (station#3624): the generation check above and the write below are two
    // adjacent synchronous statements, and another document's pairing bumps
    // that counter without taking this lock. A bump landing between them lets
    // ONE stale acceptance through; the next rejection re-records it. Both
    // halves are pinned by "the residual check-write window is
    // self-correcting (station#3624)" in `ConnectionStore.cross-tab.test.ts`.
    // Authority is regained only where authority was LOST (#3602 review,
    // MEDIUM). Recovering from a timeout or an offline blip retires stale
    // evidence too, but nothing about it says a credential started working —
    // and waking every parked SSE stream and blocked supervisor on it spends
    // real requests on a fact that was never in doubt. The auth-vs-transport
    // question is answered by the derivation the supervisor's own `blocked`
    // state uses, not by a second list of reasons that could disagree with it.
    const recoveredFromRejection =
      current.credentialState === 'required' ||
      (current.lastError !== undefined &&
        classifyConnectionFailure(current.lastError.reason) === 'terminal');
    if (recoveredFromRejection) this.recordCredentialAuthority(id);
    const credentials = this.readCredentials();
    this.write(
      connections.map((item) => {
        if (item.id !== id) return item;
        // Read from the PROFILE, not from this store's memory: the rejection
        // may have been recorded by a page that has since been reloaded, or by
        // another tab (#3599).
        const displaced = item.displacedCredentialState;
        const recovered = ConnectionStore.withoutDisplacedCredentialState(
          recordConnectionSuccess(item, {
            url,
            at,
            endpointFor: (value) => this.endpointFor(value),
          }),
        );
        if (recovered.credentialState !== 'required') return recovered;
        return {
          ...recovered,
          // Shared with `bindNewEnvironment` — see `deriveCredentialState`.
          // Reaching here means this Station accepted an authenticated
          // request, which is the difference between the two callers.
          credentialState:
            item.hostOwnedCredential && displaced === 'saved'
              ? 'saved'
              : deriveCredentialState({
                  hasStoredCredential: Boolean(
                    credentials[this.credentialRef(item)],
                  ),
                  previousState: displaced,
                  url: item.url,
                  authenticatedRequestAccepted: true,
                }),
        };
      }),
      activeId,
      snapshot,
    );
  }

  recordEndpointFailure(
    id: string,
    reason: NonNullable<SavedConnection['lastError']>['reason'],
    at = Date.now(),
    detail?: string,
  ): void {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    // A recorded failure is newer evidence than anything currently in flight.
    this.invalidateCredentialGeneration(id);
    this.write(
      connections.map((item) =>
        item.id === id
          ? {
              ...item,
              lastError: {
                reason,
                endpointId: item.selectedEndpointId,
                at,
                ...(detail ? { detail } : {}),
              },
            }
          : item,
      ),
      activeId,
      snapshot,
    );
  }

  selectEndpoint(id: string, endpointId: string): SavedConnection | null {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    // A rebind changes the address the connection means, so no response from
    // the previous one is evidence about it any more.
    this.invalidateCredentialGeneration(id);
    let selected: SavedConnection | null = null;
    const updated = connections.map((item) => {
      if (item.id !== id) return item;
      const endpoint = item.endpoints.find(
        (candidate) => candidate.id === endpointId,
      );
      if (!endpoint) return item;
      const accessMethod =
        item.accessMethods.find(
          (method) =>
            method.kind === 'direct-http' && method.endpointId === endpoint.id,
        ) ?? createDirectHttpAccessMethod(endpoint);
      selected = {
        ...item,
        url: endpoint.url,
        selectedEndpointId: endpoint.id,
        selectedAccessMethodId: accessMethod.id,
      };
      return selected;
    });
    if (selected) this.write(updated, activeId, snapshot);
    return selected;
  }

  selectAccessMethod(
    id: string,
    accessMethodId: string,
  ): SavedConnection | null {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    // This can replace `url`, the selected endpoint and the transport, so it
    // is an address change like `selectEndpoint` and `update({ url })`. Without
    // the bump a same-origin endpoint switch leaves a stale response able to
    // reach `recordConnectionSuccess`, which reselects that response's exact
    // URL as the verified one.
    this.invalidateCredentialGeneration(id);
    let selected: SavedConnection | null = null;
    const updated = connections.map((item) => {
      if (item.id !== id) return item;
      const method = item.accessMethods.find(
        (candidate) => candidate.id === accessMethodId,
      );
      if (!method) return item;
      if (method.kind === 'host-tunnel') {
        selected = { ...item, selectedAccessMethodId: method.id };
        return selected;
      }
      const endpoint = item.endpoints.find(
        (candidate) => candidate.id === method.endpointId,
      );
      if (!endpoint) return item;
      selected = {
        ...item,
        url: endpoint.url,
        selectedEndpointId: endpoint.id,
        selectedAccessMethodId: method.id,
      };
      return selected;
    });
    if (selected) this.write(updated, activeId, snapshot);
    return selected;
  }

  setSelectedEndpointKind(id: string, kind: AccessEndpoint['kind']): void {
    const snapshot = this.read();
    const { connections, activeId } = snapshot;
    let changed = false;
    const updated = connections.map((item) => {
      if (item.id !== id) return item;
      const selected = item.endpoints.find(
        (endpoint) => endpoint.id === item.selectedEndpointId,
      );
      if (!selected || selected.kind === kind) return item;
      changed = true;
      const typed = this.endpointFor(selected.url, selected.priority);
      typed.kind = kind;
      typed.id = `endpoint:${kind}:${encodeURIComponent(typed.url)}`;
      if (selected.verifiedAt !== undefined) {
        typed.verifiedAt = selected.verifiedAt;
      }
      const accessMethod = createDirectHttpAccessMethod(typed);
      return {
        ...item,
        endpoints: [
          ...item.endpoints.filter((endpoint) => endpoint.id !== selected.id),
          typed,
        ],
        selectedEndpointId: typed.id,
        accessMethods: [
          ...item.accessMethods.filter(
            (method) =>
              method.kind === 'host-tunnel' ||
              (method.kind === 'direct-http' &&
                method.endpointId !== selected.id),
          ),
          accessMethod,
        ],
        selectedAccessMethodId: accessMethod.id,
      };
    });
    if (changed) this.write(updated, activeId, snapshot);
  }

  /**
   * Activates a connection by id. Returns whether an id was actually
   * recognized (a persisted connection, or the host-injected one) — a bogus
   * id is a no-op that leaves existing state untouched, but it is no longer
   * silent: callers that care can check the return value.
   */
  setActive(id: string): boolean {
    const snapshot = this.read();
    const { connections } = snapshot;
    if (this.injected && this.injected.id === id) {
      // The injected connection is never persisted, so it can't be written
      // into activeKey directly. Instead, clear the persisted active
      // pointer: ensureCache()'s active-resolution precedence already falls
      // back to the injected connection whenever no explicit activeId is
      // set, which is exactly what "activate the injected connection" means.
      this.write(connections, null, snapshot);
      return true;
    }
    const found = connections.find((c) => c.id === id);
    if (!found) return false;
    const updated = connections.map((c) =>
      c.id === id ? { ...c, lastConnected: Date.now() } : c,
    );
    this.write(updated, id, snapshot);
    return true;
  }

  /**
   * Installs or clears the host-injected connection. The value is held in a
   * separate slot that is never serialized to storage; passing a new URL for
   * the same source updates it in place (used when the bundled server restarts
   * on a new port — no reload). Passing null removes it.
   */
  setInjectedConnection(next: InjectedConnection | null): void {
    const built = next ? this.buildInjected(next) : null;
    if (this.injectedEquals(built)) return;
    this.injected = built;
    this.invalidateCache();
    this.notify();
  }

  getInjectedConnection(): SavedConnection | null {
    return this.injected;
  }

  private injectedEquals(next: SavedConnection | null): boolean {
    if (this.injected === next) return true;
    if (!this.injected || !next) return false;
    // Compare state too: a supervised loopback can change lifecycle phase
    // (starting → failed → stopped) while its URL stays empty, and that
    // transition must still re-notify so the list re-renders the new state.
    return (
      this.injected.id === next.id &&
      this.injected.url === next.url &&
      this.injected.injectedSource === next.injectedSource &&
      this.injected.injectedStatus === next.injectedStatus &&
      this.injected.ownerId === next.ownerId
    );
  }

  /**
   * A url-less injected connection (a not-running supervised bundled server) is
   * listed for visibility but has no base to talk to, so it is never eligible
   * to resolve as the active connection. Anything carrying a usable URL (a
   * running loopback or a CLI base) stays eligible exactly as before.
   */
  private injectedIsActive(injected: SavedConnection): boolean {
    return injected.url !== '';
  }

  private buildInjected(next: InjectedConnection): SavedConnection {
    const url = next.url ?? '';
    const base: SavedConnection = {
      ...this.normalize({
        id: next.id,
        name: next.name,
        url,
      }),
      injected: true,
      injectedSource: next.source,
      ...(next.status ? { injectedStatus: next.status } : {}),
      ...(next.ownerId ? { ownerId: next.ownerId } : {}),
    };
    // A not-running supervised server has no reachable base. List it with its
    // state but strip the placeholder endpoint `normalize` synthesised from the
    // empty URL, so `injectedIsActive` (URL presence) keeps it out of active
    // resolution and nothing tries to probe an empty address.
    if (!url) {
      return {
        ...base,
        url: '',
        endpoints: [],
        selectedEndpointId: '',
        accessMethods: [],
        selectedAccessMethodId: '',
        credentialState: 'not-required',
      };
    }
    if (next.source !== 'managed-loopback') return base;
    // A managed loopback base is supervised by the native host, so it carries a
    // dedicated endpoint kind that browser health probing must skip.
    const endpoint = this.endpointFor(url);
    const managed: AccessEndpoint = {
      ...endpoint,
      kind: 'managed-loopback',
      id: `endpoint:managed-loopback:${encodeURIComponent(endpoint.url)}`,
    };
    const accessMethod = createDirectHttpAccessMethod(managed);
    return {
      ...base,
      url: managed.url,
      endpoints: [managed],
      selectedEndpointId: managed.id,
      accessMethods: [accessMethod],
      selectedAccessMethodId: accessMethod.id,
      credentialState: 'not-required',
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Imports a URL stored under a legacy single-URL key into this store.
   * Call once on startup to migrate old users.
   */
  migrate(legacyKey: string): void {
    const legacyUrl = this.storage.get(legacyKey);
    if (!legacyUrl) return;
    const snapshot = this.read();
    const { connections } = snapshot;
    const alreadyExists = connections.some((c) => c.url === legacyUrl);
    if (!alreadyExists) {
      this.add('Default', legacyUrl);
    }
    // Keep the source record until the public handshake verifies a stable
    // environment identity. Re-running migration is therefore harmless and
    // cannot strand an older client during an interrupted upgrade.
  }
}
