import type { TurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_SHARE_ENVELOPE_FIELDS,
  ANSWER_SHARE_MAX_BLOCK_LENGTH,
  ANSWER_SHARE_MAX_BLOCKS,
  ANSWER_SHARE_RESTRICTED_REASON,
  ANSWER_SHARE_VIEWER_AUTHORIZATION,
  projectAnswerBlocks,
  projectEnvelopeForShareViewer,
  resolveAnswerShareState,
} from '../answer-share-projection.js';

/**
 * The read-side policy of a scoped answer share (station#1423), tested where
 * it lives — pure, with no server — so both the honest-state ladder and the
 * re-applied authorization are provable and fault-injectable on their own.
 */

const observation = [{ eventId: 'e1', method: 'turn.completed' as const }];

function envelope(
  overrides: Partial<TurnProvenanceEnvelope> = {},
): TurnProvenanceEnvelope {
  return {
    envelopeVersion: 1,
    sessionId: 'thread-1',
    turnId: 'turn-1',
    outcome: 'completed',
    observedAt: '2026-08-01T00:00:00.000Z',
    engine: {
      state: 'observed',
      value: { provider: 'claude' },
      observedFrom: observation,
    },
    requestedModel: {
      state: 'observed',
      value: 'sonnet-x',
      observedFrom: observation,
    },
    reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
    tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
    usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
    routingReceipt: {
      state: 'referenced',
      ref: { kind: 'dispatch-routing-receipt', receiptId: 'receipt-9' },
      observedFrom: observation,
    },
    sources: {
      state: 'referenced',
      ref: { kind: 'forage-snapshot', snapshotId: 'snap-9' },
      observedFrom: observation,
    },
    trustReport: {
      state: 'referenced',
      ref: {
        kind: 'surface-trust-bundle',
        projectSlug: 'secret-client-project',
        bundleId: 'bundle-77',
      },
      observedFrom: observation,
    },
    // station#2649: an observed record naming project-internal source doc
    // filenames — exactly what an unauthenticated share holder must not see.
    contextInjection: {
      state: 'observed',
      value: {
        knowledge: {
          chunkCount: 2,
          sources: ['internal-runbook.md'],
          omittedSources: 0,
          approxTokens: 120,
        },
      },
      observedFrom: observation,
    },
    ...overrides,
  };
}

