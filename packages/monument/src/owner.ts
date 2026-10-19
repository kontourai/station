/**
 * Who holds a durable claim, and whether that holder can still be acting.
 *
 * An owner is a process plus a token unique to one claimant inside it. An
 * `exact` owner also records the process's birth (start time), so a reused
 * pid is told apart from the original process. An `unverified` owner has no
 * birth, so only an observed `dead` proves it gone.
 */
export type OwnerIdentity =
  | {
      readonly id: string;
      readonly pid: number;
      readonly identityKind: 'exact';
      readonly birth: string;
    }
  | {
      readonly id: string;
      readonly pid: number;
      readonly identityKind: 'unverified';
    };

/** What a process-identity probe observed for one pid. */
export type ProcessIdentityObservation =
  | { readonly state: 'dead' }
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'exact';
      readonly identity: { readonly pid: number; readonly start: string };
    };

export type ProcessIdentityProbe = (pid: number) => ProcessIdentityObservation;

/**
 * The three-state liveness answer every decision consumes.
 *
 * - `dead`: the owner provably cannot still be acting.
 * - `live`: the owner's process exists with a matching (or unverifiable) birth.
 * - `unknown`: the probe could not tell. Decisions treat it like `live`:
 *   nothing a dead owner would permit is permitted on an unknown owner.
 */
export type OwnerLivenessVerdict = 'dead' | 'live' | 'unknown';

/**
 * Synchronous on purpose: it runs inside the adapter's transaction, where
 * the decision that consumes it is made.
 */
export type OwnerLiveness = (owner: OwnerIdentity) => OwnerLivenessVerdict;

export interface OwnerLivenessOptions {
  /**
   * Owners this process knows it released. They are dead even if their pid
   * (this process) is alive.
   */
  readonly isReleased?: (ownerId: string) => boolean;
  /**
   * Owners this process knows are live in it, answered without a probe. A
   * host should return true only for owners whose pid is its own.
   */
  readonly isLocallyLive?: (ownerId: string) => boolean;
}

/**
 * The shared rule: dead when the probe says dead, or when an exact owner's
 * recorded birth differs from the observed one (the pid was reused). An
 * unavailable probe is `unknown`, never `dead`.
 */
export function ownerLivenessFromProbe(
  probe: ProcessIdentityProbe,
  options: OwnerLivenessOptions = {},
): OwnerLiveness {
  return (owner) => {
    if (options.isReleased?.(owner.id)) return 'dead';
    if (options.isLocallyLive?.(owner.id)) return 'live';
    const observed = probe(owner.pid);
    if (observed.state === 'dead') return 'dead';
    if (observed.state === 'unavailable') return 'unknown';
    if (
      owner.identityKind === 'exact' &&
      observed.identity.start !== owner.birth
    )
      return 'dead';
    return 'live';
  };
}

/**
 * Strict decoding for owners read back from storage. Anything malformed is
 * refused rather than guessed at: a guessed owner could turn into a
 * reclaimable one.
 */
export function parseOwnerIdentity(
  value: unknown,
  options: {
    /**
     * Station's boundary rows allow an `exact` owner with no birth and treat
     * it as live while its pid answers, which is what `unverified` means.
     * Refusing such a row would stop every command that lists boundaries.
     */
    readonly birthlessExact?: 'refuse' | 'unverified';
  } = {},
): OwnerIdentity {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid monument owner: not an object.');
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id)
    throw new Error('Invalid monument owner: missing id.');
  if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid < 1)
    throw new Error('Invalid monument owner: invalid pid.');
  if (raw.identityKind === 'exact') {
    if (
      options.birthlessExact === 'unverified' &&
      (raw.birth === undefined || raw.birth === null || raw.birth === '')
    )
      return { id: raw.id, pid: raw.pid, identityKind: 'unverified' };
    if (typeof raw.birth !== 'string' || !raw.birth)
      throw new Error('Invalid monument owner: exact owner without birth.');
    return {
      id: raw.id,
      pid: raw.pid,
      identityKind: 'exact',
      birth: raw.birth,
    };
  }
  if (raw.identityKind === 'unverified')
    return { id: raw.id, pid: raw.pid, identityKind: 'unverified' };
  throw new Error('Invalid monument owner: unknown identity kind.');
}

/** Field by field, so nothing else rides along with a stored owner. */
export function ownerFields(owner: OwnerIdentity): OwnerIdentity {
  return owner.identityKind === 'exact'
    ? {
        id: owner.id,
        pid: owner.pid,
        identityKind: 'exact',
        birth: owner.birth,
      }
    : { id: owner.id, pid: owner.pid, identityKind: 'unverified' };
}
