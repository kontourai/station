/**
 * OrchestrationStreamPresence — archive#1225 (offline): tracks how
 * many live `/api/orchestration/events` SSE subscribers each authorized
 * presence subject currently holds open.
 *
 * This is the server-side "is anyone actually watching?" signal the
 * push-on-completion gate needs (`turn-completion-notifications.ts`): a
 * turn that completes/fails while its owning user has zero live streams
 * gets a push; a turn that completes while the owner is actively connected
 * does not (they already see it render). Counting rather than a boolean
 * because a user can legitimately hold more than one open tab/device stream
 * at once — only the LAST one leaving flips them to "disconnected". Hosted
 * subjects include the trusted tenant binding as well as the user, so a
 * shared user identity in alpha cannot suppress a bravo completion notice.
 *
 * Deliberately in-memory/process-local, matching every other per-connection
 * bookkeeping this route already does (the `unsub` closures, the
 * ordering-fence `pending` buffer) — there is exactly one Station server
 * process per instance, so this never needs to be durable or cross-process.
 *
 * archive#4075 stage 3 slice 2: `connect()` additionally accepts the
 * caller's already-resolved `PrincipalRef` (the SAME value the stage-2
 * fail-closed resolver produced for this exact request — never re-resolved
 * here) and retains it per subject, bounded, so a session-agnostic "who's
 * connected" roster can be read back (`roster()`) without a second identity
 * registry. This is purely additive to the ref-counting above: the
 * `countsBySubject` map and everything the push-on-completion gate reads
 * (`isConnected`/`hasAnyConnection`) are completely unaffected by roster
 * bounds — a connection that overflows the roster is still counted there,
 * exactly as before. Bounds mirror `ClientConnectionPresence`'s discipline
 * (`services/ssh/client-connection-presence.ts`): a total-tracked-principal
 * capacity (that class's `CLIENT_CONNECTION_CAPACITY`, keyed there by
 * device) and a per-principal reported-connection capacity (that class's
 * `CLIENT_CONNECTIONS_PER_DEVICE_CAPACITY`, keyed there by client session).
 * Overflow never refuses a real connection or corrupts ref-count accuracy —
 * it only caps what the ROSTER reports: a principal beyond the total
 * capacity is silently omitted from `roster()` (their stream still counts
 * for `isConnected`), and a principal's reported `connections` saturates at
 * the per-principal capacity while the real ref count keeps accruing/
 * releasing underneath so connect/disconnect symmetry never drifts.
 */
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type {
  SessionReadAuthority,
  TenantExecutionContext,
} from '@kontourai/station-contracts/tenancy';

/**
 * Max distinct principals `roster()` will ever report at once. Mirrors
 * `ClientConnectionPresence`'s `CLIENT_CONNECTION_CAPACITY` (256) — see
 * `client-connection-presence.ts`. A principal beyond this cap is never
 * added to the roster; its underlying SSE connection(s) are unaffected and
 * still counted by `isConnected`/`hasAnyConnection`.
 */
export const ORCHESTRATION_STREAM_PRESENCE_ROSTER_CAPACITY = 256;

/**
 * Max `connections` value `roster()` will ever report for a single
 * principal. Mirrors `ClientConnectionPresence`'s
 * `CLIENT_CONNECTIONS_PER_DEVICE_CAPACITY` (32). The real reference count
 * keeps counting past this ceiling underneath (so a disconnect always
 * matches its connect exactly); only the REPORTED number saturates.
 */
export const ORCHESTRATION_STREAM_PRESENCE_ROSTER_CONNECTIONS_PER_PRINCIPAL_CAPACITY = 32;

/** One roster()-reported principal and its (possibly saturated) connection count. */
export interface OrchestrationStreamPresenceRosterEntry {
  readonly principal: PrincipalRef;
  readonly connections: number;
}

interface RosterRecord {
  principal: PrincipalRef;
  /** Real, uncapped reference count — never saturated, so release() always balances connect(). */
  refs: number;
}

export interface OrchestrationStreamPresenceOptions {
  readonly rosterCapacity?: number;
  readonly rosterConnectionsPerPrincipalCapacity?: number;
  /** OTel hook — never required, matching `ClientConnectionPresenceOptions.record`'s posture. */
  readonly onRosterOp?: (op: 'retain' | 'release' | 'capacity') => void;
}

const presenceSubjectKey: unique symbol = Symbol(
  'StationOrchestrationStreamPresenceSubject',
);

/**
 * Opaque, server-only identity for a live orchestration stream. Its key is
 * intentionally inaccessible to callers, so tenant context cannot become a
 * route payload or an ad-hoc string convention.
 */
export interface OrchestrationStreamPresenceSubject {
  readonly [presenceSubjectKey]: string;
}

function presenceSubject(key: unknown): OrchestrationStreamPresenceSubject {
  return Object.freeze({
    [presenceSubjectKey]: JSON.stringify(key),
  }) as OrchestrationStreamPresenceSubject;
}

/**
 * The future route seam: request authority becomes presence identity in one
 * place. A hosted request without a trusted tenant never receives a subject.
 */
export function orchestrationStreamPresenceSubjectFromAuthority(
  authority: SessionReadAuthority,
): OrchestrationStreamPresenceSubject | undefined {
  if (authority.mode === 'hosted') {
    if (!authority.tenantExecutionContext) return undefined;
    return orchestrationStreamPresenceSubjectForSession(
      authority.userId,
      authority.tenantExecutionContext,
    );
  }
  return orchestrationStreamPresenceSubjectForSession(authority.userId);
}

