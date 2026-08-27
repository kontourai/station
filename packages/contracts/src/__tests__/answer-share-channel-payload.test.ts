/**
 * station#1598 — the payload-level contract around the channel binding: what
 * a permalink may carry, and which payloads an old reader must refuse.
 */

import { describe, expect, test } from 'vitest';
import {
  ANSWER_SHARE_CHANNEL_REASON_ASSERTS_BINDING,
  ANSWER_SHARE_CHANNEL_SCHEMA_VERSION,
  ANSWER_SHARE_READABLE_SCHEMA_VERSIONS,
  ANSWER_SHARE_SCHEMA_VERSION,
  type AnswerShareChannelStatus,
  type AnswerShareChannelUnavailableReason,
  answerSharePermalink,
  answerShareSchemaVersionFor,
  isReadableAnswerShareSchemaVersion,
} from '../answer-share.js';
import { answerShareContentDigestInput } from '../answer-share-channel.js';

const COORDINATE = { channelId: 'chan-team-alpha', epoch: 3, seq: 412 };
const CHECKPOINT_DIGEST =
  '1f0a5f3d5a2b41c8b1d7e6c9f4a80b2e5d3c7a91b6e4f28d0c5a3b7e9d1f6c48';

describe('AC6 — the permalink is unchanged by a channel binding', () => {
  test('a bound and an unbound share produce byte-identical links', () => {
    // There is only one input that can vary — the token — so this is the
    // strongest form of the claim: the function has no channel-shaped
    // parameter to leak through, and the test would have to be rewritten
    // rather than merely updated for one to be added.
    expect(answerSharePermalink('https://station.example', 'tok-abc')).toBe(
      answerSharePermalink('https://station.example', 'tok-abc'),
    );
    expect(answerSharePermalink.length).toBe(2);
  });

  test('no coordinate, digest, or channel component appears in a permalink', () => {
    const link = answerSharePermalink('https://station.example/', 'tok-abc');
    expect(link).toBe('https://station.example/share#t=tok-abc');
    for (const forbidden of [
      COORDINATE.channelId,
      String(COORDINATE.epoch),
      String(COORDINATE.seq),
      CHECKPOINT_DIGEST,
      'epoch',
      'seq',
      'channel',
      'digest',
      'checkpoint',
    ]) {
      expect(link).not.toContain(forbidden);
    }
  });

  test('the checkpoint digest stays out of the URL on purpose', () => {
    // Three grounds, all recorded in the design: it would put private log
    // structure into a link before possession is proven; a digest pinned in
    // an immutable URL either rots or lies; and an integrity anchor belongs
    // in an evidence record rather than in a locator. The assertion is
    // structural — the permalink takes an origin and a token, and there is
    // nowhere for an anchor to go.
    const link = answerSharePermalink('https://station.example', 'tok-abc');
    expect(link.split('#')[1]).toBe('t=tok-abc');
  });
});

describe('AC7 — payload versioning', () => {
  const asserting: AnswerShareChannelStatus[] = [
    { status: 'reported', coordinate: COORDINATE, supersession: 'current' },
    { status: 'reported', coordinate: COORDINATE, supersession: 'superseded' },
    { status: 'unavailable', reason: 'history-not-served' },
    { status: 'unavailable', reason: 'coordinate-mismatch' },
  ];
  const silent: AnswerShareChannelStatus[] = [
    { status: 'unavailable', reason: 'not-in-channel' },
    { status: 'unavailable', reason: 'predates-channel-addressing' },
  ];

  test('a payload that asserts a binding declares version 2', () => {
    for (const status of asserting) {
      expect(answerShareSchemaVersionFor(status)).toBe(
        ANSWER_SHARE_CHANNEL_SCHEMA_VERSION,
      );
    }
  });

  test('a payload that asserts no binding keeps version 1', () => {
    // AC5. Dropping "there is no channel here" loses nothing, so a v1 reader
    // is not misled by it and a legacy share must not be pushed out of its
    // reach for a claim that was never made.
    for (const status of silent) {
      expect(answerShareSchemaVersionFor(status)).toBe(
        ANSWER_SHARE_SCHEMA_VERSION,
      );
    }
    expect(answerShareSchemaVersionFor(undefined)).toBe(
      ANSWER_SHARE_SCHEMA_VERSION,
    );
  });

  test('an unrecognised reason is treated as channel-bearing, including a prototype member', () => {
    for (const reason of ['invented-by-a-newer-station', 'constructor']) {
      expect(
        answerShareSchemaVersionFor({
          status: 'unavailable',
          reason: reason as AnswerShareChannelUnavailableReason,
        }),
      ).toBe(ANSWER_SHARE_CHANNEL_SCHEMA_VERSION);
    }
  });

  test('the reason table covers the closed set exactly', () => {
    expect(
      Object.keys(ANSWER_SHARE_CHANNEL_REASON_ASSERTS_BINDING).sort(),
    ).toEqual([
      'coordinate-mismatch',
      'history-not-served',
      'not-in-channel',
      'predates-channel-addressing',
    ]);
  });
});

describe('the readable version set is a SET, not a constant', () => {
  test('both minted versions are readable', () => {
    expect([...ANSWER_SHARE_READABLE_SCHEMA_VERSIONS]).toEqual([1, 2]);
    expect(isReadableAnswerShareSchemaVersion(1)).toBe(true);
    expect(isReadableAnswerShareSchemaVersion(2)).toBe(true);
  });

  test('an unknown version is still refused', () => {
    for (const version of [0, 3, -1, 1.5, '1', null, undefined, Number.NaN]) {
      expect(isReadableAnswerShareSchemaVersion(version)).toBe(false);
    }
  });

  test('the minted default is a member of the readable set', () => {
    // The two constants are different concepts and could drift; a build that
    // mints a version it cannot read would refuse its own payloads.
    expect(
      isReadableAnswerShareSchemaVersion(ANSWER_SHARE_SCHEMA_VERSION),
    ).toBe(true);
    expect(
      isReadableAnswerShareSchemaVersion(ANSWER_SHARE_CHANNEL_SCHEMA_VERSION),
    ).toBe(true);
  });
});

describe('the content digest input', () => {
  test('covers the served blocks in order, canonicalized', () => {
    const input = answerShareContentDigestInput([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
    expect(input).toBe(
      '[{"text":"one","type":"text"},{"text":"two","type":"text"}]',
    );
  });

  test('block order is part of the digest', () => {
    expect(
      answerShareContentDigestInput([
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ]),
    ).not.toBe(
      answerShareContentDigestInput([
        { type: 'text', text: 'two' },
        { type: 'text', text: 'one' },
      ]),
    );
  });

  test('a truncated block digests as what was served, not as the source', () => {
    // The whole reason the digest is taken over the projection: digesting the
    // source text would fail verification on every answer long enough to be
    // truncated.
    expect(
      answerShareContentDigestInput([{ type: 'text', text: 'ab' }]),
    ).not.toBe(answerShareContentDigestInput([{ type: 'text', text: 'abc' }]));
  });
});
