import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { ProviderAdapterShape } from '../../providers/provider-interfaces.js';
import {
  nativeSessionIdentityMatchesSource,
  providerNativeSessionIdentity,
} from '../../providers/provider-session-identity.js';
import type { AttachedSessionDescriptor } from '../../providers/sessions/attached-session-source.js';

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
 * It mirrors this service's own writes (`set`, `delete`) so a later session
 * in the same poll sees them. A row another writer adds DURING the poll (a
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

  delete(threadId: string): void {
    this.byThreadId.delete(threadId);
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
