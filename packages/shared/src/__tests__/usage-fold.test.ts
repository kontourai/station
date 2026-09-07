import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, it } from 'vitest';
import {
  cacheInclusivePromptTokens,
  cacheInclusiveTotalTokens,
  foldUsageEvents,
  providerPromptCacheInclusivity,
  providerUsageScope,
} from '../usage-fold.js';

const base = {
  threadId: 't1',
  createdAt: '2026-07-29T00:00:00.000Z',
};
let n = 0;
const ev = (
  e: Partial<CanonicalRuntimeEvent> & { method: string; provider: string },
): CanonicalRuntimeEvent =>
  ({ eventId: `e${n++}`, ...base, ...e }) as unknown as CanonicalRuntimeEvent;

describe('foldUsageEvents', () => {
  it('reports nothing measured for an empty log — not zeros (station#3201)', () => {
    // The counts Station takes itself are zero because it counted zero
    // events; every PROVIDER measurement is absent because no provider ever
    // reported one. This assertion used to read `inputTokens: 0`, which is
    // the fabrication #3201 traced from here to a `$0.0000` on screen.
    expect(foldUsageEvents([])).toEqual({
      turns: 0,
      toolCalls: 0,
    });
  });

  it('sums per-turn token-usage.updated events across multiple turns (Claude Code semantics)', () => {
    const aggregate = foldUsageEvents([
      ev({
        method: 'token-usage.updated',
        provider: 'claude',
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
      }),
      ev({ method: 'turn.completed', provider: 'claude', turnId: 'r1' }),
      ev({
        method: 'token-usage.updated',
        provider: 'claude',
        promptTokens: 150,
        completionTokens: 60,
        totalTokens: 210,
      }),
      ev({ method: 'turn.completed', provider: 'claude', turnId: 'r2' }),
    ]);

    expect(aggregate).toMatchObject({
      inputTokens: 250,
      outputTokens: 100,
      totalTokens: 350,
      turns: 2,
    });
  });

  it('treats Codex token-usage.updated events as a cumulative running total, not a per-turn delta', () => {
    const aggregate = foldUsageEvents([
      ev({
        method: 'token-usage.updated',
        provider: 'codex',
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 2,
      }),
      ev({ method: 'turn.completed', provider: 'codex', turnId: 'turn-1' }),
      // A second turn restates the WHOLE thread's usage-to-date (per the
      // real `thread/tokenUsage/updated` `.total` field), not just this
      // turn's own contribution — summing these would be wrong.
      ev({
        method: 'token-usage.updated',
        provider: 'codex',
        promptTokens: 22,
        completionTokens: 13,
        totalTokens: 35,
        cacheReadTokens: 4,
      }),
      ev({ method: 'turn.completed', provider: 'codex', turnId: 'turn-2' }),
    ]);

    expect(aggregate).toMatchObject({
      inputTokens: 22,
      outputTokens: 13,
      totalTokens: 35,
      cacheReadTokens: 4,
      turns: 2,
    });
  });

  it('counts toolCalls from tool.completed regardless of status', () => {
    const aggregate = foldUsageEvents([
      ev({
        method: 'tool.completed',
        provider: 'acp',
        toolCallId: 'c1',
        toolName: 'ls',
        status: 'success',
      }),
      ev({
        method: 'tool.completed',
        provider: 'acp',
        toolCallId: 'c2',
        toolName: 'grep',
        status: 'error',
      }),
      ev({
        method: 'tool.completed',
        provider: 'acp',
        toolCallId: 'c3',
        toolName: 'edit',
        status: 'cancelled',
      }),
      // station#1558: an unresolved call was dispatched exactly like the
      // three above; only its outcome is unknown. This counter counts calls
      // MADE, so excluding it would under-report every session that ended
      // mid-tool and disagree with the transcript, which shows the row.
      ev({
        method: 'tool.completed',
        provider: 'acp',
        toolCallId: 'c4',
        toolName: 'bash',
        status: 'unresolved',
      }),
    ]);

    expect(aggregate.toolCalls).toBe(4);
  });

  it('carries the latest session.configured model forward as lastModelId', () => {
    const aggregate = foldUsageEvents([
      ev({
        method: 'session.configured',
        provider: 'claude',
        model: 'claude-sonnet-4-5',
      }),
      ev({ method: 'turn.completed', provider: 'claude', turnId: 'r1' }),
      ev({
        method: 'session.configured',
        provider: 'claude',
        metadata: { effectiveModel: 'claude-opus-4-1' },
      }),
    ]);

    expect(aggregate.lastModelId).toBe('claude-opus-4-1');
  });

  it('leaves every field a token-usage.updated event omitted unreported', () => {
    const aggregate = foldUsageEvents([
      ev({ method: 'token-usage.updated', provider: 'claude' }),
    ]);

    expect(aggregate.inputTokens).toBeUndefined();
    expect(aggregate.outputTokens).toBeUndefined();
    expect(aggregate.totalTokens).toBeUndefined();
    expect(aggregate.cacheReadTokens).toBeUndefined();
    expect(aggregate.cacheWriteTokens).toBeUndefined();
    expect(aggregate.reportedCostUsd).toBeUndefined();
  });

  it('keeps a reported zero distinguishable from an unreported figure', () => {
    const aggregate = foldUsageEvents([
      ev({
        method: 'token-usage.updated',
        provider: 'claude',
        promptTokens: 0,
        reportedCostUsd: 0,
      } as any),
    ]);

    // A provider that says "zero" is measured; a provider that says nothing
    // is not. Collapsing these is the whole defect.
    expect(aggregate.inputTokens).toBe(0);
    expect(aggregate.reportedCostUsd).toBe(0);
    expect(aggregate.outputTokens).toBeUndefined();
  });

  it('derives a total from whichever components were reported, and none from none', () => {
    expect(
      foldUsageEvents([
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          promptTokens: 30,
        } as any),
      ]).totalTokens,
    ).toBe(30);

    expect(
      foldUsageEvents([
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          cacheReadTokens: 12,
        } as any),
      ]).totalTokens,
    ).toBeUndefined();
  });

  it('carries the provider id so a consumer can name the engine that reported nothing', () => {
    expect(
      foldUsageEvents([
        ev({ method: 'turn.completed', provider: 'acp', turnId: 'r1' }),
      ]).provider,
    ).toBe('acp');
    expect(foldUsageEvents([]).provider).toBeUndefined();
  });

  describe('provider-reported cost (station#1299 item 4)', () => {
    it('preserves a provider-reported cost verbatim rather than recomputing it', () => {
      const aggregate = foldUsageEvents([
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          promptTokens: 100,
          completionTokens: 40,
          reportedCostUsd: 0.123_456,
        } as any),
      ]);

      expect(aggregate.reportedCostUsd).toBe(0.123_456);
    });

    it('reads Claude cost as an engine-process running total, not a per-turn delta', () => {
      // Claude's `total_cost_usd` restates the whole query()'s cost on every
      // result. Summing 0.10 + 0.25 would report 0.35 for a session that
      // cost 0.25.
      const aggregate = foldUsageEvents([
        ev({ method: 'session.started', provider: 'claude' } as any),
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          reportedCostUsd: 0.1,
        } as any),
        ev({ method: 'turn.completed', provider: 'claude', turnId: 'r1' }),
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          reportedCostUsd: 0.25,
        } as any),
        ev({ method: 'turn.completed', provider: 'claude', turnId: 'r2' }),
      ]);

      expect(aggregate.reportedCostUsd).toBe(0.25);
    });

    it('sums one running total per engine process across a restart', () => {
      // A resume builds a NEW query(), so its running total starts at zero;
      // the earlier process's spend still happened.
      const aggregate = foldUsageEvents([
        ev({ method: 'session.started', provider: 'claude' } as any),
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          reportedCostUsd: 0.4,
        } as any),
        ev({ method: 'session.started', provider: 'claude' } as any),
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          reportedCostUsd: 0.1,
        } as any),
      ]);

      expect(aggregate.reportedCostUsd).toBeCloseTo(0.5, 10);
    });

    it('sums an undeclared provider cost per turn (the fail-safe direction)', () => {
      const aggregate = foldUsageEvents([
        ev({
          method: 'token-usage.updated',
          provider: 'some-new-engine',
          reportedCostUsd: 0.02,
        } as any),
        ev({
          method: 'token-usage.updated',
          provider: 'some-new-engine',
          reportedCostUsd: 0.03,
        } as any),
      ]);

      expect(aggregate.reportedCostUsd).toBeCloseTo(0.05, 10);
    });

    it('drops a broken cost observation instead of folding it in as zero', () => {
      for (const broken of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          foldUsageEvents([
            ev({
              method: 'token-usage.updated',
              provider: 'claude',
              reportedCostUsd: broken,
            } as any),
          ]).reportedCostUsd,
        ).toBeUndefined();
      }
    });
  });

  it('keeps the last valid context observation without adding it to input or output totals', () => {
    const aggregate = foldUsageEvents([
      ev({
        method: 'token-usage.updated',
        provider: 'claude',
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
      }),
      ev({
        method: 'token-usage.updated',
        provider: 'acp',
        contextTokens: 80_000,
        contextWindowTokens: 200_000,
      } as any),
      ev({
        method: 'token-usage.updated',
        provider: 'acp',
        contextTokens: 90_000,
        contextWindowTokens: 0,
      } as any),
    ]);

    expect(aggregate).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
      contextTokens: 80_000,
      contextWindowTokens: 200_000,
    });
  });

  it('ignores events that carry no usage/turn/tool/model signal', () => {
    const aggregate = foldUsageEvents([
      ev({ method: 'content.text-delta', provider: 'claude', delta: 'hi' }),
      ev({
        method: 'tool.started',
        provider: 'claude',
        toolCallId: 'c1',
        toolName: 'ls',
      }),
    ]);

    expect(aggregate).toEqual({
      provider: 'claude',
      turns: 0,
      toolCalls: 0,
    });
  });

  it('keeps a window-less context observation and resolves no window from it', () => {
    // Claude Code reports what it sent but not how large the window is; the
    // model inventory resolves the window one layer up.
    const aggregate = foldUsageEvents([
      ev({
        method: 'token-usage.updated',
        provider: 'claude',
        contextTokens: 41_000,
      } as any),
    ]);

    expect(aggregate.contextTokens).toBe(41_000);
    expect(aggregate.contextWindowTokens).toBeUndefined();
  });

  it('never pairs a later window-less occupancy with an earlier engine window', () => {
    const aggregate = foldUsageEvents([
      ev({
        method: 'token-usage.updated',
        provider: 'acp',
        contextTokens: 80_000,
        contextWindowTokens: 200_000,
      } as any),
      ev({
        method: 'token-usage.updated',
        provider: 'acp',
        contextTokens: 90_000,
      } as any),
    ]);

    // Reading 90,000 against the earlier 200,000 would be a percentage
    // built from two different moments.
    expect(aggregate.contextTokens).toBe(90_000);
    expect(aggregate.contextWindowTokens).toBeUndefined();
  });

  it('drops an occupancy observation whose window is present but unusable', () => {
    const aggregate = foldUsageEvents([
      ev({
        method: 'token-usage.updated',
        provider: 'acp',
        contextTokens: 90_000,
        contextWindowTokens: 0,
      } as any),
    ]);

    expect(aggregate.contextTokens).toBeUndefined();
    expect(aggregate.contextWindowTokens).toBeUndefined();
  });
});

