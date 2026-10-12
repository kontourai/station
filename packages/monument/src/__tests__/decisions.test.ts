import { describe, expect, it } from 'vitest';
import { compareCodePoints } from '../decisions/order.js';
import {
  decideTurnDedupClaim,
  turnClaimIsReclaimable,
} from '../decisions/turn-dedup.js';
import { ownerLivenessFromProbe } from '../owner.js';
import type { TurnDedupRecord } from '../records.js';
import { createFakeProcessTable } from '../testing/index.js';

describe('pure decisions', () => {
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