/**
 * Builds the same opaque subject from a completed session's private binding.
 * `tenantExecutionContext` is omitted only for personal-mode sessions.
 */
export function orchestrationStreamPresenceSubjectForSession(
  userId: string,
  tenantExecutionContext?: TenantExecutionContext,
): OrchestrationStreamPresenceSubject {
  return presenceSubject(
    tenantExecutionContext
      ? ['hosted', tenantExecutionContext.tenantId, userId]
      : ['personal', userId],
  );
}

/** Personal-mode compatibility for a persisted ownerless session. */
export function anyPersonalOrchestrationStreamPresenceSubject(): OrchestrationStreamPresenceSubject {
  return presenceSubject(['personal-any']);
}

export class OrchestrationStreamPresence {
  private readonly countsBySubject = new Map<string, number>();
  private readonly rosterBySubject = new Map<string, RosterRecord>();
  private readonly rosterCapacity: number;
  private readonly rosterConnectionsPerPrincipalCapacity: number;
  private readonly onRosterOp?: (op: 'retain' | 'release' | 'capacity') => void;

  constructor(options: OrchestrationStreamPresenceOptions = {}) {
    this.rosterCapacity =
      options.rosterCapacity ?? ORCHESTRATION_STREAM_PRESENCE_ROSTER_CAPACITY;
    this.rosterConnectionsPerPrincipalCapacity =
      options.rosterConnectionsPerPrincipalCapacity ??
      ORCHESTRATION_STREAM_PRESENCE_ROSTER_CONNECTIONS_PER_PRINCIPAL_CAPACITY;
    this.onRosterOp = options.onRosterOp;
  }

  /**
   * Registers one live connection. The string overload is retained for the
   * existing personal-mode route wiring; hosted route wiring must pass the
   * opaque subject created from request authority above.
   *
   * `principal` (archive#4075 stage 3 slice 2) is the caller's already-
   * resolved `PrincipalRef` for this exact connection, retained (bounded,
   * see the class docblock) so `roster()` can report it. Optional and
   * additive: omitting it (every pre-existing caller, and the test-only
   * `getUserId` escape hatch that has no `PrincipalRef` to offer) still
   * ref-counts normally — that connection simply never appears in the
   * roster, exactly like an overflow connection does not.
   */
  connect(
    subject: OrchestrationStreamPresenceSubject | string,
    principal?: PrincipalRef,
  ): () => void {
    const key =
      typeof subject === 'string'
        ? orchestrationStreamPresenceSubjectForSession(subject)[
            presenceSubjectKey
          ]
        : subject[presenceSubjectKey];
    this.countsBySubject.set(key, (this.countsBySubject.get(key) ?? 0) + 1);
    if (principal) this.#retainPrincipal(key, principal);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.countsBySubject.get(key) ?? 1) - 1;
      if (next <= 0) this.countsBySubject.delete(key);
      else this.countsBySubject.set(key, next);
      if (principal) this.#releasePrincipal(key);
    };
  }

  #retainPrincipal(key: string, principal: PrincipalRef): void {
    const existing = this.rosterBySubject.get(key);
    if (existing) {
      existing.refs += 1;
      this.onRosterOp?.('retain');
      return;
    }
    if (this.rosterBySubject.size >= this.rosterCapacity) {
      // Roster capacity exceeded: this connection is still fully counted in
      // `countsBySubject` above (isConnected/hasAnyConnection are
      // unaffected) — it is only omitted from `roster()`'s reported list.
      this.onRosterOp?.('capacity');
      return;
    }
    this.rosterBySubject.set(key, { principal, refs: 1 });
    this.onRosterOp?.('retain');
  }

  #releasePrincipal(key: string): void {
    const existing = this.rosterBySubject.get(key);
    // Never tracked (capacity-refused at connect time) — nothing to release.
    if (!existing) return;
    existing.refs -= 1;
    if (existing.refs <= 0) this.rosterBySubject.delete(key);
    this.onRosterOp?.('release');
  }

  /**
   * The session-agnostic "who's connected" roster (archive#4075 stage 3
   * slice 2): every principal currently retained above, each with its
   * (possibly saturated — see the class docblock) live connection count.
   * Sorted by principal id for a deterministic response.
   */
  roster(): OrchestrationStreamPresenceRosterEntry[] {
    return [...this.rosterBySubject.values()]
      .map((record) => ({
        principal: record.principal,
        connections: Math.min(
          record.refs,
          this.rosterConnectionsPerPrincipalCapacity,
        ),
      }))
      .sort((a, b) => a.principal.id.localeCompare(b.principal.id));
  }

  /** `true` when this exact subject currently holds a live stream open. */
  isConnected(subject: OrchestrationStreamPresenceSubject | string): boolean {
    if (typeof subject === 'string') {
      return this.isConnected(
        orchestrationStreamPresenceSubjectForSession(subject),
      );
    }
    if (subject[presenceSubjectKey] === JSON.stringify(['personal-any'])) {
      return this.hasAnyConnection();
    }
    return (this.countsBySubject.get(subject[presenceSubjectKey]) ?? 0) > 0;
  }

  /**
   * `true` when ANY user currently holds a live stream open. Used as the
   * fallback signal for an ownerless session (`ownerlessSessionAccess:
   * 'single-user-compat'` — see `SessionAuthorization.canReadSession`):
   * there is no distinct owner identity to key presence by, so "is the
   * single operator currently connected at all" is the closest available
   * proxy for "is anyone watching this session".
   */
  hasAnyConnection(): boolean {
    return this.countsBySubject.size > 0;
  }
}
