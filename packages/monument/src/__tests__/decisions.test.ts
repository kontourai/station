import { describe, expect, it } from 'vitest';
import { compareCodePoints } from '../decisions/order.js';
import {
  decideTurnDedupClaim,
  turnClaimIsReclaimable,
} from '../decisions/turn-dedup.js';
import {
  decideTurnBoundaryBeginInvocation,
  decideTurnBoundaryPrepare,
  decideTurnDedupBeginInvocation,
  decideTurnDedupRelease,
} from '../index.js';
import { ownerLivenessFromProbe } from '../owner.js';
import type { TurnDedupRecord } from '../records.js';
import { createFakeProcessTable } from '../testing/index.js';

describe('pure decisions', () => {
  for (const invocation of [
    'pending',
    'begun',
    'untracked',
    undefined,
  ] as const) {
    it(`complete prepared links fence ordinary release/claim/begin with invocation ${invocation ?? 'unknown'}`, () => {
      const processes = createFakeProcessTable();
      const owner = processes.spawn();
      processes.kill(owner);
      const record: TurnDedupRecord = {
        key: 'k',
        value: null,
        createdAt: 1,
        owner,
        invocation,
        preparedInvocationId: 'i',
        preparedUpdatedAt: '2',
      };
      expect(
        decideTurnDedupRelease(record, {
          type: 'turnDedup.release',
          key: 'k',
          ownerId: owner.id,
          now: 3,
        }),
      ).toEqual({ write: { kind: 'none' }, result: { kind: 'stale' } });
      expect(
        decideTurnDedupClaim(
          record,
          {
            type: 'turnDedup.claim',
            key: 'k',
            owner: processes.spawn(),
            now: 3,
            tracking: 'tracked',
          },
          processes.liveness,
        ),
      ).toEqual({
        write: { kind: 'none' },
        result:
          invocation === 'pending'
            ? { kind: 'prepared', invocationId: 'i' }
            : { kind: 'indeterminate' },
      });
      expect(
        decideTurnDedupBeginInvocation(record, {
          type: 'turnDedup.beginInvocation',
          key: 'k',
          ownerId: owner.id,
          now: 3,
        }),
      ).toEqual({ write: { kind: 'none' }, result: { kind: 'refused' } });
    });
  }
  for (const metadata of [
    { preparedUpdatedAt: '2' },
    { preparedInvocationId: 'i' },
  ]) {
    it(`adapter records with partial prepared metadata ${Object.keys(metadata)[0]} never authorize ordinary or compound begin`, () => {
      const processes = createFakeProcessTable();
      const owner = processes.spawn();
      processes.kill(owner);
      const record: TurnDedupRecord = {
        key: 'k',
        value: null,
        owner,
        invocation: 'pending',
        createdAt: 1,
        ...metadata,
      };
      expect(turnClaimIsReclaimable(record)).toBe(false);
      expect(
        decideTurnDedupClaim(
          record,
          {
            type: 'turnDedup.claim',
            key: 'k',
            owner: processes.spawn(),
            now: 3,
            tracking: 'tracked',
          },
          processes.liveness,
        ),
      ).toEqual({ write: { kind: 'none' }, result: { kind: 'indeterminate' } });
      expect(
        decideTurnDedupBeginInvocation(record, {
          type: 'turnDedup.beginInvocation',
          key: 'k',
          ownerId: owner.id,
          now: 3,
        }),
      ).toEqual({ write: { kind: 'none' }, result: { kind: 'refused' } });
      expect(
        decideTurnDedupRelease(record, {
          type: 'turnDedup.release',
          key: 'k',
          ownerId: owner.id,
          now: 3,
        }),
      ).toEqual({ write: { kind: 'none' }, result: { kind: 'stale' } });
      const intent = {
        invocationId: 'i',
        inputDigest: 'input',
        intentDigest: 'envelope',
        bodyRef: 'body',
        dedupKey: 'k',
      };
      const boundary = {
        boundaryId: 'b',
        threadId: 't',
        purpose: 'turn',
        state: 'prepared',
        owner,
        createdAt: '1',
        updatedAt: '2',
        intent,
      } as const;
      expect(
        decideTurnBoundaryBeginInvocation(boundary, record, false, {
          type: 'turnBoundary.beginInvocation',
          boundaryId: 'b',
          ownerId: owner.id,
          dedupOwnerId: owner.id,
          intent,
          now: '3',
        }),
      ).toEqual({ result: { kind: 'refused' } });
      expect(
        decideTurnBoundaryPrepare(
          { ...boundary, state: 'reserved', intent: undefined },
          record,
          false,
          {
            type: 'turnBoundary.prepare',
            boundaryId: 'b',
            ownerId: owner.id,
            dedupOwnerId: owner.id,
            intent,
            now: '3',
          },
        ),
      ).toEqual({ result: { kind: 'stale' } });
    });
  }
  it('a dead owner with no invocation record is indeterminate, not reclaimed', () => {
    const processes = createFakeProcessTable();
    const dead = processes.spawn();
    processes.kill(dead);
    const legacy: TurnDedupRecord = {
      key: 'k',
      value: null,
      createdAt: 1,
      owner: dead,
    };
    expect(turnClaimIsReclaimable(legacy)).toBe(false);
    expect(
      decideTurnDedupClaim(
        legacy,
        {
          type: 'turnDedup.claim',
          key: 'k',
          owner: processes.spawn(),
          now: 2,
          tracking: 'tracked',
        },
        processes.liveness,
      ),
    ).toEqual({ write: { kind: 'none' }, result: { kind: 'indeterminate' } });
  });

  it('liveness: released is dead, local is live, unavailable is unknown, a new birth is dead', () => {
    const liveness = ownerLivenessFromProbe(
      (pid) =>
        pid === 1
          ? { state: 'unavailable' }
          : pid === 2
            ? { state: 'dead' }
            : { state: 'exact', identity: { pid, start: 'b' } },
      {
        isReleased: (id) => id === 'released',
        isLocallyLive: (id) => id === 'local',
      },
    );
    const exact = (id: string, pid: number, birth = 'b') =>
      ({ id, pid, identityKind: 'exact', birth }) as const;
    expect(liveness(exact('released', 3))).toBe('dead');
    expect(liveness(exact('local', 2))).toBe('live');
    expect(liveness(exact('x', 1))).toBe('unknown');
    expect(liveness(exact('x', 2))).toBe('dead');
    expect(liveness(exact('x', 3))).toBe('live');
    expect(liveness(exact('x', 3, 'other'))).toBe('dead');
    expect(liveness({ id: 'x', pid: 3, identityKind: 'unverified' })).toBe(
      'live',
    );
  });

  it('orders strings by code point, as SQLite orders UTF-8 text', () => {
    // U+FF5E sorts below U+1F600 by code point, above it by UTF-16 unit.
    expect(compareCodePoints('～', '\u{1f600}')).toBe(-1);
    expect('～' < '\u{1f600}').toBe(false);
    expect(compareCodePoints('a', 'ab')).toBe(-1);
    expect(compareCodePoints('ab', 'ab')).toBe(0);
  });
});
