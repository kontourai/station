import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  isSupportedTurnProvenanceEnvelope,
  TURN_PROVENANCE_ENVELOPE_VERSION,
} from '@kontourai/station-contracts/turn-provenance';
import { describe, expect, it } from 'vitest';
import { assembleTurnProvenanceEnvelopes } from '../turn-provenance-fold.js';

const THREAD = 'thread-1';

function event(
  overrides: Partial<CanonicalRuntimeEvent> &
    Pick<CanonicalRuntimeEvent, 'method'>,
): CanonicalRuntimeEvent {
  return {
    eventId: `ev-${Math.random().toString(36).slice(2)}`,
    provider: 'claude',
    threadId: THREAD,
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as CanonicalRuntimeEvent;
}

function stationTurn(): CanonicalRuntimeEvent[] {
  return [
    event({
      eventId: 'ev-start',
      method: 'turn.started',
      turnId: 't1',
      prompt: 'super secret prompt about acme corp',
      metadata: { effectiveModel: 'claude-sonnet-9' },
    }),
    event({
      eventId: 'ev-tool-start',
      method: 'tool.started',
      turnId: 't1',
      itemId: 'i1',
      toolCallId: 'c1',
      toolName: 'read_file',
      arguments: { path: '/etc/passwd' },
    }),
    event({
      eventId: 'ev-tool-done',
      method: 'tool.completed',
      turnId: 't1',
      itemId: 'i1',
      toolCallId: 'c1',
      toolName: 'read_file',
      status: 'success',
      output: 'root:x:0:0:secret-contents',
    }),
    event({
      eventId: 'ev-usage',
      method: 'token-usage.updated',
      turnId: 't1',
      promptTokens: 120,
      completionTokens: 45,
    }),
    event({
      eventId: 'ev-done',
      method: 'turn.completed',
      turnId: 't1',
      outputText: 'the answer, verbatim',
      metadata: { reportedModel: 'claude-sonnet-9-20260701' },
    }),
  ];
}

describe('assembleTurnProvenanceEnvelopes', () => {
  it('assembles a versioned envelope per terminal turn, in terminal order', () => {
    const envelopes = assembleTurnProvenanceEnvelopes([
      ...stationTurn(),
      event({ method: 'turn.started', turnId: 't2' }),
      event({ method: 'turn.aborted', turnId: 't2', reason: 'user cancelled' }),
    ]);

    expect(envelopes.map((envelope) => envelope.turnId)).toEqual(['t1', 't2']);
    expect(envelopes[0].envelopeVersion).toBe(TURN_PROVENANCE_ENVELOPE_VERSION);
    expect(envelopes[0].sessionId).toBe(THREAD);
    expect(envelopes[0].outcome).toBe('completed');
    expect(envelopes[1].outcome).toBe('aborted');
  });

  it('reports a Station-engine turn truthfully from canonical events (AC1)', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes(stationTurn());

    expect(envelope.engine).toEqual({
      state: 'observed',
      value: { provider: 'claude' },
      observedFrom: [{ eventId: 'ev-done', method: 'turn.completed' }],
    });
    expect(envelope.requestedModel).toMatchObject({
      state: 'observed',
      value: 'claude-sonnet-9',
    });
    expect(envelope.reportedModel).toMatchObject({
      state: 'observed',
      value: 'claude-sonnet-9-20260701',
    });
    expect(envelope.tools).toMatchObject({
      state: 'observed',
      value: {
        uses: [
          {
            name: 'read_file',
            started: 1,
            succeeded: 1,
            failed: 0,
            cancelled: 0,
          },
        ],
        omittedNames: 0,
      },
    });
    expect(envelope.usage).toMatchObject({
      state: 'observed',
      value: { inputTokens: 120, outputTokens: 45 },
    });
  });

  it('reports an external-engine turn that emits only a terminal event as gaps, never zeroes (AC1, AC2)', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({
        eventId: 'ev-ext',
        provider: 'acp',
        method: 'turn.completed',
        turnId: 'ext-1',
      }),
    ]);

    expect(envelope.engine).toMatchObject({
      state: 'observed',
      value: { provider: 'acp' },
    });
    expect(envelope.requestedModel).toEqual({
      state: 'unavailable',
      reason: 'not-reported-by-engine',
    });
    expect(envelope.reportedModel).toEqual({
      state: 'unavailable',
      reason: 'not-reported-by-engine',
    });
    // The sharp one: no tool events observed must NOT become "0 tools".
    expect(envelope.tools).toEqual({
      state: 'unavailable',
      reason: 'not-reported-by-engine',
    });
    expect(envelope.usage).toEqual({
      state: 'unavailable',
      reason: 'not-reported-by-engine',
    });
    expect(JSON.stringify(envelope)).not.toContain('"totalTokens":0');
  });

  it('yields an observed requestedModel for a station-agent-shaped event stream, leaving reportedModel a named gap (station#1455)', () => {
    // station-agent-adapter.ts stamps `effectiveModel` (never
    // `reportedModel`, by deliberate refusal — see the adapter's own note
    // at station-agent-adapter.ts:526-547) on both `turn.started` and its
    // `turn.completed` terminal event.
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({
        eventId: 'ev-sa-start',
        provider: 'station-agent',
        method: 'turn.started',
        turnId: 'sa1',
        prompt: 'do the thing',
        metadata: {
          effectiveModel: 'sonnet',
          effectiveModelOptions: { effort: 'high' },
        },
      }),
      event({
        eventId: 'ev-sa-done',
        provider: 'station-agent',
        method: 'turn.completed',
        turnId: 'sa1',
        finishReason: 'stop',
        metadata: {
          effectiveModel: 'sonnet',
          effectiveModelOptions: { effort: 'high' },
        },
      }),
    ]);

    // Terminal event wins over turn.started per modelSlot's precedence
    // (station#1182) — both carry the same value here, so this also pins
    // that precedence without depending on them disagreeing.
    expect(envelope.requestedModel).toEqual({
      state: 'observed',
      value: 'sonnet',
      observedFrom: [{ eventId: 'ev-sa-done', method: 'turn.completed' }],
    });
    // The refusal note's reasoning stands: Station's own engine resolves
    // and executes the turn end-to-end, so there is no independently
    // observed runtime report to surface here.
    expect(envelope.reportedModel).toEqual({
      state: 'unavailable',
      reason: 'not-reported-by-engine',
    });
  });

  it('reports routing receipt, sources, and trust report as explicit gaps (AC2)', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes(stationTurn());

    expect(envelope.routingReceipt).toEqual({
      state: 'unavailable',
      reason: 'not-captured-by-station',
    });
    expect(envelope.sources).toEqual({
      state: 'unavailable',
      reason: 'not-captured-by-station',
    });
    expect(envelope.trustReport).toEqual({
      state: 'unavailable',
      reason: 'not-captured-by-station',
    });
  });

  // station#1558: this fixture stamps metadata NO Station producer writes, so
  // it proves the fold honours a stamp and proves nothing about reachability.
  // That distinction is enforced by
  // `turn-provenance-ref-slot-producers.test.ts`, which fails if the contract
  // ever claims this slot is live while the producer is still absent.
  it('references a trust report only when the turn event explicitly stamps one', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({
        eventId: 'ev-stamped',
        method: 'turn.completed',
        turnId: 't-stamped',
        metadata: {
          trustReport: { projectSlug: 'atlas', bundleId: 'veritas-readiness' },
        },
      }),
    ]);

    expect(envelope.trustReport).toEqual({
      state: 'referenced',
      ref: {
        kind: 'surface-trust-bundle',
        projectSlug: 'atlas',
        bundleId: 'veritas-readiness',
      },
      observedFrom: [{ eventId: 'ev-stamped', method: 'turn.completed' }],
    });
  });

  it('drops a half-stamped trust reference rather than completing it', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({
        method: 'turn.completed',
        turnId: 't-half',
        metadata: { trustReport: { projectSlug: 'atlas' } },
      }),
    ]);

    expect(envelope.trustReport).toEqual({
      state: 'unavailable',
      reason: 'not-captured-by-station',
    });
  });

  it('never attributes an untagged event to the only open turn (R2)', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({ method: 'turn.started', turnId: 'lonely' }),
      // Same session, same window, no turnId — an engine that does not
      // correlate its events must not have them silently attributed.
      event({
        method: 'tool.completed',
        itemId: 'i9',
        toolCallId: 'c9',
        toolName: 'shell',
        status: 'success',
      }),
      event({
        method: 'token-usage.updated',
        promptTokens: 999,
        completionTokens: 999,
      }),
      event({ method: 'turn.completed', turnId: 'lonely' }),
    ]);

    expect(envelope.tools.state).toBe('unavailable');
    expect(envelope.usage.state).toBe('unavailable');
  });

  it('never attributes another turn’s events across turn boundaries', () => {
    const envelopes = assembleTurnProvenanceEnvelopes([
      event({ method: 'turn.started', turnId: 'a' }),
      event({
        method: 'tool.started',
        turnId: 'a',
        itemId: 'ia',
        toolCallId: 'ca',
        toolName: 'grep',
      }),
      event({ method: 'turn.completed', turnId: 'a' }),
      event({ method: 'turn.started', turnId: 'b' }),
      event({ method: 'turn.completed', turnId: 'b' }),
    ]);

    const byTurn = new Map(envelopes.map((e) => [e.turnId, e]));
    expect(byTurn.get('a')?.tools.state).toBe('observed');
    expect(byTurn.get('b')?.tools.state).toBe('unavailable');
  });

  it('does not attribute a session-level configured model to a turn', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({
        method: 'session.configured',
        sessionId: THREAD,
        model: 'session-wide-model',
        metadata: { effectiveModel: 'session-wide-model' },
      }),
      event({ method: 'turn.started', turnId: 'no-model' }),
      event({ method: 'turn.completed', turnId: 'no-model' }),
    ]);

    expect(envelope.requestedModel).toEqual({
      state: 'unavailable',
      reason: 'not-reported-by-engine',
    });
  });

  it('omits an unfinished turn entirely rather than half-reporting it', () => {
    expect(
      assembleTurnProvenanceEnvelopes([
        event({ method: 'turn.started', turnId: 'open' }),
        event({
          method: 'tool.started',
          turnId: 'open',
          itemId: 'i',
          toolCallId: 'c',
          toolName: 'x',
        }),
      ]),
    ).toEqual([]);
  });

  it('records tool failures, cancellations and unresolved calls separately from successes', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({ method: 'turn.started', turnId: 't' }),
      ...(['success', 'error', 'cancelled', 'unresolved'] as const).map(
        (status, index) =>
          event({
            method: 'tool.completed',
            turnId: 't',
            itemId: `i${index}`,
            toolCallId: `c${index}`,
            toolName: 'bash',
            status,
          }),
      ),
      event({ method: 'turn.completed', turnId: 't' }),
    ]);

    expect(envelope.tools).toMatchObject({
      state: 'observed',
      value: {
        uses: [
          {
            name: 'bash',
            started: 0,
            succeeded: 1,
            failed: 1,
            cancelled: 1,
            // station#1558: its own counter. A reader asking "did any tool
            // fail this turn?" must not be told yes because one call's
            // session ended before it reported.
            unresolved: 1,
          },
        ],
      },
    });
  });

  it('caps named tools and discloses how many names were omitted', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({ method: 'turn.started', turnId: 't' }),
      ...Array.from({ length: 15 }, (_, index) =>
        event({
          method: 'tool.started',
          turnId: 't',
          itemId: `i${index}`,
          toolCallId: `c${index}`,
          toolName: `tool_${index}`,
        }),
      ),
      event({ method: 'turn.completed', turnId: 't' }),
    ]);

    expect(
      envelope.tools.state === 'observed' && envelope.tools.value.uses.length,
    ).toBe(12);
    expect(
      envelope.tools.state === 'observed' && envelope.tools.value.omittedNames,
    ).toBe(3);
  });

  it('refuses to present a session-cumulative reporter’s figures as one turn’s usage', () => {
    // Codex tags its running session-to-date total with the triggering turn.
    // Reading it as this turn's usage would over-report every later turn.
    const envelopes = assembleTurnProvenanceEnvelopes([
      event({ provider: 'codex', method: 'turn.started', turnId: 'c1' }),
      event({
        provider: 'codex',
        method: 'token-usage.updated',
        turnId: 'c1',
        promptTokens: 1000,
        completionTokens: 200,
        totalTokens: 1200,
      }),
      event({ provider: 'codex', method: 'turn.completed', turnId: 'c1' }),
      event({ provider: 'codex', method: 'turn.started', turnId: 'c2' }),
      event({
        provider: 'codex',
        method: 'token-usage.updated',
        turnId: 'c2',
        promptTokens: 1800,
        completionTokens: 350,
        totalTokens: 2150,
      }),
      event({ provider: 'codex', method: 'turn.completed', turnId: 'c2' }),
    ]);

    for (const envelope of envelopes) {
      expect(envelope.usage).toEqual({
        state: 'unavailable',
        reason: 'reported-only-at-session-scope',
      });
    }
    // The session's own running totals never leak in as a turn figure.
    expect(JSON.stringify(envelopes)).not.toContain('2150');
  });

  it('still reports a per-turn (delta) reporter’s usage', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({ provider: 'claude', method: 'turn.started', turnId: 'd1' }),
      event({
        provider: 'claude',
        method: 'token-usage.updated',
        turnId: 'd1',
        promptTokens: 10,
        completionTokens: 4,
      }),
      event({ provider: 'claude', method: 'turn.completed', turnId: 'd1' }),
    ]);

    expect(envelope.usage).toMatchObject({
      state: 'observed',
      value: { inputTokens: 10, outputTokens: 4 },
    });
  });

  // SF3 — an engine nobody has declared a usage scope for.
  it('refuses to read an undeclared engine’s usage as a per-answer figure', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({
        provider: 'brand-new-engine',
        method: 'turn.started',
        turnId: 'n1',
      }),
      event({
        provider: 'brand-new-engine',
        method: 'token-usage.updated',
        turnId: 'n1',
        promptTokens: 500,
        completionTokens: 100,
        totalTokens: 600,
      }),
      event({
        provider: 'brand-new-engine',
        method: 'turn.completed',
        turnId: 'n1',
      }),
    ]);

    expect(envelope.usage).toEqual({
      state: 'unavailable',
      reason: 'usage-scope-undeclared',
    });
    // The undeclared engine's numbers never reach the envelope.
    expect(JSON.stringify(envelope)).not.toContain('600');
  });

  it('bounds a slot’s audit pointers so one turn cannot bloat a transcript', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({ method: 'turn.started', turnId: 't' }),
      ...Array.from({ length: 40 }, (_, index) =>
        event({
          method: 'tool.completed',
          turnId: 't',
          itemId: `i${index}`,
          toolCallId: `c${index}`,
          toolName: 'bash',
          status: 'success',
        }),
      ),
      event({ method: 'turn.completed', turnId: 't' }),
    ]);

    expect(
      envelope.tools.state === 'observed' && envelope.tools.observedFrom.length,
    ).toBe(12);
    // SF2: the truncation is DISCLOSED. Without this, a reader sees 40
    // successes beside 12 pointers and reasonably concludes the count rests
    // on those 12.
    expect(
      envelope.tools.state === 'observed' && envelope.tools.omittedObservations,
    ).toBe(28);
    // The counts still reflect every observed event, not just the pointers.
    expect(
      envelope.tools.state === 'observed' &&
        envelope.tools.value.uses[0].succeeded,
    ).toBe(40);
  });

  it('does not claim omitted observations when nothing was dropped', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes(stationTurn());
    expect(
      envelope.tools.state === 'observed' && envelope.tools.omittedObservations,
    ).toBeUndefined();
  });

  // #1456 — the guard now requires a non-empty `observedFrom` on every
  // `observed` slot (a zero-pointer "observed" claim is vacuous). This
  // proves the fold structurally cannot produce that shape: `boundObservations`
  // only ever caps a pointer list DOWN to `TURN_PROVENANCE_MAX_OBSERVATIONS`
  // (12) — it never has a path to zero — so a slot that reaches `observed`
  // state always keeps at least one pointer, capped or not.
  it('never emits an observed slot with an empty observedFrom, even after the observation cap (#1456)', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({ method: 'turn.started', turnId: 't' }),
      ...Array.from({ length: 40 }, (_, index) =>
        event({
          method: 'tool.completed',
          turnId: 't',
          itemId: `i${index}`,
          toolCallId: `c${index}`,
          toolName: 'bash',
          status: 'success',
        }),
      ),
      event({
        method: 'token-usage.updated',
        turnId: 't',
        promptTokens: 10,
        completionTokens: 4,
      }),
      event({ method: 'turn.completed', turnId: 't' }),
    ]);

    // Sanity: this fixture actually exercises the cap (tools: 40 -> 12).
    expect(
      envelope.tools.state === 'observed' && envelope.tools.observedFrom.length,
    ).toBe(12);

    for (const slot of [
      envelope.engine,
      envelope.requestedModel,
      envelope.reportedModel,
      envelope.tools,
      envelope.usage,
    ]) {
      if (slot.state === 'observed') {
        expect(slot.observedFrom.length).toBeGreaterThan(0);
      }
    }

    // The fix in the contract's guard and the invariant in the fold agree:
    // an envelope the fold actually produces always passes the tightened
    // check.
    expect(isSupportedTurnProvenanceEnvelope(envelope)).toBe(true);
  });

  // station#1558: every envelope persisted before that change carries tool
  // uses with no `unresolved` count. The guard rejects the WHOLE envelope on
  // any malformed slot, so requiring the new field would have degraded every
  // historical turn's card to "cannot read this".
  it('still accepts a tool summary written before the unresolved count existed', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({ method: 'turn.started', turnId: 't' }),
      event({
        method: 'tool.completed',
        turnId: 't',
        itemId: 'i',
        toolCallId: 'c',
        toolName: 'bash',
        status: 'success',
      }),
      event({ method: 'turn.completed', turnId: 't' }),
    ]);
    const legacy = {
      ...envelope,
      tools:
        envelope.tools.state === 'observed'
          ? {
              ...envelope.tools,
              value: {
                ...envelope.tools.value,
                uses: envelope.tools.value.uses.map(
                  ({ unresolved: _dropped, ...use }) => use,
                ),
              },
            }
          : envelope.tools,
    };

    expect(
      (legacy.tools as { value: { uses: Array<Record<string, unknown>> } })
        .value.uses[0],
    ).not.toHaveProperty('unresolved');
    expect(isSupportedTurnProvenanceEnvelope(legacy)).toBe(true);
    // And a malformed one still rejects, exactly like the sibling counts.
    expect(
      isSupportedTurnProvenanceEnvelope({
        ...legacy,
        tools:
          legacy.tools.state === 'observed'
            ? {
                ...legacy.tools,
                value: {
                  ...legacy.tools.value,
                  uses: legacy.tools.value.uses.map((use) => ({
                    ...use,
                    unresolved: 'one',
                  })),
                },
              }
            : legacy.tools,
      }),
    ).toBe(false);
  });

  // N4 — cross-session contamination is impossible by construction.
  it('never lets one session’s events contribute to another session’s turn', () => {
    const foreign = (
      overrides: Parameters<typeof event>[0],
    ): CanonicalRuntimeEvent =>
      event({ ...overrides, threadId: 'other-thread' } as Parameters<
        typeof event
      >[0]);

    const envelopes = assembleTurnProvenanceEnvelopes([
      event({ method: 'turn.started', turnId: 'shared-id' }),
      // Same turn id, different session — a colliding id must not merge.
      foreign({
        method: 'tool.completed',
        turnId: 'shared-id',
        itemId: 'i1',
        toolCallId: 'c1',
        toolName: 'rm',
        status: 'error',
      }),
      event({ method: 'turn.completed', turnId: 'shared-id' }),
    ]);

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].sessionId).toBe(THREAD);
    expect(envelopes[0].tools).toEqual({
      state: 'unavailable',
      reason: 'not-reported-by-engine',
    });
  });

  it('treats a usage event carrying no numbers as no usage, not zero usage', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes([
      event({ method: 'turn.started', turnId: 't' }),
      event({ method: 'token-usage.updated', turnId: 't' }),
      event({ method: 'turn.completed', turnId: 't' }),
    ]);

    expect(envelope.usage).toEqual({
      state: 'unavailable',
      reason: 'not-reported-by-engine',
    });
  });

  it('keeps prompts, output, tool arguments, and tool results out of the envelope (AC3)', () => {
    const [envelope] = assembleTurnProvenanceEnvelopes(stationTurn());
    const serialized = JSON.stringify(envelope);

    for (const secret of [
      'super secret prompt about acme corp',
      'the answer, verbatim',
      '/etc/passwd',
      'root:x:0:0:secret-contents',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('is deterministic: identical input yields identical output', () => {
    const events = stationTurn();
    expect(assembleTurnProvenanceEnvelopes(events)).toEqual(
      assembleTurnProvenanceEnvelopes(events),
    );
  });

  describe('contextInjection slot (station#2649)', () => {
    const record = {
      knowledge: {
        chunkCount: 2,
        sources: ['guide.md', 'api.md'],
        omittedSources: 0,
        approxTokens: 180,
      },
      guidelines: { reinforce: 2, avoid: 1, approxTokens: 60 },
    };

    it('reads a stamped record off the terminal event into an observed slot', () => {
      const [envelope] = assembleTurnProvenanceEnvelopes([
        event({
          method: 'turn.started',
          turnId: 't',
          provider: 'station-agent',
        }),
        event({
          eventId: 'ev-terminal',
          method: 'turn.completed',
          turnId: 't',
          provider: 'station-agent',
          metadata: { contextInjection: record },
        }),
      ]);

      expect(envelope.contextInjection).toEqual({
        state: 'observed',
        value: record,
        observedFrom: [{ eventId: 'ev-terminal', method: 'turn.completed' }],
      });
      expect(isSupportedTurnProvenanceEnvelope(envelope)).toBe(true);
    });

    it('an observed-EMPTY record stays observed — "Station injected nothing" is an earned fact', () => {
      const [envelope] = assembleTurnProvenanceEnvelopes([
        event({
          method: 'turn.completed',
          turnId: 't',
          provider: 'station-agent',
          metadata: { contextInjection: {} },
        }),
      ]);
      expect(envelope.contextInjection).toMatchObject({
        state: 'observed',
        value: {},
      });
    });

    it('a station-agent turn WITHOUT a record is not-captured-by-station (pre-slice events)', () => {
      const [envelope] = assembleTurnProvenanceEnvelopes([
        event({
          method: 'turn.completed',
          turnId: 't',
          provider: 'station-agent',
        }),
      ]);
      expect(envelope.contextInjection).toEqual({
        state: 'unavailable',
        reason: 'not-captured-by-station',
      });
    });

    it('an external-engine turn NEVER yields an observed Station context claim without a stamped record', () => {
      // The honesty rule this slice exists to hold: Claude Code/Codex own
      // their context; Station injected nothing and observed nothing, so the
      // slot is a disclosed gap — the card derives its "managed by <engine>"
      // line from the engine slot, never from a fabricated observation here.
      const [envelope] = assembleTurnProvenanceEnvelopes([
        event({ method: 'turn.completed', turnId: 't', provider: 'claude' }),
      ]);
      expect(envelope.contextInjection).toEqual({
        state: 'unavailable',
        reason: 'not-reported-by-engine',
      });
    });

    it('refuses an external-engine turn even when the key IS stamped (structural guard, review fix)', () => {
      // Before the fix this was a property of the six external publishers
      // (none stamp the key), not of the fold. Now the fold itself refuses,
      // so a future publisher cannot mint a Station context claim.
      const [envelope] = assembleTurnProvenanceEnvelopes([
        event({
          method: 'turn.completed',
          turnId: 't',
          provider: 'claude',
          metadata: { contextInjection: record },
        }),
      ]);
      expect(envelope.contextInjection).toEqual({
        state: 'unavailable',
        reason: 'not-reported-by-engine',
      });
    });

    it('drops a malformed record WHOLE rather than reading the parts that look familiar', () => {
      const [envelope] = assembleTurnProvenanceEnvelopes([
        event({
          method: 'turn.completed',
          turnId: 't',
          provider: 'station-agent',
          metadata: {
            contextInjection: {
              knowledge: {
                chunkCount: 'three', // not a number — the whole record is unreadable
                sources: ['guide.md'],
                omittedSources: 0,
                approxTokens: 10,
              },
              guidelines: { reinforce: 1, avoid: 0, approxTokens: 5 },
            },
          },
        }),
      ]);
      expect(envelope.contextInjection).toEqual({
        state: 'unavailable',
        reason: 'not-captured-by-station',
      });
    });
  });
});
