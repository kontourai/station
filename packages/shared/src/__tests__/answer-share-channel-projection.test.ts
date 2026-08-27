import type {
  AnswerShareChannelBinding,
  AnswerShareTextBlock,
} from '@kontourai/station-contracts/answer-share';
import { validateAnswerShareChannelBinding } from '@kontourai/station-contracts/answer-share-channel';
import { describe, expect, it } from 'vitest';
import {
  type AnswerShareChannelLogPort,
  type AnswerShareChannelResolution,
  arbitrateAnswerShareContent,
  deriveAnswerShareChannelView,
} from '../answer-share-projection.js';

/**
 * station#1598 — the read side of the channel binding, exercised with no
 * server and no channel log, which is the whole reason it lives in a pure
 * module.
 *
 * The `committed` branch has no live producer anywhere in Station: only the
 * slice-1 contracts landed, and the log itself is slice 2. So it is proven
 * here by an INJECTED port double against hand-built records — real, fully
 * validated code with no production caller, rather than a stub service that
 * would have destroyed the one structural proof this slice has (see the
 * `reported` tests below).
 */

const COORDINATE = { channelId: 'chan-team-alpha', epoch: 3, seq: 412 };
const CHECKPOINT_DIGEST = 'anchor-digest-1';

const COMMITTED: AnswerShareChannelBinding = {
  binding: 'committed',
  ref: { refKind: 'committed-message', id: 'msg-9f2c1b7a' },
  coordinate: COORDINATE,
  checkpointDigest: CHECKPOINT_DIGEST,
};

function port(
  resolution: AnswerShareChannelResolution | undefined,
): AnswerShareChannelLogPort {
  return { resolveCommittedRecord: () => resolution };
}

const AGREEING: AnswerShareChannelResolution = {
  coordinate: { ...COORDINATE },
  checkpointDigest: CHECKPOINT_DIGEST,
  supersession: 'current',
};

describe('the two "nothing to report" states never collapse into each other', () => {
  it('an ABSENT binding reads as predates-channel-addressing, never as not-in-channel', () => {
    // The record was minted before bindings existed, so nobody looked. Saying
    // "not in a channel" would be a fact this Station does not have, and it
    // is the one substitution a backfill would make silently.
    expect(deriveAnswerShareChannelView({ binding: undefined }).status).toEqual(
      {
        status: 'unavailable',
        reason: 'predates-channel-addressing',
      },
    );
  });

  it('a RECORDED `none` reads as not-in-channel, never as predates', () => {
    expect(
      deriveAnswerShareChannelView({ binding: { binding: 'none' } }).status,
    ).toEqual({ status: 'unavailable', reason: 'not-in-channel' });
  });

  it('the two live in different layers: "unknown" is refused by the STORED validator, and the computed reason is not a storable value', () => {
    // The design's rule here is a LAYERING rule: `none` is a member of the
    // stored union, "unknown" is the absence of that union, and the two must
    // not meet. Asserted against the real validator and the real derivation
    // rather than against a literal array built in this file — a list of
    // strings the test itself writes cannot fail for any change to the
    // implementation, which makes it coverage-shaped and evidence-free.
    for (const discriminant of ['unknown', 'unresolvable', 'unresolved']) {
      const refused = validateAnswerShareChannelBinding({
        binding: discriminant,
      });
      expect(refused.ok, discriminant).toBe(false);
    }
    // And the computed reason for an absent record is not something any
    // stored binding could ever carry, so a record cannot assert it.
    const absent = deriveAnswerShareChannelView({ binding: undefined }).status;
    expect(absent).toEqual({
      status: 'unavailable',
      reason: 'predates-channel-addressing',
    });
    expect(
      validateAnswerShareChannelBinding({
        binding: 'predates-channel-addressing',
      }).ok,
    ).toBe(false);
  });
});