describe('prompt-cache inclusivity (station#4196)', () => {
  /**
   * The #4048 audit's 212x known-answer fixture: a cold-cache 3-turn Claude
   * session. Claude's per-turn events carry input EXCLUDING cache
   * (`'disjoint'`), so the honest prompt-side figure is
   * input + cacheWrite + cacheRead = 135 + 10,100 + 18,400 = 28,635 —
   * where the pre-fix surfaces showed 135.
   */
  const coldCacheClaudeSession = () => [
    ev({
      method: 'token-usage.updated',
      provider: 'claude',
      promptTokens: 30,
      completionTokens: 100,
      totalTokens: 130,
      cacheWriteTokens: 9000,
      cacheReadTokens: 0,
    }),
    ev({ method: 'turn.completed', provider: 'claude', turnId: 'turn-1' }),
    ev({
      method: 'token-usage.updated',
      provider: 'claude',
      promptTokens: 45,
      completionTokens: 200,
      totalTokens: 245,
      cacheWriteTokens: 400,
      cacheReadTokens: 9000,
    }),
    ev({ method: 'turn.completed', provider: 'claude', turnId: 'turn-2' }),
    ev({
      method: 'token-usage.updated',
      provider: 'claude',
      promptTokens: 60,
      completionTokens: 300,
      totalTokens: 360,
      cacheWriteTokens: 700,
      cacheReadTokens: 9400,
    }),
    ev({ method: 'turn.completed', provider: 'claude', turnId: 'turn-3' }),
  ];

  it('declares claude disjoint and codex explicitly unverified — not by absence', () => {
    expect(providerPromptCacheInclusivity('claude')).toBe('disjoint');
    // Codex's entry is a considered "we do not know", present in the map;
    // an ABSENT provider is a different state (nobody has declared
    // anything). Both refuse the sum, but only one is an answer.
    expect(providerPromptCacheInclusivity('codex')).toBe('unverified');
    expect(providerPromptCacheInclusivity('acp')).toBeUndefined();
    expect(providerPromptCacheInclusivity(undefined)).toBeUndefined();
  });

  it('derives the 212x fixture to the exact honest prompt-side total (known answer)', () => {
    const aggregate = foldUsageEvents(coldCacheClaudeSession());
    expect(aggregate.inputTokens).toBe(135);
    expect(aggregate.cacheWriteTokens).toBe(10_100);
    expect(aggregate.cacheReadTokens).toBe(18_400);
    expect(cacheInclusivePromptTokens(aggregate.provider, aggregate)).toBe(
      28_635,
    );
    // The whole-session figure adds output on top of the prompt side:
    // 28,635 + 600 out = 29,235 (folded totalTokens 735 + cache 28,500).
    expect(cacheInclusiveTotalTokens(aggregate.provider, aggregate)).toBe(
      29_235,
    );
  });

  it('refuses the sum for an unverified provider — components stay separate', () => {
    const usage = {
      inputTokens: 100,
      totalTokens: 160,
      cacheReadTokens: 40,
    };
    expect(cacheInclusivePromptTokens('codex', usage)).toBeUndefined();
    expect(cacheInclusiveTotalTokens('codex', usage)).toBeUndefined();
  });

  it('refuses the sum for an undeclared provider — same direction as unverified', () => {
    const usage = { inputTokens: 10, cacheReadTokens: 5 };
    expect(cacheInclusivePromptTokens('acp', usage)).toBeUndefined();
    expect(
      cacheInclusiveTotalTokens('brand-new-engine', usage),
    ).toBeUndefined();
    expect(cacheInclusivePromptTokens(undefined, usage)).toBeUndefined();
  });

  it('makes no summed claim when no cache field was ever reported', () => {
    // Absent cache is not zero cache (station#3201): with nothing observed
    // there is nothing to add and no cache-inclusive CLAIM to make — the
    // plain figures already say everything measured.
    expect(
      cacheInclusivePromptTokens('claude', { inputTokens: 135 }),
    ).toBeUndefined();
    expect(
      cacheInclusiveTotalTokens('claude', {
        inputTokens: 135,
        outputTokens: 600,
        totalTokens: 735,
      }),
    ).toBeUndefined();
  });

  it('a reported zero cache field still backs the sum — zero is a measurement', () => {
    expect(
      cacheInclusivePromptTokens('claude', {
        inputTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 9000,
      }),
    ).toBe(9030);
  });

  it('refuses a partial-component sum — cache present but input never reported', () => {
    // A "prompt total" missing its input component would be a cache-only
    // figure claiming totality: refuse rather than silently understate.
    expect(
      cacheInclusivePromptTokens('claude', {
        cacheReadTokens: 9000,
        cacheWriteTokens: 400,
      }),
    ).toBeUndefined();
    // Same for the whole-session total when no base figure exists at all.
    expect(
      cacheInclusiveTotalTokens('claude', {
        cacheReadTokens: 9000,
        cacheWriteTokens: 400,
      }),
    ).toBeUndefined();
  });
});

