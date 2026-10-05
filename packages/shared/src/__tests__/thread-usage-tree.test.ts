import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import type { UsageReceipt } from '@kontourai/station-contracts/usage-rollup';
import { describe, expect, test } from 'vitest';
import {
  buildThreadUsageTree,
  ENGINE_SUBAGENT_USAGE_RELATION,
  engineSubagentUsageRelation,
  rollUpThreadUsage,
  type ThreadUsageConversationSource,
  threadUsageFiguresFromReceipts,
} from '../thread-usage-tree.js';

function receipt(id: string, fields: Partial<UsageReceipt> = {}): UsageReceipt {
  return {
    id,
    stationId: 'local',
    provider: 'codex',
    observedAt: '2026-09-23T00:00:00.000Z',
    pricing: { status: 'unpriced' },
    ...fields,
  };
}

function subagent(
  childId: string,
  totalTokens: number,
  depth = 1,
): ChildWorkItem {
  return {
    producer: 'engine-subagent',
    reporterThreadId: 'parent',
    childId,
    status: 'completed',
    depth,
    usage: { totalTokens, toolUses: 2, durationMs: 900 },
  };
}

function conversation(
  fields: Partial<ThreadUsageConversationSource> = {},
): ThreadUsageConversationSource {
  return {
    conversationId: 'parent',
    receipts: [],
    subagents: [],
    delegates: [],
    ...fields,
  };
}

describe('engine subagent relations', () => {
  test('declares Claude, Codex and Muse, and never guesses `added` for anything else', () => {
    expect([...ENGINE_SUBAGENT_USAGE_RELATION.keys()].sort()).toEqual([
      'claude',
      'codex',
      'muse',
    ]);
    expect(engineSubagentUsageRelation('claude')).toMatchObject({
      tokens: 'not-reported',
      cost: 'included-in-parent',
    });
    expect(engineSubagentUsageRelation('codex')).toMatchObject({
      tokens: 'added',
      cost: 'not-reported',
    });
    expect(engineSubagentUsageRelation('muse')).toMatchObject({
      tokens: 'added',
      cost: 'not-reported',
    });
    for (const provider of ['bedrock', 'some-new-engine', undefined])
      expect(engineSubagentUsageRelation(provider)).toMatchObject({
        tokens: 'not-reported',
        cost: 'not-reported',
      });
  });
});

describe('receipt figures', () => {
  test('a replaced receipt counts once, and reported cost buckets by currency', () => {
    const figures = threadUsageFiguresFromReceipts([
      receipt('tokens-1', { inputTokens: 10, outputTokens: 5 }),
      // A cumulative cost restated later replaces the earlier receipt.
      receipt('cost-epoch-1', {
        reportedCost: { amount: 1, currency: 'USD' },
        observedAt: '2026-09-23T00:00:01.000Z',
      }),
      receipt('cost-epoch-1', {
        reportedCost: { amount: 2, currency: 'USD' },
        observedAt: '2026-09-23T00:00:02.000Z',
      }),
      receipt('cost-other', { reportedCost: { amount: 4, currency: 'EUR' } }),
    ]);
    expect(figures).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      providers: ['codex'],
      reportedCost: [
        { amount: 2, currency: 'USD' },
        { amount: 4, currency: 'EUR' },
      ],
    });
  });

  test('nothing reported is no figures, not zeros', () => {
    expect(threadUsageFiguresFromReceipts([])).toBeUndefined();
    expect(threadUsageFiguresFromReceipts([receipt('empty')])).toBeUndefined();
  });
});