describe('the port is an INTERFACE, not a validator — what it returns is gated and re-mapped', () => {
  /**
   * The compiler does not check what an implementation of
   * `AnswerShareChannelLogPort` hands back at runtime, and its excess-property
   * check fires on object literals rather than on an assigned variable — so
   * the object below type-checks as a `ChannelCommitCoordinate` at the call
   * site. Slice 2's log will return its own stored coordinate, and this
   * status is serialized whole to an unauthenticated share holder.
   */
  const COORDINATE_WITH_EXTRAS = {
    ...COORDINATE,
    locatorHint: 'https://home.example.test/chan-team-alpha',
    authoredBy: 'member-7f3c1d',
    parentDigest: 'digest-of-the-parent-record',
  };

  it('a field the port added never reaches the payload', () => {
    const view = deriveAnswerShareChannelView({
      binding: COMMITTED,
      channelLog: port({
        coordinate: COORDINATE_WITH_EXTRAS,
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
      }),
    });
    // It still corroborates — the comparison reads the three declared fields,
    // so the extras never affect the verdict. That is exactly why they would
    // have shipped unnoticed.
    expect(view.status).toEqual({
      status: 'reported',
      coordinate: COORDINATE,
      supersession: 'current',
    });
    const payload = JSON.stringify(view.status);
    for (const leaked of [
      'locatorHint',
      'home.example.test',
      'authoredBy',
      'member-7f3c1d',
      'parentDigest',
      'digest-of-the-parent-record',
    ]) {
      expect(payload, leaked).not.toContain(leaked);
    }
    // The port's own object is not the object that ships.
    if (view.status.status !== 'reported') throw new Error('expected reported');
    expect(view.status.coordinate).not.toBe(COORDINATE_WITH_EXTRAS);
  });

  it('the checkpoint digest is never disclosed even when it corroborates', () => {
    const view = deriveAnswerShareChannelView({
      binding: COMMITTED,
      channelLog: port(AGREEING),
    });
    expect(JSON.stringify(view.status)).not.toContain(CHECKPOINT_DIGEST);
  });

  it('a resolution this build cannot read refuses instead of throwing', () => {
    // `corroborates` dereferences the served coordinate. Without a gate, a
    // resolution shaped like a genesis or unsequenced entry throws a
    // TypeError that escapes the service and the public view route — a 500
    // where the design says `history-not-served`, on an unauthenticated
    // endpoint.
    const unreadable: Record<string, unknown>[] = [
      { checkpointDigest: CHECKPOINT_DIGEST, supersession: 'current' },
      {
        coordinate: null,
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
      },
      {
        coordinate: [COORDINATE.channelId, COORDINATE.epoch, COORDINATE.seq],
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
      },
      {
        coordinate: { ...COORDINATE, channelId: '' },
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
      },
      {
        coordinate: { epoch: COORDINATE.epoch, seq: COORDINATE.seq },
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
      },
      {
        coordinate: { ...COORDINATE, seq: 412.5 },
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
      },
      {
        coordinate: { ...COORDINATE, epoch: Number.NaN },
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
      },
      { coordinate: { ...COORDINATE }, supersession: 'current' },
      {
        coordinate: { ...COORDINATE },
        checkpointDigest: '',
        supersession: 'current',
      },
    ];
    for (const resolution of unreadable) {
      const label = JSON.stringify(resolution);
      let view: ReturnType<typeof deriveAnswerShareChannelView> | undefined;
      expect(() => {
        view = deriveAnswerShareChannelView({
          binding: COMMITTED,
          channelLog: port(
            resolution as unknown as AnswerShareChannelResolution,
          ),
        });
      }, label).not.toThrow();
      // Not `coordinate-mismatch`: nothing was compared, so a claim about a
      // comparison would be a claim about something that never ran.
      expect(view?.status, label).toEqual({
        status: 'unavailable',
        reason: 'history-not-served',
      });
      expect(view?.corroborated, label).toBeUndefined();
    }
  });
});