describe('bedrock/ollama reported usage through the fold (station#4197)', () => {
  it('a 2-turn bedrock session sums per-turn events to the exact known answer', () => {
    // The event shapes the Bedrock adapter actually publishes
    // (`bedrockReportedUsage`): wire figures, no totalTokens, cache fields
    // only when the Converse wire carried them. Turn 1 is a cold cache
    // (write 9000, read 0 — a REPORTED zero); turn 2 reads the cache back.
    const aggregate = foldUsageEvents([
      ev({
        method: 'token-usage.updated',
        provider: 'bedrock',
        turnId: 'turn-1',
        promptTokens: 30,
        completionTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 9000,
      }),
      ev({ method: 'turn.completed', provider: 'bedrock', turnId: 'turn-1' }),
      ev({
        method: 'token-usage.updated',
        provider: 'bedrock',
        turnId: 'turn-2',
        promptTokens: 45,
        completionTokens: 200,
        cacheReadTokens: 9000,
        cacheWriteTokens: 400,
      }),
      ev({ method: 'turn.completed', provider: 'bedrock', turnId: 'turn-2' }),
    ]);
    expect(aggregate).toMatchObject({
      inputTokens: 75,
      outputTokens: 300,
      // Derived per-event as prompt + completion (no totalTokens on the
      // events), then summed: (30 + 100) + (45 + 200).
      totalTokens: 375,
      cacheReadTokens: 9000,
      cacheWriteTokens: 9400,
      turns: 2,
      provider: 'bedrock',
    });
    // `'disjoint'` (declared with SDK-source evidence) backs the honest
    // cache-inclusive derivations for exactly these figures.
    // The per-turn scope declaration is what lets the turn-provenance
    // envelope present these figures at all (undeclared reads as
    // "usage-scope-undeclared"), and what makes the fold's summing honest.
    expect(providerUsageScope('bedrock')).toBe('per-turn');
    expect(providerPromptCacheInclusivity('bedrock')).toBe('disjoint');
    expect(cacheInclusivePromptTokens('bedrock', aggregate)).toBe(
      75 + 9000 + 9400,
    );
    expect(cacheInclusiveTotalTokens('bedrock', aggregate)).toBe(
      375 + 9000 + 9400,
    );
  });

  it('a 2-turn ollama session sums per-turn events; undeclared inclusivity refuses the cache sum', () => {
    const aggregate = foldUsageEvents([
      ev({
        method: 'token-usage.updated',
        provider: 'ollama',
        turnId: 'turn-1',
        promptTokens: 512,
        completionTokens: 128,
      }),
      ev({ method: 'turn.completed', provider: 'ollama', turnId: 'turn-1' }),
      ev({
        method: 'token-usage.updated',
        provider: 'ollama',
        turnId: 'turn-2',
        promptTokens: 700,
        completionTokens: 300,
      }),
      ev({ method: 'turn.completed', provider: 'ollama', turnId: 'turn-2' }),
    ]);
    expect(aggregate).toMatchObject({
      inputTokens: 1212,
      outputTokens: 428,
      totalTokens: 1640,
      turns: 2,
      provider: 'ollama',
    });
    // No cache field was ever reported — absent, not zero.
    expect(aggregate.cacheReadTokens).toBeUndefined();
    expect(aggregate.cacheWriteTokens).toBeUndefined();
    // Ollama is deliberately undeclared (see the map's own comment): no
    // Ollama-side protocol evidence exists, so the sum is refused.
    expect(providerUsageScope('ollama')).toBe('per-turn');
    expect(providerPromptCacheInclusivity('ollama')).toBeUndefined();
    expect(
      cacheInclusivePromptTokens('ollama', {
        ...aggregate,
        cacheReadTokens: 200,
      }),
    ).toBeUndefined();
  });
});

