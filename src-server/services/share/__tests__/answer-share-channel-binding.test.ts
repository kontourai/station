import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANSWER_SHARE_CHANNEL_SCHEMA_VERSION,
  ANSWER_SHARE_SCHEMA_VERSION,
  type AnswerShareChannelBinding,
} from '@kontourai/station-contracts/answer-share';
import { answerShareContentDigestInput } from '@kontourai/station-contracts/answer-share-channel';
import type {
  AnswerShareChannelLogPort,
  AnswerShareChannelResolution,
} from '@kontourai/station-shared/answer-share-projection';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerShareViews } from '../../../telemetry/metrics.js';
import {
  type AnswerShareChannelObserver,
  AnswerShareService,
  NO_CHANNEL_LOG_OBSERVER,
} from '../answer-share-service.js';
import { AnswerShareStore } from '../answer-share-store.js';

// The counters are the only surface on which digest drift is distinguishable
// from a turn that vanished — the HTTP response deliberately is not — so this
// file asserts against them directly. `vi.mock` is hoisted above the imports
// above, so the service reads these doubles.
vi.mock('../../../telemetry/metrics.js', () => ({
  answerShareChannelStatuses: { add: vi.fn() },
  answerSharesMinted: { add: vi.fn() },
  answerSharesRevoked: { add: vi.fn() },
  answerShareViews: { add: vi.fn() },
}));

/**
 * station#1598 — the recorded channel binding, end to end through the store
 * and the service.
 *
 * The persistence property is asserted against the BYTES ON DISK rather than
 * against the API's promises, for the same reason the #1423 store tests are:
 * the store's document validator is a strict allowlist RE-MAPPER, so a field
 * it does not name is dropped silently on every read AND on every write-back
 * (`#write` re-validates on the way out). A binding that survives a mint and
 * dies on the first revoke is the exact bug this file exists to make
 * impossible.
 */

const homes: string[] = [];
const COORDINATE = { channelId: 'chan-team-alpha', epoch: 3, seq: 412 };
const CHECKPOINT_DIGEST = 'anchor-digest-1';
const COMMITTED: AnswerShareChannelBinding = {
  binding: 'committed',
  ref: { refKind: 'committed-message', id: 'msg-9f2c1b7a' },
  coordinate: COORDINATE,
  checkpointDigest: CHECKPOINT_DIGEST,
};

function messages(text = 'The shared answer.'): ConversationMessage[] {
  return [
    {
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'text', text }],
      metadata: { turnId: 'turn-1' },
    },
  ];
}

function blocksOf(text: string) {
  return [{ type: 'text' as const, text }];
}

function digestOf(text: string): string {
  return createHash('sha256')
    .update(answerShareContentDigestInput(blocksOf(text)), 'utf8')
    .digest('hex');
}

interface Harness {
  homeDir: string;
  store: AnswerShareStore;
  service: AnswerShareService;
  readSessionMessages: ReturnType<typeof vi.fn>;
  raw: () => string;
  document: () => { shares: Record<string, unknown>[] };
  rewrite: (next: unknown) => void;
}