describe('AC3 — `reported` is a checked result, never an echoed label', () => {
  it('is UNREACHABLE from the stored binding alone, with no channel log served', () => {
    // This is production today: Station has no channel log, so the port is
    // absent and a perfectly well-formed `committed` record still cannot
    // reach `reported`. That is the structural proof — not a test that
    // happens to pass, but a state the code has no path to.
    expect(deriveAnswerShareChannelView({ binding: COMMITTED }).status).toEqual(
      {
        status: 'unavailable',
        reason: 'history-not-served',
      },
    );
  });

  it('is unreachable when the log serves nothing for the ref', () => {
    expect(
      deriveAnswerShareChannelView({
        binding: COMMITTED,
        channelLog: port(undefined),
      }).status,
    ).toEqual({ status: 'unavailable', reason: 'history-not-served' });
  });

  it('is unreachable when the log throws', () => {
    const status = deriveAnswerShareChannelView({
      binding: COMMITTED,
      channelLog: {
        resolveCommittedRecord: () => {
          throw new Error('log unavailable');
        },
      },
    }).status;
    expect(status).toEqual({
      status: 'unavailable',
      reason: 'history-not-served',
    });
  });

  it('is the SLICE-1 `authorized`-from-an-authorizationId-alone defect class, refused here', () => {
    // Slice 1's review found `authorized` rendered from the mere PRESENCE of
    // an `authorizationId` — a check reported without being run. "Committed
    // at (epoch, seq)" rendered from a stored coordinate is the same defect
    // with different nouns. The binding below carries a complete, valid,
    // internally consistent coordinate and anchor, and none of it reaches the
    // viewer as a status until a log corroborates it.
    const status = deriveAnswerShareChannelView({ binding: COMMITTED }).status;
    expect(status.status).not.toBe('reported');
    expect(JSON.stringify(status)).not.toContain(COORDINATE.channelId);
    expect(JSON.stringify(status)).not.toContain(String(COORDINATE.seq));
  });

  it('resolves BY IDENTITY — the ref is what the port is handed, never a position', () => {
    const handed: unknown[] = [];
    deriveAnswerShareChannelView({
      binding: COMMITTED,
      channelLog: {
        resolveCommittedRecord: (ref) => {
          handed.push(ref);
          return AGREEING;
        },
      },
    });
    expect(handed).toEqual([
      { refKind: 'committed-message', id: 'msg-9f2c1b7a' },
    ]);
    // And the ref carries none of the positional keys slice 1 refuses. This
    // is the assertion that would fail if the port were ever handed a
    // coordinate to resolve by.
    for (const positional of ['seq', 'sequence', 'epoch', 'index', 'offset']) {
      expect(
        Object.hasOwn(handed[0] as Record<string, unknown>, positional),
      ).toBe(false);
    }
  });

  it('reports what the LOG said, not what the record said', () => {
    // The coordinate on the status comes off the resolution. A record and a
    // log that agree are indistinguishable here by construction, which is why
    // the mismatch tests below carry the weight.
    const view = deriveAnswerShareChannelView({
      binding: COMMITTED,
      channelLog: port(AGREEING),
    });
    expect(view.status).toEqual({
      status: 'reported',
      coordinate: COORDINATE,
      supersession: 'current',
    });
    expect(view.corroborated).toBe(AGREEING);
  });

  it('carries supersession as STATUS', () => {
    const view = deriveAnswerShareChannelView({
      binding: COMMITTED,
      channelLog: port({ ...AGREEING, supersession: 'superseded' }),
    });
    expect(view.status).toMatchObject({
      status: 'reported',
      supersession: 'superseded',
    });
  });

  it('refuses a resolution whose supersession it cannot classify', () => {
    const view = deriveAnswerShareChannelView({
      binding: COMMITTED,
      channelLog: port({
        ...AGREEING,
        supersession: 'probably-current' as 'current',
      }),
    });
    expect(view.status).toEqual({
      status: 'unavailable',
      reason: 'history-not-served',
    });
    expect(view.corroborated).toBeUndefined();
  });
});

