import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, it } from 'vitest';
import { foldUsageEvents } from '../usage-fold.js';
import { foldLineageUsageEvents } from '../usage-lineage-fold.js';

const base = {
  threadId: 't1',
  createdAt: '2026-11-20T00:00:00.000Z',
};
let n = 0;
const ev = (
  e: Partial<CanonicalRuntimeEvent> & { method: string; provider: string },
): CanonicalRuntimeEvent =>
  ({ eventId: `e${n++}`, ...base, ...e }) as unknown as CanonicalRuntimeEvent;

describe('foldLineageUsageEvents (#5389)', () => {
  it("keeps the only token-reporting engine's totals and the newest run's context, and sums cost per unit", () => {
    const claude = [
      ev({
        method: 'session.started',
        provider: 'claude',
        threadId: 'claude-1',
      }),
      ev({
        method: 'token-usage.updated',
        provider: 'claude',
        threadId: 'claude-1',
        turnId: 'c1',
        promptTokens: 14,
        completionTokens: 11,
        totalTokens: 25,
        contextTokens: 400,
        reportedCostUsd: 0.25,
      }),
      ev({
        method: 'turn.completed',
        provider: 'claude',
        threadId: 'claude-1',
        turnId: 'c1',
      }),
    ];
    // ACP's `usage_update`: the context pair and a session-scope cost in the
    // agent's own unit, never token totals.
    const acp = [
      ev({ method: 'session.started', provider: 'acp', threadId: 'acp-1' }),
      ev({
        method: 'token-usage.updated',
        provider: 'acp',
        threadId: 'acp-1',
        turnId: 'a1',
        contextTokens: 900,
        contextWindowTokens: 200_000,
        reportedCost: { amount: 3, unit: 'credit', scope: 'session' },
      }),
      ev({
        method: 'turn.completed',
        provider: 'acp',
        threadId: 'acp-1',
        turnId: 'a1',
      }),
    ];

    const aggregate = foldLineageUsageEvents([claude, acp]);

    expect(aggregate).toMatchObject({
      provider: 'acp',
      turns: 2,
      inputTokens: 14,
      outputTokens: 11,
      totalTokens: 25,
      contextTokens: 900,
      contextWindowTokens: 200_000,
      reportedCostUsd: 0.25,
      reportedCosts: [{ unit: 'credit', amount: 3 }],
    });
    expect(aggregate.engines).toEqual([
      {
        provider: 'claude',
        turns: 1,
        toolCalls: 0,
        inputTokens: 14,
        outputTokens: 11,
        totalTokens: 25,
        reportedCostUsd: 0.25,
      },
      {
        provider: 'acp',
        turns: 1,
        toolCalls: 0,
        reportedCosts: [{ unit: 'credit', amount: 3 }],
      },
    ]);
  });

  it('folds one Session exactly as the Session fold does, plus its one engine', () => {
    const events = [
      ev({ method: 'session.started', provider: 'codex' }),
      ev({
        method: 'token-usage.updated',
        provider: 'codex',
        promptTokens: 30,
        completionTokens: 3,
        totalTokens: 33,
      }),
      ev({ method: 'turn.completed', provider: 'codex', turnId: 'x1' }),
    ];
    const { engines, ...aggregate } = foldLineageUsageEvents([events]);
    expect(aggregate).toEqual(foldUsageEvents(events));
    expect(engines).toEqual([
      {
        provider: 'codex',
        turns: 1,
        toolCalls: 0,
        inputTokens: 30,
        outputTokens: 3,
        totalTokens: 33,
      },
    ]);
    expect(foldLineageUsageEvents([[], []])).toEqual(foldUsageEvents([]));
  });

  // Codex's start metadata as `codex-adapter.ts` writes it.
  const codexSession = (
    threadId: string,
    codexThreadId: string | undefined,
    total: number,
    resumed = false,
  ) => [
    ev({
      method: 'session.started',
      provider: 'codex',
      threadId,
      metadata: codexThreadId ? { codexThreadId } : {},
    }),
    ev({
      method: 'session.configured',
      provider: 'codex',
      threadId,
      metadata: {
        ...(resumed ? { nativeResumeIdentity: 'matched' } : {}),
        ...(codexThreadId ? { codexThreadId } : {}),
      },
    }),
    ev({
      method: 'token-usage.updated',
      provider: 'codex',
      threadId,
      turnId: `${threadId}:t`,
      promptTokens: total,
    }),
    ev({
      method: 'turn.completed',
      provider: 'codex',
      threadId,
      turnId: `${threadId}:t`,
    }),
  ];
  const claudeSession = (threadId: string, input: number) => [
    ev({ method: 'session.started', provider: 'claude', threadId }),
    ev({
      method: 'token-usage.updated',
      provider: 'claude',
      threadId,
      turnId: `${threadId}:t`,
      promptTokens: input,
    }),
  ];
  const codexInput = (sessions: CanonicalRuntimeEvent[][]) =>
    foldLineageUsageEvents(sessions).engines?.find(
      (engine) => engine.provider === 'codex',
    )?.inputTokens;

  it('adds a fresh Codex thread to the earlier one and continues a resumed thread', () => {
    expect(
      codexInput([codexSession('s1', 'X', 1100), codexSession('s2', 'Y', 220)]),
    ).toBe(1320);
    expect(
      codexInput([codexSession('s1', 'X', 300), codexSession('s2', 'Y', 450)]),
    ).toBe(750);
    expect(
      codexInput([
        claudeSession('s0', 10),
        codexSession('s1', 'X', 1100),
        codexSession('s2', 'Y', 220),
      ]),
    ).toBe(1320);
    // A Session with no events between them does not join the two threads.
    expect(
      codexInput([
        codexSession('s1', 'X', 1100),
        [],
        codexSession('s3', 'Y', 220),
      ]),
    ).toBe(1320);
    expect(
      codexInput([
        codexSession('s1', 'X', 1100),
        codexSession('s2', 'X', 1650, true),
      ]),
    ).toBe(1650);
  });

  it('counts a Codex Session that recorded no thread id as a fresh thread', () => {
    expect(
      codexInput([
        codexSession('s1', undefined, 300),
        codexSession('s2', undefined, 450),
      ]),
    ).toBe(750);
    expect(
      codexInput([
        codexSession('s1', 'X', 300),
        codexSession('s2', undefined, 450),
      ]),
    ).toBe(750);
  });

  it('leaves the conversation token figures absent when two engines reported tokens', () => {
    const aggregate = foldLineageUsageEvents([
      claudeSession('s1', 14),
      codexSession('s2', 'X', 700),
    ]);
    for (const field of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ] as const)
      expect(aggregate[field], field).toBeUndefined();
    expect(aggregate.engines?.map((engine) => engine.inputTokens)).toEqual([
      14, 700,
    ]);
  });
});