describe('projectEnvelopeForShareViewer', () => {
  it('replaces every reference a v1 share holder cannot dereference with a named restriction', () => {
    const projected = projectEnvelopeForShareViewer(
      envelope(),
      ANSWER_SHARE_VIEWER_AUTHORIZATION,
    );

    for (const slot of [
      projected.routingReceipt,
      projected.sources,
      projected.trustReport,
    ]) {
      expect(slot).toEqual({
        state: 'unavailable',
        reason: ANSWER_SHARE_RESTRICTED_REASON,
      });
    }
  });

  it('leaks no reference identifier into the projected envelope', () => {
    const serialized = JSON.stringify(
      projectEnvelopeForShareViewer(
        envelope(),
        ANSWER_SHARE_VIEWER_AUTHORIZATION,
      ),
    );
    // The project slug is the sharp one: it names an unrelated project of the
    // operator's to a viewer with no standing on it. `internal-runbook.md`
    // (station#2649) is the same class: a knowledge-source filename from a
    // project the token holder has no standing on.
    for (const forbidden of [
      'secret-client-project',
      'bundle-77',
      'receipt-9',
      'snap-9',
      'internal-runbook.md',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('restricts an OBSERVED context-injection record but keeps an unavailable one as its own truth (station#2649)', () => {
    const projected = projectEnvelopeForShareViewer(
      envelope(),
      ANSWER_SHARE_VIEWER_AUTHORIZATION,
    );
    // The record exists and this share may not open it — the honest reason,
    // where dropping the field would render "not captured by Station" (false).
    expect(projected.contextInjection).toEqual({
      state: 'unavailable',
      reason: ANSWER_SHARE_RESTRICTED_REASON,
    });

    const externalTurn = projectEnvelopeForShareViewer(
      envelope({
        contextInjection: {
          state: 'unavailable',
          reason: 'not-reported-by-engine',
        },
      }),
      ANSWER_SHARE_VIEWER_AUTHORIZATION,
    );
    // A record that never existed must not gain a fabricated restriction.
    expect(externalTurn.contextInjection).toEqual({
      state: 'unavailable',
      reason: 'not-reported-by-engine',
    });

    const preSliceEnvelope = envelope();
    delete (preSliceEnvelope as unknown as Record<string, unknown>)
      .contextInjection;
    const preSlice = projectEnvelopeForShareViewer(
      preSliceEnvelope,
      ANSWER_SHARE_VIEWER_AUTHORIZATION,
    );
    expect('contextInjection' in preSlice).toBe(false);
  });

  it('passes through observed value slots untouched — they are what a share is for', () => {
    const projected = projectEnvelopeForShareViewer(
      envelope(),
      ANSWER_SHARE_VIEWER_AUTHORIZATION,
    );
    expect(projected.engine).toEqual(envelope().engine);
    expect(projected.requestedModel).toEqual(envelope().requestedModel);
    expect(projected.usage).toEqual(envelope().usage);
    expect(projected.turnId).toBe('turn-1');
  });

  it('honours an authorization that DOES permit a dereference (the v2 seam)', () => {
    const projected = projectEnvelopeForShareViewer(envelope(), {
      ...ANSWER_SHARE_VIEWER_AUTHORIZATION,
      trustReport: true,
    });
    expect(projected.trustReport.state).toBe('referenced');
    // The other two are still restricted — the record is consulted per ref,
    // not collapsed into one boolean.
    expect(projected.routingReceipt.state).toBe('unavailable');
    expect(projected.sources.state).toBe('unavailable');
  });

  it("keeps an already-unavailable slot's own reason rather than overwriting it with a restriction", () => {
    const projected = projectEnvelopeForShareViewer(
      envelope({
        trustReport: {
          state: 'unavailable',
          reason: 'not-captured-by-station',
        },
      }),
      ANSWER_SHARE_VIEWER_AUTHORIZATION,
    );
    // "This engine never reported it" is a more specific truth than "you may
    // not see it", and it discloses nothing.
    expect(projected.trustReport).toEqual({
      state: 'unavailable',
      reason: 'not-captured-by-station',
    });
  });

  it('does not mutate the operator-side envelope it was given', () => {
    const original = envelope();
    projectEnvelopeForShareViewer(original, ANSWER_SHARE_VIEWER_AUTHORIZATION);
    expect(original.trustReport.state).toBe('referenced');
  });
});

/**
 * The seam is DENY-BY-DEFAULT (station#1598, closing station#1423's recorded
 * allow-by-spread residual). What follows proves the claim in both of the
 * directions it can be broken, because the previous shape — a spread — was
 * only ever wrong about fields nobody had written yet, which is exactly the
 * class no test of today's fields can reach.
 *
 * The compile-time half is not tested here and cannot be: a required field
 * added to `TurnProvenanceEnvelope` makes the enumerated object literal stop
 * satisfying the declared return type, so the failure is `npm run typecheck`,
 * not a red assertion. The runtime half — an unknown key riding on a value
 * the type does not describe — is what these cover.
 */
describe('the share-viewer envelope projection is a closed allow-list', () => {
  it('forwards exactly the fields it names, and no others', () => {
    const projected = projectEnvelopeForShareViewer(
      envelope(),
      ANSWER_SHARE_VIEWER_AUTHORIZATION,
    );

    expect(Object.keys(projected).sort()).toEqual(
      [...ANSWER_SHARE_ENVELOPE_FIELDS].sort(),
    );
  });

  it('names every field the envelope type declares, so the list cannot silently under-cover it', () => {
    // The other direction of the same claim: the allow-list is asserted
    // against a fully-populated envelope built by this file's own factory,
    // so a field added to `TurnProvenanceEnvelope` and to that factory —
    // the ordinary way a slice grows the envelope — reds here if it was not
    // also considered at the disclosure seam.
    expect(Object.keys(envelope()).sort()).toEqual(
      [...ANSWER_SHARE_ENVELOPE_FIELDS].sort(),
    );
  });

  it('DROPS a field the type does not describe rather than shipping it to a token holder', () => {
    // The scenario the spread could not survive: an envelope that carries
    // more at runtime than the interface declares. TypeScript's
    // excess-property check fires on object literals, not on a value
    // assigned to a variable and then passed, so nothing upstream stops
    // this shape from reaching the seam — and under `...envelope` the extra
    // key was forwarded verbatim to an unauthenticated reader.
    const carrier: TurnProvenanceEnvelope & Record<string, unknown> = {
      ...envelope(),
      operatorApiToken: 'sk-do-not-share',
      internalNotes: { costCenter: 'acme-77' },
    };

    const projected = projectEnvelopeForShareViewer(
      carrier,
      ANSWER_SHARE_VIEWER_AUTHORIZATION,
    );

    expect(projected).not.toHaveProperty('operatorApiToken');
    expect(projected).not.toHaveProperty('internalNotes');
    expect(JSON.stringify(projected)).not.toContain('sk-do-not-share');
    // Still a complete, useful projection — dropping the unknown key must not
    // be achieved by dropping everything.
    expect(projected.sessionId).toBe('thread-1');
    expect(projected.engine).toEqual(carrier.engine);
  });
});

describe('resolveAnswerShareState', () => {
  const now = Date.parse('2026-08-01T12:00:00.000Z');

  it('reports a live share as active', () => {
    expect(
      resolveAnswerShareState(
        { revokedAt: null, expiresAt: '2026-08-08T12:00:00.000Z' },
        now,
      ),
    ).toBe('active');
  });

  it('reports a lapsed share as expired without needing a sweeper', () => {
    expect(
      resolveAnswerShareState(
        { revokedAt: null, expiresAt: '2026-07-31T12:00:00.000Z' },
        now,
      ),
    ).toBe('expired');
  });

  it('reports revocation even when the share had also lapsed', () => {
    // The operator turned it off; telling them it merely expired would credit
    // the clock with their decision.
    expect(
      resolveAnswerShareState(
        {
          revokedAt: '2026-07-30T12:00:00.000Z',
          expiresAt: '2026-07-31T12:00:00.000Z',
        },
        now,
      ),
    ).toBe('revoked');
  });

  it.each(['', 'not-a-date', 'null'])(
    'fails closed to expired for the unparseable expiry %j',
    (expiresAt) => {
      expect(resolveAnswerShareState({ revokedAt: null, expiresAt }, now)).toBe(
        'expired',
      );
    },
  );

  it('treats the exact expiry instant as expired, not as a final free read', () => {
    expect(
      resolveAnswerShareState(
        { revokedAt: null, expiresAt: new Date(now).toISOString() },
        now,
      ),
    ).toBe('expired');
  });
});

describe('projectAnswerBlocks', () => {
  it('carries only text parts — tool arguments and results never reach a share', () => {
    const { blocks } = projectAnswerBlocks([
      { type: 'text', text: 'The answer.' },
      {
        type: 'tool-call',
        toolName: 'shell',
        args: { command: 'cat ~/.aws/credentials' },
        result: 'AKIA-SECRET',
      },
      { type: 'file', url: 'https://example.test/private.pdf' },
    ]);
    expect(blocks).toEqual([{ type: 'text', text: 'The answer.' }]);
    expect(JSON.stringify(blocks)).not.toContain('AKIA-SECRET');
    expect(JSON.stringify(blocks)).not.toContain('private.pdf');
  });

  it('drops empty text parts rather than rendering blank paragraphs', () => {
    const { blocks, omitted } = projectAnswerBlocks([
      { type: 'text', text: '' },
      { type: 'text', text: 'Kept.' },
    ]);
    expect(blocks).toEqual([{ type: 'text', text: 'Kept.' }]);
    expect(omitted).toBe(0);
  });

  it('discloses how many blocks the bound dropped instead of just stopping', () => {
    const parts = Array.from({ length: ANSWER_SHARE_MAX_BLOCKS + 3 }, () => ({
      type: 'text',
      text: 'x',
    }));
    const { blocks, omitted } = projectAnswerBlocks(parts);
    expect(blocks).toHaveLength(ANSWER_SHARE_MAX_BLOCKS);
    expect(omitted).toBe(3);
  });

  it('truncates an oversized block to the declared ceiling', () => {
    const { blocks } = projectAnswerBlocks([
      { type: 'text', text: 'y'.repeat(ANSWER_SHARE_MAX_BLOCK_LENGTH + 500) },
    ]);
    expect(blocks[0]?.text).toHaveLength(ANSWER_SHARE_MAX_BLOCK_LENGTH);
  });
});