describe('foldUsageEvents: durable rows written before the birth-site guards', () => {
  // The fold's input is the durable event stream, so it replays rows written
  // by producers that predate their own guards. `JSON.stringify` writes a
  // non-finite figure as `null`, and `null` passes an `!== undefined` gate —
  // reaching `conversation-manager`'s `reportedTokenFigureIsBroken`, which
  // throws and 500s that conversation's stats on EVERY read. Absence is what
  // makes the historical row readable again without inventing a measurement.
  it('treats a persisted null token figure as absent, and reports the drop', () => {
    const dropped: unknown[] = [];
    const aggregate = foldUsageEvents(
      [
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          promptTokens: null as unknown as number,
          completionTokens: 40,
        }),
      ],
      (d) => dropped.push(d),
    );

    expect(aggregate.inputTokens).toBeUndefined();
    expect(aggregate.outputTokens).toBe(40);
    expect(dropped).toEqual([
      expect.objectContaining({
        field: 'promptTokens',
        value: null,
        provider: 'claude',
        threadId: 't1',
      }),
    ]);
  });

  it('treats a persisted negative token figure as absent', () => {
    const dropped: unknown[] = [];
    const aggregate = foldUsageEvents(
      [
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          promptTokens: -5,
          cacheReadTokens: -1,
        }),
      ],
      (d) => dropped.push(d),
    );

    expect(aggregate.inputTokens).toBeUndefined();
    expect(aggregate.cacheReadTokens).toBeUndefined();
    expect(dropped).toHaveLength(2);
  });

  it('does not report a drop for a genuinely absent figure', () => {
    const dropped: unknown[] = [];
    foldUsageEvents(
      [
        ev({
          method: 'token-usage.updated',
          provider: 'claude',
          completionTokens: 40,
        }),
      ],
      (d) => dropped.push(d),
    );

    expect(dropped).toEqual([]);
  });
});
