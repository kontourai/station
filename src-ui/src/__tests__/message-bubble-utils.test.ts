import { describe, expect, test } from 'vitest';
import {
  resolveTurnEngine,
  resolveTurnModelIdentity,
} from '../components/chat/message-bubble/utils';
import { modelIdentityLabel } from '../utils/modelCapabilities';

/**
 * #1536 B5: this file used to pin `getModelDisplayName`, a private table of
 * five Claude 3 ids that answered "Custom" for everything else — so a row
 * running claude-opus-5 named it "Custom" while Home named the same session
 * "Opus 5". The table is gone; these assert the shared rule reaches the cases
 * the table used to own.
 */
describe('the model a bubble names comes from the shared identity rule', () => {
  test('a modern model gets its own name, not "Custom"', () => {
    expect(modelIdentityLabel('claude-opus-5')).toBe('Opus 5');
    expect(modelIdentityLabel('claude-opus-5[1m]')).toBe('Opus 5 (1M)');
  });

  test('an engine default is "Default", not the catalog\'s option copy', () => {
    expect(
      modelIdentityLabel('default', [
        {
          id: 'default',
          name: 'Default (recommended)',
          capabilities: {},
        } as never,
      ]),
    ).toBe('Default');
  });
});

const gap = { state: 'unavailable', reason: 'not-reported-by-engine' } as const;
const stationGap = {
  state: 'unavailable',
  reason: 'not-captured-by-station',
} as const;

function observed<T>(value: T) {
  return {
    state: 'observed' as const,
    value,
    observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    envelopeVersion: 1,
    sessionId: 'thread-1',
    turnId: 'turn-1',
    outcome: 'completed',
    observedAt: '2026-08-01T00:00:00.000Z',
    engine: observed({ provider: 'claude' }),
    requestedModel: gap,
    reportedModel: gap,
    tools: gap,
    usage: gap,
    routingReceipt: stationGap,
    sources: stationGap,
    trustReport: stationGap,
    ...overrides,
  };
}

describe('resolveTurnEngine (station#1424 review fix M1, wired to its authority in station#1434)', () => {
  test("never resolves an engine from a turn's stored model — no evidence-grounded model-id -> engine mapping exists in this codebase today, so every case is an honest gap", () => {
    expect(resolveTurnEngine({ model: 'claude-3-7-sonnet-latest' })).toBeNull();
    expect(resolveTurnEngine({ model: 'gpt-5.4' })).toBeNull();
    expect(resolveTurnEngine({})).toBeNull();
    expect(resolveTurnEngine({ model: undefined })).toBeNull();
  });

  test("reads the turn's own provenance envelope, in the card's vocabulary", () => {
    expect(resolveTurnEngine({ provenance: envelope() })).toEqual({
      name: 'Claude Code',
    });
    expect(
      resolveTurnEngine({
        provenance: envelope({ engine: observed({ provider: 'codex' }) }),
      }),
    ).toEqual({ name: 'Codex' });
  });

  test("names Station's own engine 'Station' for every adapter that executes it", () => {
    // `station-agent` relays to Station's own /chat; `bedrock`/`ollama` are
    // Model connections Station's engine runs through. All three are the
    // engine `agentEngineDescriptor` already calls "Station".
    for (const provider of ['station-agent', 'bedrock', 'ollama']) {
      expect(
        resolveTurnEngine({
          provenance: envelope({ engine: observed({ provider }) }),
        }),
      ).toEqual({ name: 'Station' });
    }
  });

  test('falls back to the raw provider slug the envelope observed, never an invented label', () => {
    expect(
      resolveTurnEngine({
        provenance: envelope({
          engine: observed({ provider: 'some-new-engine' }),
        }),
      }),
    ).toEqual({ name: 'some-new-engine' });
  });

  test('is honestly absent when the envelope itself reports no engine', () => {
    expect(
      resolveTurnEngine({ provenance: envelope({ engine: gap }) }),
    ).toBeNull();
  });

  test('degrades to absence — never a partial claim — for an envelope this build cannot read', () => {
    // Each of these carries a plausible-looking engine field that must not
    // be read: a newer version, a truncated payload, a hand-edited record,
    // and outright junk.
    expect(
      resolveTurnEngine({
        provenance: { ...envelope(), envelopeVersion: 9999 },
      }),
    ).toBeNull();
    expect(
      resolveTurnEngine({
        provenance: {
          envelopeVersion: 1,
          engine: observed({ provider: 'claude' }),
        },
      }),
    ).toBeNull();
    expect(
      resolveTurnEngine({ provenance: { engine: { state: 'observed' } } }),
    ).toBeNull();
    expect(resolveTurnEngine({ provenance: 'claude' })).toBeNull();
    expect(resolveTurnEngine({ provenance: null })).toBeNull();
  });

  test('degrades to absence for an observed engine slot with zero observation pointers (station#1456, vacuous observation)', () => {
    expect(
      resolveTurnEngine({
        provenance: envelope({
          engine: {
            state: 'observed',
            value: { provider: 'claude' },
            observedFrom: [],
          },
        }),
      }),
    ).toBeNull();
  });
});