function harness(
  options: {
    channelObserver?: AnswerShareChannelObserver;
    channelLog?: AnswerShareChannelLogPort;
    readSessionMessages?: () => readonly ConversationMessage[];
  } = {},
): Harness {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-share-channel-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const file = join(homeDir, 'security', 'answer-shares.json');
  const store = new AnswerShareStore({ homeDir });
  const readSessionMessages = vi.fn(
    options.readSessionMessages ?? (() => messages()),
  );
  const raw = () => readFileSync(file, 'utf8');
  return {
    homeDir,
    store,
    readSessionMessages,
    raw,
    document: () => JSON.parse(raw()),
    // Writes the file the way a hand-edit or an older build would: the store's
    // own `#write` would re-validate and re-map, which is precisely the path
    // these tests need to bypass to simulate a record it never produced.
    rewrite: (next: unknown) => {
      writeFileSync(file, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    },
    service: new AnswerShareService({
      store,
      sessions: { readSessionMessages },
      channelObserver: options.channelObserver ?? NO_CHANNEL_LOG_OBSERVER,
      channelLog: options.channelLog,
    }),
  };
}

function serviceOver(
  h: Harness,
  options: {
    channelLog?: AnswerShareChannelLogPort;
    readSessionMessages?: () => readonly ConversationMessage[];
  } = {},
): AnswerShareService {
  return new AnswerShareService({
    store: new AnswerShareStore({ homeDir: h.homeDir }),
    sessions: {
      readSessionMessages: options.readSessionMessages ?? (() => messages()),
    },
    channelObserver: NO_CHANNEL_LOG_OBSERVER,
    channelLog: options.channelLog,
  });
}

async function mint(service: AnswerShareService) {
  const result = await service.mint({
    sessionId: 'thread-1',
    turnId: 'turn-1',
  });
  if ('error' in result) throw new Error('expected a mint');
  return result;
}

function port(
  resolution: AnswerShareChannelResolution | undefined,
): AnswerShareChannelLogPort {
  return { resolveCommittedRecord: () => resolution };
}

function ok(result: ReturnType<AnswerShareService['view']>) {
  if (result.state !== 'ok') {
    throw new Error(`expected an ok payload, got ${JSON.stringify(result)}`);
  }
  return result;
}

beforeEach(() => {
  vi.mocked(answerShareViews.add).mockClear();
});

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('AC2 — mint records the binding, and no read derives one', () => {
  it('records `none` with no observer wired, which is the fact on this build', async () => {
    // Station has no channel log, so no answer on it has a channel
    // coordinate. `none` is an observation, not a placeholder, and recording
    // it is what lets a viewer later distinguish it from "nobody looked".
    const h = harness();
    await mint(h.service);
    expect(h.document().shares[0].channel).toEqual({ binding: 'none' });
  });

  it('records whatever the observer observed, including a committed binding', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    await mint(h.service);
    expect(h.document().shares[0].channel).toEqual(COMMITTED);
  });

  it('asks the observer about the turn the operator actually pointed at', async () => {
    const observeBinding = vi.fn(() => COMMITTED);
    const h = harness({ channelObserver: { observeBinding } });
    await mint(h.service);
    expect(observeBinding).toHaveBeenCalledWith({
      sessionId: 'thread-1',
      turnId: 'turn-1',
    });
  });

  it('fails the mint rather than writing a record with no observation', async () => {
    // There is no stored state for "I could not tell": an absent binding
    // means "minted before bindings existed", which would be false about a
    // share minted today. The honest outcome is that the operator re-mints.
    const h = harness({
      channelObserver: {
        observeBinding: () => {
          throw new Error('channel log unreachable');
        },
      },
    });
    await expect(
      h.service.mint({ sessionId: 'thread-1', turnId: 'turn-1' }),
    ).rejects.toThrow('channel log unreachable');
    expect(h.service.list()).toHaveLength(0);
  });

  it('records a content digest over the SERVED blocks', async () => {
    const h = harness();
    await mint(h.service);
    expect(h.document().shares[0].contentDigest).toBe(
      digestOf('The shared answer.'),
    );
  });

  it('digests the TRUNCATED projection, so a long answer still verifies', async () => {
    const long = 'x'.repeat(20_050);
    const h = harness({ readSessionMessages: () => messages(long) });
    await mint(h.service);
    // 20_000 is ANSWER_SHARE_MAX_BLOCK_LENGTH: the recorded digest is over
    // what the viewer will be shown, not over the source part.
    expect(h.document().shares[0].contentDigest).toBe(
      digestOf('x'.repeat(20_000)),
    );
    expect(h.document().shares[0].contentDigest).not.toBe(digestOf(long));
  });

  it('never backfills a record that has none', async () => {
    const h = harness();
    const { token } = await mint(h.service);
    const document = h.document();
    document.shares[0].channel = undefined;
    document.shares[0].contentDigest = undefined;
    h.rewrite(document);

    const view = ok(serviceOver(h).view(token));
    expect(view.channel).toEqual({
      status: 'unavailable',
      reason: 'predates-channel-addressing',
    });
    // The read did not write a binding back into the record.
    expect(h.document().shares[0].channel).toBeUndefined();
  });
});

