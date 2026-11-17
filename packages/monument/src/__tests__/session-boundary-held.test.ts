import { describe, expect, test } from 'vitest';
import {
  type BoundaryCapture,
  createSessionTurnBoundaryAuthority,
  type SessionTurnBoundaryCoordinator,
  type SessionTurnBoundaryRecord,
  type SessionTurnBoundaryTransition,
} from '../session-boundary.js';

const OWNER = {
  id: 'owner-live',
  pid: 4242,
  identityKind: 'unverified',
} as const;
const THREAD = 'thread-held';
const NOW = '2026-11-16T00:00:00.000Z';

function row(
  overrides: Partial<SessionTurnBoundaryRecord> & { boundaryId: string },
): SessionTurnBoundaryRecord {
  return {
    threadId: THREAD,
    state: 'indeterminate',
    ownerId: OWNER.id,
    ownerPid: OWNER.pid,
    ownerIdentityKind: 'unverified',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * A coordinator whose rows the test writes directly, and whose transitions
 * can be made unavailable so the authority retains one as pending.
 */
function harness() {
  const rows = new Map<string, SessionTurnBoundaryRecord>();
  let transitions: SessionTurnBoundaryTransition['kind'] = 'applied';
  const coordinator = {
    create(record) {
      rows.set(record.boundaryId, { ...record });
      return { kind: 'applied' };
    },
    transition(input) {
      if (transitions !== 'applied') return { kind: transitions };
      const current = rows.get(input.boundaryId);
      if (current) rows.set(input.boundaryId, { ...current, state: input.to });
      return { kind: 'applied' };
    },
    remove(input) {
      rows.delete(input.boundaryId);
      return { kind: 'applied' };
    },
    removeTerminal: () => ({ kind: 'applied' }),
    hasPossibleEffect: () => rows.size > 0,
    active: () => [...rows.values()].map((record) => ({ ...record })),
    recordAccepted: () => ({ kind: 'applied' }),
  } as SessionTurnBoundaryCoordinator<BoundaryCapture, unknown>;
  const authority = createSessionTurnBoundaryAuthority<
    BoundaryCapture,
    unknown,
    unknown
  >({
    coordinator,
    terminalFromEvent: () => undefined,
    owner: OWNER,
    processIdentity: {
      exact: () => null,
      probe: () => ({ state: 'unavailable' }),
    },
  });
  const held = () => {
    const read = authority.heldTurnStarts?.(THREAD);
    if (read?.kind !== 'available') throw new Error('held starts unavailable');
    return read.records.map((record) => record.boundaryId).sort();
  };
  return {
    rows,
    authority,
    held,
    makeTransitionsUnavailable() {
      transitions = 'unavailable';
    },
  };
}

describe('heldTurnStarts', () => {
  test("lists only this owner's indeterminate sent turns on the thread", () => {
    const h = harness();
    h.rows.set('turn-boundary:mine', row({ boundaryId: 'turn-boundary:mine' }));
    // Another process's claim: boot recovery owns it once that owner dies.
    h.rows.set(
      'turn-boundary:foreign',
      row({ boundaryId: 'turn-boundary:foreign', ownerId: 'owner-other' }),
    );
    h.rows.set(
      'turn-boundary:invoking',
      row({ boundaryId: 'turn-boundary:invoking', state: 'invoking' }),
    );
    h.rows.set(
      'turn-boundary:other-thread',
      row({ boundaryId: 'turn-boundary:other-thread', threadId: 'elsewhere' }),
    );
    h.rows.set(
      'session-start-boundary:start',
      row({ boundaryId: 'session-start-boundary:start' }),
    );
    h.rows.set(
      'task-dispatch:dispatch',
      row({ boundaryId: 'task-dispatch:dispatch', purpose: 'task-dispatch' }),
    );
    h.rows.set(
      'provider-turn-boundary:engine',
      row({ boundaryId: 'provider-turn-boundary:engine' }),
    );
    expect(h.held()).toEqual(['turn-boundary:mine']);
  });

  test('a row whose transition is still being retried is not listed', () => {
    const h = harness();
    const claimed = h.authority.claim(THREAD, NOW);
    if (claimed.kind !== 'owner') throw new Error('claim refused');
    expect(claimed.claim.beginInvocation(NOW)).toEqual({ kind: 'applied' });
    const [boundaryId] = [...h.rows.keys()];
    // The indeterminate write is lost, so the authority keeps retrying it;
    // the stored row still reads as held by this owner meanwhile.
    h.makeTransitionsUnavailable();
    expect(claimed.claim.indeterminate(NOW)).toEqual({ kind: 'unavailable' });
    h.rows.set(boundaryId!, row({ boundaryId: boundaryId! }));
    expect(h.held()).toEqual([]);
  });

  test('the same row is listed once nothing retries it', () => {
    const h = harness();
    const claimed = h.authority.claim(THREAD, NOW);
    if (claimed.kind !== 'owner') throw new Error('claim refused');
    claimed.claim.beginInvocation(NOW);
    expect(claimed.claim.indeterminate(NOW)).toEqual({ kind: 'applied' });
    expect(h.held()).toEqual([...h.rows.keys()]);
  });
});
