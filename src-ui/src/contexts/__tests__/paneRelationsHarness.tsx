import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { act } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { AuthorityPersistenceContext } from '../AuthorityPersistenceContext';

/**
 * Shared seams for the pane-relationship suites: a Web Locks stand-in with
 * real exclusive semantics (one holder; `ifAvailable` answers `null` while it
 * is held), and an authority provider whose verified Station a test switches.
 */

export interface FakeLocks {
  /** Hold the relations lock from outside, as another tab would. */
  holdExternally(): () => void;
  /** How many requests were made for the relations lock. */
  requests(): number;
}

const RELATIONS_LOCK = 'station:pane-relations';

/**
 * Named exclusive locks, one holder per name — as Web Locks is. Other owners
 * (a region host's persistence lease) hold their own names for their whole
 * lifetime, so a fake with one global lock would make every relations write
 * read as contended.
 */
export function installFakeLocks(): FakeLocks {
  const held = new Set<string>();
  let requests = 0;
  const locks = {
    request: async (
      name: string,
      options: { ifAvailable?: boolean },
      callback: (lock: object | null) => unknown,
    ) => {
      if (name === RELATIONS_LOCK) requests += 1;
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        throw new Error('the fake only models ifAvailable requests');
      }
      held.add(name);
      try {
        return await callback({});
      } finally {
        held.delete(name);
      }
    },
  };
  Object.defineProperty(globalThis.navigator, 'locks', {
    configurable: true,
    value: locks,
  });
  return {
    holdExternally: () => {
      held.add(RELATIONS_LOCK);
      return () => {
        held.delete(RELATIONS_LOCK);
      };
    },
    requests: () => requests,
  };
}

export function removeLocks() {
  delete (globalThis.navigator as { locks?: unknown }).locks;
}

function observation(environmentId: string): AuthorityObservation {
  return {
    schemaVersion: 'station.authority-observation/v1',
    environmentId,
    principal: { kind: 'human', id: 'operator' },
    grant: { kind: 'operator' },
  };
}

export type Authority = 'unavailable' | 'unverified' | { station: string };

export const authoritySwitch: { set: ((value: Authority) => void) | null } = {
  set: null,
};

export function AuthorityHarness({
  initial,
  children,
}: {
  initial: Authority;
  children: ReactNode;
}) {
  const [authority, setAuthority] = useState<Authority>(initial);
  authoritySwitch.set = setAuthority;
  const value =
    authority === 'unavailable' || authority === 'unverified'
      ? { status: authority, namespace: null, observation: null }
      : {
          status: 'verified' as const,
          namespace: `ns:${authority.station}`,
          observation: observation(authority.station),
        };
  return (
    <AuthorityPersistenceContext.Provider value={value}>
      {children}
    </AuthorityPersistenceContext.Provider>
  );
}

function storageSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key !== null) snapshot[key] = localStorage.getItem(key) ?? '';
  }
  return snapshot;
}

/**
 * Every localStorage key and value, read once the region model's coalesced
 * arrangement write has landed. That write trails a change by 150ms
 * (`REGION_ARRANGEMENT_PERSIST_DELAY_MS`), so a snapshot taken sooner can be
 * raced by the write of an EARLIER change — and one taken after a refusal
 * would miss an arrangement write the refusal wrongly scheduled.
 */
export async function settledStorageSnapshot(): Promise<
  Record<string, string>
> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  return storageSnapshot();
}