describe('AC4 — a disagreement is disclosed, never re-resolved by position', () => {
  it.each([
    ['seq', { ...AGREEING, coordinate: { ...COORDINATE, seq: 413 } }],
    ['epoch', { ...AGREEING, coordinate: { ...COORDINATE, epoch: 4 } }],
    [
      'channelId',
      { ...AGREEING, coordinate: { ...COORDINATE, channelId: 'chan-other' } },
    ],
    ['checkpointDigest', { ...AGREEING, checkpointDigest: 'anchor-digest-2' }],
  ])('a %s disagreement is coordinate-mismatch', (_field, resolution) => {
    const view = deriveAnswerShareChannelView({
      binding: COMMITTED,
      channelLog: port(resolution as AnswerShareChannelResolution),
    });
    expect(view.status).toEqual({
      status: 'unavailable',
      reason: 'coordinate-mismatch',
    });
    // And nothing from the unverified resolution becomes usable content.
    expect(view.corroborated).toBeUndefined();
  });

  it('checks the ANCHOR as well as the position — §8.1 asks for both', () => {
    // A coordinate alone is stable across a recovery that changed what lives
    // at it. Dropping the digest from the comparison would make every
    // post-recovery permalink read as agreement.
    const view = deriveAnswerShareChannelView({
      binding: COMMITTED,
      channelLog: port({
        ...AGREEING,
        checkpointDigest: 'anchor-after-recovery',
      }),
    });
    expect(view.status).toMatchObject({ reason: 'coordinate-mismatch' });
  });
});

describe('AC4 — digest arbitration decides the words', () => {
  const digest = (blocks: readonly AnswerShareTextBlock[]) =>
    JSON.stringify(blocks);
  const SHARED: AnswerShareTextBlock[] = [
    { type: 'text', text: 'The answer.' },
  ];
  const DRIFTED: AnswerShareTextBlock[] = [
    { type: 'text', text: 'A DIFFERENT answer.' },
  ];

  it('serves the session copy when it matches', () => {
    expect(
      arbitrateAnswerShareContent({
        recordedDigest: digest(SHARED),
        sessionBlocks: SHARED,
        digest,
      }),
    ).toEqual({ outcome: 'served', source: 'session', blocks: SHARED });
  });

  it('serves the channel copy when the session copy drifted', () => {
    expect(
      arbitrateAnswerShareContent({
        recordedDigest: digest(SHARED),
        sessionBlocks: DRIFTED,
        channelBlocks: SHARED,
        digest,
      }),
    ).toEqual({ outcome: 'served', source: 'channel', blocks: SHARED });
  });

  it('refuses when NEITHER store matches, rather than serving adjacent words', () => {
    expect(
      arbitrateAnswerShareContent({
        recordedDigest: digest(SHARED),
        sessionBlocks: DRIFTED,
        channelBlocks: DRIFTED,
        digest,
      }),
    ).toEqual({ outcome: 'unavailable' });
  });

  it('serves a legacy record with no recorded digest exactly as before', () => {
    // AC5. There is nothing to arbitrate against, and inventing an authority
    // retroactively is the backfill this design refuses.
    expect(
      arbitrateAnswerShareContent({
        recordedDigest: undefined,
        sessionBlocks: DRIFTED,
        digest,
      }),
    ).toEqual({ outcome: 'served', source: 'session', blocks: DRIFTED });
  });

  it('never lets a superseding edit displace the shared words', () => {
    // The superseding text cannot match a digest taken before the edit, so
    // the arbitration has no path to it. Supersession is disclosed as status
    // and nothing else.
    const EDITED: AnswerShareTextBlock[] = [
      { type: 'text', text: 'The answer, revised later.' },
    ];
    expect(
      arbitrateAnswerShareContent({
        recordedDigest: digest(SHARED),
        sessionBlocks: SHARED,
        channelBlocks: EDITED,
        digest,
      }),
    ).toEqual({ outcome: 'served', source: 'session', blocks: SHARED });
  });
});