describe('trap 2 — a binding survives every write-back', () => {
  it('mint → revoke → re-read keeps the binding in the bytes on disk', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { share } = await mint(h.service);
    expect(h.document().shares[0].channel).toEqual(COMMITTED);

    await h.service.revoke(share.id);

    const afterRevoke = h.document().shares[0];
    expect(afterRevoke.channel).toEqual(COMMITTED);
    expect(afterRevoke.contentDigest).toBe(digestOf('The shared answer.'));
    expect(afterRevoke.revokedAt).toEqual(expect.any(String));

    // And a store constructed fresh over the same file accepts it.
    expect(new AnswerShareStore({ homeDir: h.homeDir }).list()).toHaveLength(1);
  });

  it('refuses a hand-edited binding rather than silently dropping it', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    await mint(h.service);
    const document = h.document();
    // A positional ref: the one refusal slice 1 owns and this store reuses.
    (document.shares[0].channel as Record<string, unknown>).ref = {
      refKind: 'committed-message',
      id: 'msg-9f2c1b7a',
      seq: 412,
    };
    h.rewrite(document);
    expect(() => new AnswerShareStore({ homeDir: h.homeDir })).toThrow(
      /channel is invalid/,
    );
  });
});

describe('AC3 — the served status is computed, never echoed', () => {
  it('a committed record with NO channel log served reports history-not-served', async () => {
    // Production today. `reported` is structurally unreachable, and the
    // record's own coordinate does not appear anywhere in the payload.
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const view = ok(h.service.view((await mint(h.service)).token));
    expect(view.channel).toEqual({
      status: 'unavailable',
      reason: 'history-not-served',
    });
    expect(JSON.stringify(view)).not.toContain(COORDINATE.channelId);
    expect(JSON.stringify(view)).not.toContain(CHECKPOINT_DIGEST);
  });

  it('reports only when a log corroborates the recorded coordinate and anchor', async () => {
    const h = harness({
      channelObserver: { observeBinding: () => COMMITTED },
      channelLog: port({
        coordinate: { ...COORDINATE },
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
      }),
    });
    const view = ok(h.service.view((await mint(h.service)).token));
    expect(view.channel).toEqual({
      status: 'reported',
      coordinate: COORDINATE,
      supersession: 'current',
    });
  });

  it('a `none` record reports not-in-channel, which is not the same claim', async () => {
    const h = harness();
    const view = ok(h.service.view((await mint(h.service)).token));
    expect(view.channel).toEqual({
      status: 'unavailable',
      reason: 'not-in-channel',
    });
  });
});