describe('resolveTurnModelIdentity (station#1410 review finding SF5, closed in station#1434)', () => {
  test('a row with no readable envelope keeps the pre-#1434 badge path', () => {
    expect(resolveTurnModelIdentity({ model: 'claude-3-opus' })).toEqual({
      source: 'metadata-absent',
    });
    expect(
      resolveTurnModelIdentity({ provenance: { envelopeVersion: 9999 } }),
    ).toEqual({ source: 'metadata-absent' });
  });

  test('keeps the pre-#1434 badge path for an observed model slot with zero observation pointers (station#1456, vacuous observation)', () => {
    expect(
      resolveTurnModelIdentity({
        provenance: envelope({
          requestedModel: {
            state: 'observed',
            value: 'sonnet-9-20260701',
            observedFrom: [],
          },
        }),
      }),
    ).toEqual({ source: 'metadata-absent' });
  });

  test('states requested and reported separately when they disagree', () => {
    expect(
      resolveTurnModelIdentity({
        provenance: envelope({
          requestedModel: observed('sonnet-latest'),
          reportedModel: observed('sonnet-9-20260701'),
        }),
      }),
    ).toEqual({
      source: 'envelope',
      claims: [
        {
          slot: 'requested',
          label: 'Requested',
          value: 'Sonnet Latest',
          description: 'Model requested (sonnet-latest)',
        },
        {
          slot: 'reported',
          label: 'Reported',
          value: 'Sonnet 9 20260701',
          description: 'Model reported by engine (sonnet-9-20260701)',
        },
      ],
    });
  });

  test('cleans prior terminal styling from displayed model claims without changing their slots', () => {
    expect(
      resolveTurnModelIdentity({
        provenance: envelope({
          requestedModel: observed('claude-fable-5[1m]'),
          reportedModel: observed('claude-fable-5'),
        }),
      }),
    ).toEqual({
      source: 'envelope',
      claims: [
        {
          slot: 'agreed',
          label: 'Model',
          value: 'Fable 5',
          description:
            'Station requested this model and the engine reported it (claude-fable-5)',
        },
      ],
    });
  });

  test('states one claim when the engine reported back what Station requested', () => {
    expect(
      resolveTurnModelIdentity({
        provenance: envelope({
          requestedModel: observed('sonnet-9-20260701'),
          reportedModel: observed('sonnet-9-20260701'),
        }),
      }),
    ).toEqual({
      source: 'envelope',
      claims: [
        {
          slot: 'agreed',
          label: 'Model',
          value: 'Sonnet 9 20260701',
          description:
            'Station requested this model and the engine reported it (sonnet-9-20260701)',
        },
      ],
    });
  });

  test('states only the slot the envelope actually observed', () => {
    expect(
      resolveTurnModelIdentity({
        provenance: envelope({ reportedModel: observed('sonnet-9-20260701') }),
      }),
    ).toEqual({
      source: 'envelope',
      claims: [
        {
          slot: 'reported',
          label: 'Reported',
          value: 'Sonnet 9 20260701',
          description: 'Model reported by engine (sonnet-9-20260701)',
        },
      ],
    });
  });

  // archive#1455: the station-agent adapter now stamps `effectiveModel`
  // (surfaced here as `requestedModel`) on its turn events but deliberately
  // never a `reportedModel` (station-agent-adapter.ts:526-547) — this is
  // the requested-only shape that adapter's turns actually produce, distinct
  // from the reported-only case above.
  test('renders "Requested <model>" for a requested-only envelope (station-agent shape, station#1455)', () => {
    expect(
      resolveTurnModelIdentity({
        provenance: envelope({ requestedModel: observed('sonnet') }),
      }),
    ).toEqual({
      source: 'envelope',
      claims: [
        {
          slot: 'requested',
          label: 'Requested',
          value: 'Sonnet',
          description: 'Model requested (sonnet)',
        },
      ],
    });
  });

  test('claims no model when the envelope observed none, even though the chat store holds one — the card is reporting that same slot as a gap on the same row', () => {
    expect(
      resolveTurnModelIdentity({
        model: 'claude-3-7-sonnet-latest',
        provenance: envelope(),
      }),
    ).toEqual({ source: 'envelope', claims: [] });
  });
});
