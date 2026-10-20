import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import {
  nativeSessionIdentityMatchesSource,
  providerNativeSessionIdentity,
} from '../../providers/provider-session-identity.js';
import type {
  AttachedSessionDescriptor,
  AttachedSessionSource,
} from '../../providers/sessions/attached-session-source.js';

type NativeIdentity = NonNullable<
  ReturnType<typeof providerNativeSessionIdentity>
>;

/**
 * #3386 review F2: the persisted sessions ONE poll reads, indexed.
 *
 * `follow()` used to call `readSessions()` (every row, parsed) for every
 * followed session, and then decode every Station-owned row's native
 * identity to look for a collision: O(followed x rows) on the main thread
 * each poll. Following sessions outside projects raised `followed` to the
 * full candidate bound and pushed a poll past its own interval. One read per
 * poll, a Map by thread id, and native identities decoded once per provider
 * make each lookup O(1) (or O(matches)).
 *
 * It mirrors the attached alias this service writes (`set`) so a later
 * descriptor with the same thread id in the same poll is checked against it:
 * a second source home under one thread id must still be refused
 * (`attachedSessionAffinityConflicts`). An alias it DELETES is not mirrored:
 * deletion only follows a collision, which marks the cached follow state
 * `collision`, and a later descriptor for that thread stops there whatever
 * the snapshot says. A row another writer adds DURING the poll (a
 * Station-owned start whose transcript is also discovered) is seen on the
 * next poll instead: the cached-state branch re-checks every poll and then
 * removes the attached alias, so the window is one poll interval.
 */
export class PollSessionSnapshot {
  private readonly byThreadId = new Map<string, ProviderSession>();
  private readonly ownedIdentities = new Map<
    string,
    Map<string, NativeIdentity[]>
  >();
  private readonly sourceOwnedIds = new Map<
    AttachedSessionSource,
    Set<string>
  >();

  constructor(sessions: readonly ProviderSession[]) {
    for (const session of sessions)
      this.byThreadId.set(session.threadId, session);
  }

  get(threadId: string): ProviderSession | undefined {
    return this.byThreadId.get(threadId);
  }

  set(session: ProviderSession): void {
    this.byThreadId.set(session.threadId, session);
  }

  /**
   * Whether a Station-owned session of this provider resumes the descriptor's
   * native session. Only attached aliases are written during a poll, so the
   * per-provider index stays valid for its whole life.
   */
  ownsNativeSession(
    descriptor: AttachedSessionDescriptor,
    adapter: ProviderAdapterShape | undefined,
  ): boolean {
    const candidates = this.identitiesFor(descriptor.provider, adapter).get(
      descriptor.sessionId,
    );
    return (
      candidates?.some((identity) =>
        nativeSessionIdentityMatchesSource(
          identity,
          descriptor.sessionId,
          descriptor.affinity,
        ),
      ) ?? false
    );
  }

  /**
   * Whether a Station-owned session of ANOTHER provider owns the descriptor's
   * native session, as the source itself declares (see
   * `AttachedSessionSource.ownedNativeSessionId`).
   */
  ownedThroughSource(
    source: AttachedSessionSource,
    descriptor: AttachedSessionDescriptor,
  ): boolean {
    if (!source.ownedNativeSessionId) return false;
    let owned = this.sourceOwnedIds.get(source);
    if (!owned) {
      owned = new Set();
      for (const session of this.byThreadId.values()) {
        if (session.controlMode === 'read-only-attached') continue;
        try {
          const id = source.ownedNativeSessionId(session);
          if (typeof id === 'string' && id) owned.add(id);
        } catch {
          // A source that cannot read a row proves no ownership for it.
        }
      }
      this.sourceOwnedIds.set(source, owned);
    }
    return owned.has(descriptor.sessionId);
  }

  private identitiesFor(
    provider: string,
    adapter: ProviderAdapterShape | undefined,
  ): Map<string, NativeIdentity[]> {
    let index = this.ownedIdentities.get(provider);
    if (index) return index;
    index = new Map();
    for (const session of this.byThreadId.values()) {
      if (
        session.controlMode === 'read-only-attached' ||
        session.provider !== provider
      )
        continue;
      const identity = providerNativeSessionIdentity(
        adapter,
        session.resumeCursor,
      );
      if (!identity) continue;
      const list = index.get(identity.sessionId) ?? [];
      list.push(identity);
      index.set(identity.sessionId, list);
    }
    this.ownedIdentities.set(provider, index);
    return index;
  }
}
