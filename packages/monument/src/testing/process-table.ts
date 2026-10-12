import {
  type OwnerIdentity,
  type OwnerLiveness,
  ownerLivenessFromProbe,
  type ProcessIdentityProbe,
} from '../owner.js';

/**
 * A deterministic stand-in for the host's process table, so liveness in a
 * test is something the test decides rather than something the machine does.
 */
export interface FakeProcessTable {
  /** A new owner in a new, live process. */
  spawn(options?: { identityKind?: 'exact' | 'unverified' }): OwnerIdentity;
  /** The owner's process exits. */
  kill(owner: OwnerIdentity): void;
  /** The owner's pid is reused by a different process (a new birth). */
  reusePid(owner: OwnerIdentity): void;
  /** The probe cannot observe this owner's process. */
  makeUnobservable(owner: OwnerIdentity): void;
  readonly probe: ProcessIdentityProbe;
  readonly liveness: OwnerLiveness;
}

export function createFakeProcessTable(): FakeProcessTable {
  const births = new Map<number, string>();
  const unobservable = new Set<number>();
  let nextPid = 1000;
  let generation = 0;
  const probe: ProcessIdentityProbe = (pid) => {
    if (unobservable.has(pid)) return { state: 'unavailable' };
    const start = births.get(pid);
    return start === undefined
      ? { state: 'dead' }
      : { state: 'exact', identity: { pid, start } };
  };
  return {
    spawn(options = {}) {
      nextPid += 1;
      generation += 1;
      const birth = `birth-${generation}`;
      births.set(nextPid, birth);
      const id = `owner-${nextPid}-${generation}`;
      return options.identityKind === 'unverified'
        ? { id, pid: nextPid, identityKind: 'unverified' }
        : { id, pid: nextPid, identityKind: 'exact', birth };
    },
    kill(owner) {
      births.delete(owner.pid);
    },
    reusePid(owner) {
      generation += 1;
      births.set(owner.pid, `birth-${generation}`);
    },
    makeUnobservable(owner) {
      unobservable.add(owner.pid);
    },
    probe,
    liveness: ownerLivenessFromProbe(probe),
  };
}
