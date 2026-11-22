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

  // One turn's report of what the context holds, as each adapter writes it.
  const contextTurn = (
    provider: string,
    threadId: string,
    turnId: string,
    context: { contextTokens?: number; contextPercent?: number },
  ) => [
    ev({
      method: 'token-usage.updated',
      provider,
      threadId,
      turnId,
      ...context,
    }),
    ev({ method: 'turn.completed', provider, threadId, turnId }),
  ];

  it("has no context figure after an engine change until the new engine reports one, never the previous engine's", () => {
    const claude = [
      ev({ method: 'session.started', provider: 'claude', threadId: 's1' }),
      ...contextTurn('claude', 's1', 'c1', { contextTokens: 120_000 }),
    ];
    const codexStarted = [
      ev({
        method: 'session.started',
        provider: 'codex',
        threadId: 's2',
        metadata: { codexThreadId: 'X' },
      }),
    ];
    const switched = foldLineageUsageEvents([claude, codexStarted]);
    expect(switched.provider).toBe('codex');
    expect(switched.contextTokens).toBeUndefined();
    expect(switched.contextWindowTokens).toBeUndefined();
    expect(switched.contextPercent).toBeUndefined();

    const reported = foldLineageUsageEvents([
      claude,
      [
        ...codexStarted,
        ...contextTurn('codex', 's2', 'x1', { contextTokens: 9_000 }),
      ],
    ]);
    expect(reported.contextTokens).toBe(9_000);

    // An engine that reports only its own reading (a percentage) is held to
    // the same rule.
    const fromPercent = foldLineageUsageEvents([
      [
        ev({ method: 'session.started', provider: 'acp', threadId: 's1' }),
        ...contextTurn('acp', 's1', 'a1', { contextPercent: 64 }),
      ],
      [ev({ method: 'session.started', provider: 'claude', threadId: 's2' })],
    ]);
    expect(fromPercent.contextPercent).toBeUndefined();
  });

  it("keeps a single engine's context across its own runs, as before", () => {
    // A fresh Codex thread is a new run of the same engine; until it reports,
    // the conversation keeps the figure it had.
    const aggregate = foldLineageUsageEvents([
      [
        ev({
          method: 'session.started',
          provider: 'codex',
          threadId: 's1',
          metadata: { codexThreadId: 'X' },
        }),
        ...contextTurn('codex', 's1', 'x1', { contextTokens: 50_000 }),
      ],
      [
        ev({
          method: 'session.started',
          provider: 'codex',
          threadId: 's2',
          metadata: { codexThreadId: 'Y' },
        }),
      ],
    ]);
    expect(aggregate.contextTokens).toBe(50_000);
  });

  it('takes the latest figures from the run that holds the newest Session, even when it is not the last run', () => {
    // Unreachable while a resume only continues the immediate predecessor:
    // a Codex Session that resumes thread X after a Claude Code one continues
    // the first run, which is then the newest.
    const aggregate = foldLineageUsageEvents([
      [
        ev({
          method: 'session.started',
          provider: 'codex',
          threadId: 's1',
          metadata: { codexThreadId: 'X' },
        }),
        ...contextTurn('codex', 's1', 'x1', { contextTokens: 10_000 }),
      ],
      [
        ev({ method: 'session.started', provider: 'claude', threadId: 's2' }),
        ...contextTurn('claude', 's2', 'c1', { contextTokens: 70_000 }),
      ],
      [
        ev({
          method: 'session.started',
          provider: 'codex',
          threadId: 's3',
          metadata: { codexThreadId: 'X' },
        }),
        ...contextTurn('codex', 's3', 'x2', { contextTokens: 12_000 }),
      ],
    ]);
    expect(aggregate.provider).toBe('codex');
    expect(aggregate.contextTokens).toBe(12_000);
    expect(aggregate.engines?.map((engine) => engine.provider)).toEqual([
      'codex',
      'claude',
    ]);
  });

  it("has no model after an engine change until the new engine reports one, so no window is read from the previous engine's model", () => {
    const aggregate = foldLineageUsageEvents([
      [
        ev({ method: 'session.started', provider: 'claude', threadId: 's1' }),
        ev({
          method: 'session.configured',
          provider: 'claude',
          threadId: 's1',
          model: 'claude-model-200k',
        }),
        ...contextTurn('claude', 's1', 'c1', { contextTokens: 120_000 }),
      ],
      [
        ev({ method: 'session.started', provider: 'acp', threadId: 's2' }),
        ...contextTurn('acp', 's2', 'a1', { contextTokens: 9_000 }),
      ],
    ]);
    expect(aggregate.provider).toBe('acp');
    expect(aggregate.contextTokens).toBe(9_000);
    expect(aggregate.lastModelId).toBeUndefined();
    // The engine's own row keeps the model it ran.
    expect(aggregate.engines?.[0]?.lastModelId).toBe('claude-model-200k');
  });

  it("a Codex Session back on an earlier thread of the same engine takes that thread's context (unreachable today)", () => {
    // Threads X, then Y, then X again: only reachable if a resume could open
    // a thread other than its predecessor's, which native-session ownership
    // refuses today. Were it reached, the newest Session runs on thread X, so
    // X's context is the one the next turn sends, not Y's.
    const codex = (threadId: string, thread: string, context: number) => [
      ev({
        method: 'session.started',
        provider: 'codex',
        threadId,
        metadata: { codexThreadId: thread },
      }),
      ...contextTurn('codex', threadId, `${threadId}:t`, {
        contextTokens: context,
      }),
    ];
    const aggregate = foldLineageUsageEvents([
      codex('s1', 'X', 1_000),
      codex('s2', 'Y', 2_000),
      [
        ev({
          method: 'session.started',
          provider: 'codex',
          threadId: 's3',
          metadata: { codexThreadId: 'X' },
        }),
      ],
    ]);
    expect(aggregate.contextTokens).toBe(1_000);
  });
});
