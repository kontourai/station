import { describe, expect, it } from 'vitest';
import {
  CONTEXT_INJECTION_RESERVED_METADATA_KEY,
  RESERVED_ORCHESTRATION_METADATA_KEYS,
} from '../provider.js';
import { isSupportedTurnProvenanceEnvelope } from '../turn-provenance.js';
import {
  CONTEXT_INJECTION_METADATA_KEY,
  parseTurnProvenanceContextInjection,
  TURN_PROVENANCE_MAX_CONTEXT_SOURCES,
} from '../turn-provenance-context.js';

describe('parseTurnProvenanceContextInjection (station#2649)', () => {
  it('accepts an empty record — "Station injected nothing" is a valid observation', () => {
    expect(parseTurnProvenanceContextInjection({})).toEqual({});
  });

  it('parses every declared block and returns a NEW object with only declared fields', () => {
    const input = {
      knowledge: {
        chunkCount: 3,
        sources: ['a.md', 'b.md'],
        omittedSources: 1,
        approxTokens: 120,
        smuggled: 'extra',
      },
      projectRules: { approxTokens: 40 },
      guidelines: { reinforce: 2, avoid: 1, approxTokens: 60 },
      workflowSteering: { approxTokens: 15 },
      conversationFeedback: { flaggedMessages: 1, approxTokens: 30 },
      ambient: { approxTokens: 7 },
      unknownBlock: { anything: true },
    };
    const parsed = parseTurnProvenanceContextInjection(input);
    expect(parsed).toEqual({
      knowledge: {
        chunkCount: 3,
        sources: ['a.md', 'b.md'],
        omittedSources: 1,
        approxTokens: 120,
      },
      projectRules: { approxTokens: 40 },
      guidelines: { reinforce: 2, avoid: 1, approxTokens: 60 },
      workflowSteering: { approxTokens: 15 },
      conversationFeedback: { flaggedMessages: 1, approxTokens: 30 },
      ambient: { approxTokens: 7 },
    });
    // Undeclared keys never ride into a persisted envelope.
    expect(parsed).not.toHaveProperty('unknownBlock');
    expect(parsed?.knowledge).not.toHaveProperty('smuggled');
    // A new object, not the caller's reference.
    expect(parsed?.knowledge?.sources).not.toBe(input.knowledge.sources);
  });

  it('rejects a half-valid record WHOLE — a partial context claim is worse than an admitted gap', () => {
    const validGuidelines = { reinforce: 1, avoid: 0, approxTokens: 5 };
    for (const knowledge of [
      { chunkCount: -1, sources: [], omittedSources: 0, approxTokens: 1 },
      {
        chunkCount: Number.NaN,
        sources: [],
        omittedSources: 0,
        approxTokens: 1,
      },
      {
        chunkCount: 1,
        sources: ['ok.md', ''],
        omittedSources: 0,
        approxTokens: 1,
      },
      {
        chunkCount: 1,
        sources: 'not-an-array',
        omittedSources: 0,
        approxTokens: 1,
      },
      {
        chunkCount: 1,
        sources: Array.from(
          { length: TURN_PROVENANCE_MAX_CONTEXT_SOURCES + 1 },
          (_, index) => `s${index}.md`,
        ),
        omittedSources: 0,
        approxTokens: 1,
      },
      {
        chunkCount: 1,
        sources: ['x'.repeat(257)],
        omittedSources: 0,
        approxTokens: 1,
      },
    ]) {
      expect(
        parseTurnProvenanceContextInjection({
          knowledge,
          guidelines: validGuidelines,
        }),
      ).toBeUndefined();
    }
    expect(parseTurnProvenanceContextInjection(null)).toBeUndefined();
    expect(parseTurnProvenanceContextInjection('record')).toBeUndefined();
    expect(parseTurnProvenanceContextInjection([])).toBeUndefined();
  });

  it('is the same grammar the envelope validator applies to the optional slot', () => {
    const base = {
      envelopeVersion: 1,
      sessionId: 's',
      turnId: 't',
      outcome: 'completed',
      observedAt: '2026-08-14T00:00:00.000Z',
      engine: {
        state: 'observed',
        value: { provider: 'station-agent' },
        observedFrom: [{ eventId: 'e', method: 'turn.completed' }],
      },
      requestedModel: {
        state: 'unavailable',
        reason: 'not-reported-by-engine',
      },
      reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
      tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
      usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
      routingReceipt: {
        state: 'unavailable',
        reason: 'not-captured-by-station',
      },
      sources: { state: 'unavailable', reason: 'not-captured-by-station' },
      trustReport: { state: 'unavailable', reason: 'not-captured-by-station' },
    };
    // Absent: valid (pre-slice persisted sidecars stay readable).
    expect(isSupportedTurnProvenanceEnvelope(base)).toBe(true);
    // Present and well-formed: valid.
    expect(
      isSupportedTurnProvenanceEnvelope({
        ...base,
        contextInjection: {
          state: 'observed',
          value: { projectRules: { approxTokens: 12 } },
          observedFrom: [{ eventId: 'e', method: 'turn.completed' }],
        },
      }),
    ).toBe(true);
    expect(
      isSupportedTurnProvenanceEnvelope({
        ...base,
        contextInjection: {
          state: 'unavailable',
          reason: 'not-captured-by-station',
        },
      }),
    ).toBe(true);
    // Present but malformed: the whole envelope is unreadable — the
    // no-partial-decoding rule applies to new fields exactly as to old ones.
    expect(
      isSupportedTurnProvenanceEnvelope({
        ...base,
        contextInjection: {
          state: 'observed',
          value: { projectRules: { approxTokens: 'lots' } },
          observedFrom: [{ eventId: 'e', method: 'turn.completed' }],
        },
      }),
    ).toBe(false);
  });
});

describe('contextInjection is server-minted evidence (reserved metadata)', () => {
  it('the reserved key and the producer key are the SAME string, and the strip list carries it', () => {
    // provider.ts re-declares the literal to avoid an import cycle; this pin
    // is what makes that re-declaration safe.
    expect(CONTEXT_INJECTION_RESERVED_METADATA_KEY).toBe(
      CONTEXT_INJECTION_METADATA_KEY,
    );
    expect(RESERVED_ORCHESTRATION_METADATA_KEYS).toContain(
      CONTEXT_INJECTION_METADATA_KEY,
    );
  });
});