describe('AC4 — a corrupted coordinate discloses, and never serves adjacent content', () => {
  it('a corrupted stored seq becomes coordinate-mismatch and still serves the shared words', async () => {
    // The named fault injection. The log holds a DIFFERENT answer at the
    // coordinate the corrupted record now names; the mismatch must be
    // disclosed and that answer must never appear.
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);
    const document = h.document();
    (
      (document.shares[0].channel as Record<string, unknown>)
        .coordinate as Record<string, unknown>
    ).seq = 413;
    h.rewrite(document);

    const view = ok(
      serviceOver(h, {
        channelLog: port({
          coordinate: { ...COORDINATE },
          checkpointDigest: CHECKPOINT_DIGEST,
          supersession: 'current',
          blocks: blocksOf('THE NEIGHBOURING MESSAGE.'),
        }),
      }).view(token),
    );

    expect(view.channel).toEqual({
      status: 'unavailable',
      reason: 'coordinate-mismatch',
    });
    expect(view.answer.blocks).toEqual(blocksOf('The shared answer.'));
    expect(JSON.stringify(view)).not.toContain('NEIGHBOURING');
  });

  it('serves the channel copy when the session copy drifted and the channel matches', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);

    const view = ok(
      serviceOver(h, {
        readSessionMessages: () => messages('A DIFFERENT answer.'),
        channelLog: port({
          coordinate: { ...COORDINATE },
          checkpointDigest: CHECKPOINT_DIGEST,
          supersession: 'current',
          blocks: blocksOf('The shared answer.'),
        }),
      }).view(token),
    );
    expect(view.answer.blocks).toEqual(blocksOf('The shared answer.'));
    expect(JSON.stringify(view)).not.toContain('A DIFFERENT answer');
  });

  it('refuses with answer-no-longer-available when NEITHER store matches', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);

    const result = serviceOver(h, {
      readSessionMessages: () => messages('A DIFFERENT answer.'),
      channelLog: port({
        coordinate: { ...COORDINATE },
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
        blocks: blocksOf('ALSO NOT THE SHARED ANSWER.'),
      }),
    }).view(token);

    expect(result).toEqual({
      state: 'refused',
      reason: 'answer-no-longer-available',
    });
  });

  it('a superseded record still serves the words that were shared', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);

    const view = ok(
      serviceOver(h, {
        channelLog: port({
          coordinate: { ...COORDINATE },
          checkpointDigest: CHECKPOINT_DIGEST,
          supersession: 'superseded',
          blocks: blocksOf('The answer, revised later.'),
        }),
      }).view(token),
    );
    expect(view.channel).toMatchObject({ supersession: 'superseded' });
    expect(view.answer.blocks).toEqual(blocksOf('The shared answer.'));
    expect(JSON.stringify(view)).not.toContain('revised later');
  });
});

describe('AC5 + AC7 — payload versions', () => {
  it('a legacy record keeps schema version 1', async () => {
    const h = harness();
    const { token } = await mint(h.service);
    const document = h.document();
    document.shares[0].channel = undefined;
    document.shares[0].contentDigest = undefined;
    h.rewrite(document);

    const view = ok(serviceOver(h).view(token));
    expect(view.schemaVersion).toBe(ANSWER_SHARE_SCHEMA_VERSION);
    expect(view.answer.blocks).toEqual(blocksOf('The shared answer.'));
  });

  it('a `none` record keeps schema version 1', async () => {
    const h = harness();
    expect(
      ok(h.service.view((await mint(h.service)).token)).schemaVersion,
    ).toBe(ANSWER_SHARE_SCHEMA_VERSION);
  });

  it('a committed record declares schema version 2', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    expect(
      ok(h.service.view((await mint(h.service)).token)).schemaVersion,
    ).toBe(ANSWER_SHARE_CHANNEL_SCHEMA_VERSION);
  });
});

describe('enumeration posture is unchanged', () => {
  it('an unknown token still refuses identically, whatever bindings exist', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    await mint(h.service);
    expect(h.service.view('not-a-real-token-aaaaaaaaaaaaaaaa')).toEqual({
      state: 'refused',
      reason: 'share-not-found',
    });
  });
});

describe('digest drift is one refusal on the wire and two populations on the counter', () => {
  async function driftedView() {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);
    return serviceOver(h, {
      readSessionMessages: () => messages('A DIFFERENT answer.'),
    }).view(token);
  }

  async function vanishedView() {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);
    return serviceOver(h, { readSessionMessages: () => [] }).view(token);
  }

  function outcomes(): string[] {
    return vi
      .mocked(answerShareViews.add)
      .mock.calls.map((call) =>
        String((call[1] as { outcome: string }).outcome),
      );
  }

  it('the RESPONSE stays byte-identical to a turn that vanished', async () => {
    // The enumeration posture requires it: a share holder who can tell "the
    // words drifted" from "the message is gone" has learned something about a
    // Station they hold exactly one capability on.
    expect(JSON.stringify(await driftedView())).toBe(
      JSON.stringify(await vanishedView()),
    );
    expect(await driftedView()).toEqual({
      state: 'refused',
      reason: 'answer-no-longer-available',
    });
  });

  it('the METRIC separates them, because drift has a systemic cause', async () => {
    // Any change to the projection the mint-time digest covers — including
    // the message projection two layers upstream — invalidates every recorded
    // digest at once. Sharing an attribute with ordinary turn attrition is
    // what makes that total outage look like normal churn.
    vi.mocked(answerShareViews.add).mockClear();
    await driftedView();
    expect(outcomes()).toEqual(['content_digest_mismatch']);

    vi.mocked(answerShareViews.add).mockClear();
    await vanishedView();
    expect(outcomes()).toEqual(['answer_unavailable']);
  });
});