describe('roll-up', () => {
  test('adds Codex and Muse subagent tokens, and their missing cost makes the cost partial', () => {
    for (const provider of ['codex', 'muse']) {
      const tree = buildThreadUsageTree(
        conversation({
          provider,
          receipts: [receipt('t', { inputTokens: 100, outputTokens: 20 })],
          subagents: [{ item: subagent('child', 300), provider }],
        }),
      );
      expect(tree.total.tokens).toMatchObject({
        totalTokens: 420,
        complete: true,
      });
      expect(tree.total.cost.complete).toBe(false);
      expect(tree.root.children[0]).toMatchObject({
        kind: 'engine-subagent',
        depth: 1,
        own: { totalTokens: 300, toolUses: 2, durationMs: 900 },
      });
    }
  });

  test('a subagent included in its parent is shown and not added, and does not make the total partial', () => {
    // Claude's cost scope: the parent's reported cost already contains the
    // subagent's. A delegate below an included measurement inherits that.
    const tree = buildThreadUsageTree(
      conversation({
        provider: 'claude',
        receipts: [
          receipt('cost', {
            provider: 'claude',
            reportedCost: { amount: 0.25, currency: 'USD' },
          }),
        ],
        subagents: [{ item: subagent('child', 41_000), provider: 'claude' }],
      }),
    );
    expect(tree.total.cost).toEqual({
      reportedCost: [{ amount: 0.25, currency: 'USD' }],
      complete: true,
    });
    // A Claude subagent's figure is its last request's size: shown as that,
    // never as tokens used.
    expect(tree.root.children[0].own).toMatchObject({
      lastRequestTokens: 41_000,
    });
    expect(tree.root.children[0].own?.totalTokens).toBeUndefined();
    expect(tree.total.tokens.totalTokens).toBeUndefined();
  });

  test('never sums reported cost across currencies or estimates across snapshots', () => {
    const estimate = (amount: number, currency: string, id: string) => ({
      amount,
      currency,
      pricingSnapshotId: id,
    });
    const delegate = (id: string, fields: Partial<UsageReceipt>) => ({
      location: 'local' as const,
      item: {
        producer: 'station-delegate' as const,
        reporterThreadId: id,
        childId: id,
        status: 'completed' as const,
      },
      source: conversation({
        conversationId: id,
        receipts: [receipt(`${id}-r`, fields)],
      }),
    });
    const tree = buildThreadUsageTree(
      conversation({
        receipts: [
          receipt('a', { reportedCost: { amount: 1, currency: 'USD' } }),
        ],
        delegates: [
          delegate('d1', { reportedCost: { amount: 2, currency: 'EUR' } }),
          delegate('d2', {
            estimatedCost: estimate(3, 'USD', 'snap-1'),
            pricing: { status: 'priced' },
          }),
          delegate('d3', {
            estimatedCost: estimate(4, 'USD', 'snap-2'),
            pricing: { status: 'priced' },
          }),
          delegate('d4', { reportedCost: { amount: 5, currency: 'USD' } }),
        ],
      }),
    );
    expect(tree.total.cost).toEqual({
      reportedCost: [
        { amount: 6, currency: 'USD' },
        { amount: 2, currency: 'EUR' },
      ],
      estimatedCost: [
        estimate(3, 'USD', 'snap-1'),
        estimate(4, 'USD', 'snap-2'),
      ],
      complete: true,
    });
  });

  test('#3323: unreadable delegates anywhere in the tree are summed into one reason, and add no node or figure', () => {
    const tree = buildThreadUsageTree(
      conversation({
        receipts: [receipt('t', { inputTokens: 3, outputTokens: 1 })],
        unreadableDelegateCount: 1,
        delegates: [
          {
            location: 'local',
            item: {
              producer: 'station-delegate',
              reporterThreadId: 'child',
              childId: 'child',
              status: 'completed',
            },
            source: conversation({
              conversationId: 'child',
              receipts: [receipt('c', { inputTokens: 5, outputTokens: 5 })],
              unreadableDelegateCount: 2,
            }),
          },
        ],
      }),
    );
    expect(tree.nodeCount).toBe(2);
    expect(tree.total.tokens).toMatchObject({
      totalTokens: 14,
      complete: false,
    });
    expect(tree.total.cost.complete).toBe(false);
    expect(tree.total.partialReasons).toEqual([
      "3 delegated tasks run under an owner you can't read, so their usage is not counted.",
    ]);
  });

  test('a not-reported child makes the total partial with one reason per cause', () => {
    const tree = buildThreadUsageTree(
      conversation({
        provider: 'some-new-engine',
        receipts: [receipt('t', { inputTokens: 1, outputTokens: 1 })],
        subagents: [
          { item: subagent('a', 10), provider: 'some-new-engine' },
          { item: subagent('b', 10, 2), provider: 'some-new-engine' },
        ],
      }),
    );
    expect(tree.total.tokens).toMatchObject({
      totalTokens: 2,
      complete: false,
    });
    expect(tree.total.cost.complete).toBe(false);
    // Both measurements missing for one reason is one line, counted once
    // per child.
    expect(tree.total.partialReasons).toEqual([
      expect.stringMatching(/^Usage not counted: .*\(2 children\)$/),
    ]);
    expect(tree.root.children.map((child) => child.depth)).toEqual([1, 2]);
  });

  test('a child whose figure is included in its parent is never added, while its own added children are', () => {
    // No engine reports a figure under an included measurement today (Claude
    // subagents carry no cost of their own), so the rule is pinned on the
    // node tree directly.
    const total = rollUpThreadUsage({
      kind: 'conversation',
      id: 'root',
      depth: 0,
      own: {
        totalTokens: 100,
        reportedCost: [{ amount: 1, currency: 'USD' }],
      },
      children: [
        {
          kind: 'engine-subagent',
          id: 'included',
          depth: 1,
          own: {
            totalTokens: 40,
            reportedCost: [{ amount: 0.5, currency: 'USD' }],
          },
          relation: {
            tokens: 'included-in-parent',
            cost: 'included-in-parent',
            reason: 'in the parent',
          },
          children: [
            {
              kind: 'station-delegate',
              id: 'below',
              depth: 2,
              own: { totalTokens: 7 },
              relation: { tokens: 'added', cost: 'added', reason: 'own' },
              children: [],
            },
          ],
        },
      ],
    });
    expect(total).toEqual({
      tokens: { totalTokens: 107, complete: true },
      cost: { reportedCost: [{ amount: 1, currency: 'USD' }], complete: true },
      partialReasons: [],
    });
  });

  test('says whether the summed input contains cached input, and never calls unknown conventions different', () => {
    const own = (provider: string) =>
      receipt(`${provider}-t`, {
        provider,
        inputTokens: 10,
        outputTokens: 1,
      });
    const delegate = (id: string, provider: string) => ({
      location: 'local' as const,
      item: {
        producer: 'station-delegate' as const,
        reporterThreadId: id,
        childId: id,
        status: 'completed' as const,
      },
      source: conversation({ conversationId: id, receipts: [own(provider)] }),
    });
    const claudeOnly = buildThreadUsageTree(
      conversation({ receipts: [own('claude')] }),
    );
    expect(claudeOnly.total.tokens).toMatchObject({
      providers: ['claude'],
      cacheInclusion: 'excluded',
    });
    const codexOnly = buildThreadUsageTree(
      conversation({ receipts: [own('codex')] }),
    );
    expect(codexOnly.total.tokens.cacheInclusion).toBe('not-established');
    // Claude declares uncached input; Codex is unverified and Muse is
    // undeclared. Unknown is not "different", so neither pair is mixed.
    for (const [first, second] of [
      ['claude', 'codex'],
      ['codex', 'muse'],
    ])
      expect(
        buildThreadUsageTree(
          conversation({
            receipts: [own(first)],
            delegates: [delegate('d', second)],
          }),
        ).total.tokens,
      ).toMatchObject({
        totalTokens: 22,
        providers: [first, second],
        cacheInclusion: 'not-established',
      });
  });

  test("an undeclared engine's subagent figure is kept as unverified, never as tokens used", () => {
    const tree = buildThreadUsageTree(
      conversation({
        subagents: [{ item: subagent('x', 99), provider: 'some-new-engine' }],
      }),
    );
    expect(tree.root.children[0].own).toEqual({
      unverifiedTokens: 99,
      toolUses: 2,
      durationMs: 900,
    });
  });
});
