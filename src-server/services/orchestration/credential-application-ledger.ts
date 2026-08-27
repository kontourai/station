import { randomUUID } from 'node:crypto';

type CredentialApplicationState =
  | 'reserved'
  | 'staged'
  | 'commit-pending'
  | 'adopted'
  | 'rolled-back'
  | 'superseded'
  | 'indeterminate';

type CredentialApplicationTransition =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | { kind: 'unavailable' };

interface CredentialApplication {
  readonly connectionId: string;
  readonly candidateProfileRef: string;
  readonly previousProfileRef?: string;
  readonly state: CredentialApplicationState;
}

/** Claim-local handle; callers never receive the durable attempt identity. */
/** State-bound behavior capability; it never reveals the private SQLite key. */
export interface CredentialApplicationHandle {
  readonly application: CredentialApplication;
  staged(now: string): CredentialApplicationTransition;
  settle(
    state: Extract<
      CredentialApplicationState,
      | 'commit-pending'
      | 'adopted'
      | 'rolled-back'
      | 'superseded'
      | 'indeterminate'
    >,
    now: string,
  ): CredentialApplicationTransition;
  acknowledge(now: string): CredentialApplicationTransition;
}

/**
 * Private Interface for the credential application protocol. It is composed
 * from the EventStore at the runtime seam; callers receive only a claim-local
 * capability, never a storage coordinator or public configuration authority.
 */
/** @internal Composed only by EventStore into ConnectionService at runtime startup. */
export interface CredentialApplicationFactory {
  /** Begins one exact application before any external profile mutation. */
  start(input: {
    /** Durable business correlation; the factory creates its private key. */
    recoveryFingerprint: string;
    connectionId: string;
    candidateProfileRef: string;
    previousProfileRef?: string;
    now: string;
  }):
    | { kind: 'owner'; claim: CredentialApplicationHandle }
    | { kind: 'unavailable' };
  latest(connectionId: string): CredentialApplication | undefined;
  /** Cross-process config/application fence; always releases its exact token. */
  mutate<T>(
    connectionId: string,
    work: () => Promise<T>,
  ): Promise<{ kind: 'applied'; value: T } | { kind: 'unavailable' }>;
}

interface Coordinator {
  reserve(input: {
    attemptId: string;
    fingerprint: string;
    connectionId: string;
    candidateProfileRef: string;
    previousProfileRef?: string;
    now: string;
  }): CredentialApplication | null;
  transition(input: {
    attemptId: string;
    from: CredentialApplicationState[];
    to: CredentialApplicationState;
    now: string;
  }): CredentialApplicationTransition;
  acknowledge(input: {
    attemptId: string;
    now: string;
  }): CredentialApplicationTransition;
  latest(connectionId: string): CredentialApplication | null;
  acquireMutation(
    connectionId: string,
  ): { release(): void; stillOwner(): boolean } | null;
}

/**
 * Private operational ledger for exact credential application. Reserve occurs
 * before any profile mutation; every later state transition is guarded by its
 * immutable attempt identity and restart can read pending obligations here.
 */
export function createCredentialApplicationFactory(
  coordinator: Coordinator,
): CredentialApplicationFactory {
  const claim = (
    attemptId: string,
    application: CredentialApplication,
  ): CredentialApplicationHandle => {
    let settled: CredentialApplicationState | undefined = application.state;
    const transition = (
      to: CredentialApplicationState,
      from: CredentialApplicationState[],
      now: string,
    ) => {
      // A restart can reopen the exact persisted commit-pending record after
      // config adoption succeeded but before its final receipt transition.
      // Repeating that exact intent is a durable idempotent fact, not stale.
      if (settled === to) return { kind: 'applied' } as const;
      if (
        settled &&
        settled !== 'staged' &&
        settled !== 'reserved' &&
        settled !== 'indeterminate' &&
        settled !== 'commit-pending' &&
        settled !== to
      )
        return { kind: 'stale' } as const;
      const result = coordinator.transition({ attemptId, from, to, now });
      if (result.kind === 'applied') settled = to;
      return result;
    };
    return Object.freeze({
      application: Object.freeze(application),
      staged: (now: string) => transition('staged', ['reserved'], now),
      settle: (
        state: Extract<
          CredentialApplicationState,
          | 'commit-pending'
          | 'adopted'
          | 'rolled-back'
          | 'superseded'
          | 'indeterminate'
        >,
        now: string,
      ) =>
        transition(
          state,
          state === 'adopted'
            ? ['staged', 'commit-pending']
            : ['reserved', 'staged', 'indeterminate'],
          now,
        ),
      acknowledge: (now: string) => coordinator.acknowledge({ attemptId, now }),
    });
  };
  return {
    start(input: {
      recoveryFingerprint: string;
      connectionId: string;
      candidateProfileRef: string;
      previousProfileRef?: string;
      now: string;
    }):
      | { kind: 'owner'; claim: CredentialApplicationHandle }
      | { kind: 'unavailable' } {
      const attemptId = randomUUID();
      const application = coordinator.reserve({
        ...input,
        attemptId,
        fingerprint: input.recoveryFingerprint,
      });
      if (!application) return { kind: 'unavailable' };
      return {
        kind: 'owner',
        claim: claim(attemptId, application),
      };
    },
    latest(connectionId) {
      return coordinator.latest(connectionId) ?? undefined;
    },
    async mutate(connectionId, work) {
      const lock = coordinator.acquireMutation(connectionId);
      if (!lock) return { kind: 'unavailable' };
      try {
        if (!lock.stillOwner()) return { kind: 'unavailable' };
        const value = await work();
        return lock.stillOwner()
          ? { kind: 'applied', value }
          : { kind: 'unavailable' };
      } finally {
        lock.release();
      }
    },
  };
}