describe('`none` is an observation, and the service has no way to fake one', () => {
  it('NO_CHANNEL_LOG_OBSERVER makes the claim production relies on', () => {
    expect(
      NO_CHANNEL_LOG_OBSERVER.observeBinding({
        sessionId: 'thread-1',
        turnId: 'turn-1',
      }),
    ).toEqual({ binding: 'none' });
  });

  it('there is NO default observer: a service wired without one cannot mint at all', async () => {
    // The trip-wire. `{ binding: 'none' }` is defined as an affirmative
    // mint-time observation, so a `?? { binding: 'none' }` default inside the
    // service would be indistinguishable from "nobody wired an observer" —
    // and the day a channel log exists and one wiring site is missed, every
    // share minted afterwards records the affirmative claim "this answer is
    // not in a channel" about answers that are. Nothing would fail. This
    // test is what fails.
    const homeDir = mkdtempSync(join(tmpdir(), 'station-share-channel-'));
    homes.push(homeDir);
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const store = new AnswerShareStore({ homeDir });
    const unwired = new AnswerShareService({
      store,
      sessions: { readSessionMessages: () => messages() },
    } as unknown as ConstructorParameters<typeof AnswerShareService>[0]);

    await expect(
      unwired.mint({ sessionId: 'thread-1', turnId: 'turn-1' }),
    ).rejects.toThrow();
    // And nothing was written, so no record carries an unobserved claim.
    expect(store.list()).toHaveLength(0);
  });
});

describe('the store re-maps a stored binding rather than refusing what it does not recognise', () => {
  async function withStoredBinding(channel: Record<string, unknown>) {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token, share } = await mint(h.service);
    const document = h.document();
    document.shares[0].channel = channel;
    h.rewrite(document);
    return { h, token, shareId: share.id };
  }

  it('drops a field a newer Station added instead of refusing to BOOT', async () => {
    // `#read()` runs in the store constructor, which runs during route
    // configuration — so refusing an unrecognised key here does not refuse a
    // share, it stops Station from starting. An operator who rolls back one
    // release, or points an older build at the same `~/.station`, reaches
    // that with a field that only affects sharing.
    const { h, shareId } = await withStoredBinding({
      ...COMMITTED,
      coordinate: { ...COORDINATE, locatorHint: 'https://home.example.test' },
      locatorHint: 'https://home.example.test/chan-team-alpha',
      authoredBy: 'member-7f3c1d',
    });

    const reopened = new AnswerShareStore({ homeDir: h.homeDir });
    expect(reopened.list()).toHaveLength(1);

    // And the dropped keys do not ride back out through `#write`.
    await reopened.revoke(shareId);
    expect(h.document().shares[0].channel).toEqual(COMMITTED);
    expect(h.raw()).not.toContain('locatorHint');
    expect(h.raw()).not.toContain('authoredBy');
  });

  it('still throws on a bad TYPE on a recognised field', async () => {
    const { h } = await withStoredBinding({
      ...COMMITTED,
      coordinate: { ...COORDINATE, seq: 'four hundred and twelve' },
    });
    expect(() => new AnswerShareStore({ homeDir: h.homeDir })).toThrow(
      /channel is invalid/,
    );
  });

  it('still throws on a `none` binding carrying a coordinate', async () => {
    // A recognised key in the wrong place, not an unrecognised one. Dropping
    // it would turn a self-contradictory record into the affirmative claim
    // "this answer is in no channel" — the exact conflation this slice
    // exists to prevent.
    const { h } = await withStoredBinding({
      binding: 'none',
      coordinate: { ...COORDINATE },
    });
    expect(() => new AnswerShareStore({ homeDir: h.homeDir })).toThrow(
      /channel is invalid/,
    );
  });

  it('still throws on a prototype-affecting key', async () => {
    // Tampering, not a field from a newer build, so the forward-compatibility
    // argument does not cover it and the coded refusal stays.
    const { h } = await withStoredBinding(
      JSON.parse(
        `{"binding":"committed","ref":{"refKind":"committed-message","id":"msg-9f2c1b7a"},"coordinate":{"channelId":"chan-team-alpha","epoch":3,"seq":412},"checkpointDigest":"anchor-digest-1","__proto__":{"polluted":true}}`,
      ),
    );
    expect(() => new AnswerShareStore({ homeDir: h.homeDir })).toThrow(
      /prototype-affecting keys/,
    );
  });

  it('still throws on a positional ref, which slice 1 owns', async () => {
    const { h } = await withStoredBinding({
      ...COMMITTED,
      ref: { refKind: 'committed-message', id: 'msg-9f2c1b7a', seq: 412 },
    });
    expect(() => new AnswerShareStore({ homeDir: h.homeDir })).toThrow(
      /channel is invalid/,
    );
  });
});

describe('what the port hands back is gated and re-mapped before it ships', () => {
  it('a field the log added to its coordinate never reaches the share holder', async () => {
    const coordinateWithExtras = {
      ...COORDINATE,
      locatorHint: 'https://home.example.test/chan-team-alpha',
      authoredBy: 'member-7f3c1d',
    };
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);
    const view = ok(
      serviceOver(h, {
        channelLog: port({
          coordinate: coordinateWithExtras,
          checkpointDigest: CHECKPOINT_DIGEST,
          supersession: 'current',
        }),
      }).view(token),
    );
    expect(view.channel).toEqual({
      status: 'reported',
      coordinate: COORDINATE,
      supersession: 'current',
    });
    const payload = JSON.stringify(view);
    for (const leaked of [
      'locatorHint',
      'home.example.test',
      'authoredBy',
      'member-7f3c1d',
      CHECKPOINT_DIGEST,
    ]) {
      expect(payload, leaked).not.toContain(leaked);
    }
  });

  it('a log that serves a coordinate this build cannot read refuses instead of throwing', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);
    const service = serviceOver(h, {
      channelLog: port({
        checkpointDigest: CHECKPOINT_DIGEST,
        supersession: 'current',
      } as unknown as AnswerShareChannelResolution),
    });
    // A TypeError here escapes the service and the public view route, which
    // has no try/catch — a 500 on an unauthenticated endpoint where the
    // design says `history-not-served`.
    const view = ok(service.view(token));
    expect(view.channel).toEqual({
      status: 'unavailable',
      reason: 'history-not-served',
    });
  });

  it('clamps an unusable omitted-block count rather than rendering it', async () => {
    // The number participates in a decision the viewer renders as a sentence
    // ("N further blocks are not shown"), and it arrives from a port nothing
    // validates.
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);
    for (const omittedBlocks of [Number.NaN, -3, 2.5]) {
      const view = ok(
        serviceOver(h, {
          readSessionMessages: () => messages('A DIFFERENT answer.'),
          channelLog: port({
            coordinate: { ...COORDINATE },
            checkpointDigest: CHECKPOINT_DIGEST,
            supersession: 'current',
            blocks: blocksOf('The shared answer.'),
            omittedBlocks,
          }),
        }).view(token),
      );
      expect(view.answer.omittedBlocks, String(omittedBlocks)).toBe(0);
    }
  });

  it('reports a usable omitted-block count unchanged', async () => {
    const h = harness({ channelObserver: { observeBinding: () => COMMITTED } });
    const { token } = await mint(h.service);
    const view = ok(
      serviceOver(h, {
        readSessionMessages: () => messages('A DIFFERENT answer.'),
        channelLog: port({
          coordinate: { ...COORDINATE },
          checkpointDigest: CHECKPOINT_DIGEST,
          supersession: 'current',
          blocks: blocksOf('The shared answer.'),
          omittedBlocks: 7,
        }),
      }).view(token),
    );
    expect(view.answer.omittedBlocks).toBe(7);
  });
});
