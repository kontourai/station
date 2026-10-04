/** @vitest-environment jsdom */

import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import type { UsageReceipt } from '@kontourai/station-contracts/usage-rollup';
import { buildThreadUsageTree } from '@kontourai/station-shared/thread-usage-tree';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ConversationStatsModal } from './ConversationStatsModal';

function receipt(id: string, fields: Partial<UsageReceipt>): UsageReceipt {
  return {
    id,
    stationId: 'local',
    provider: 'claude',
    observedAt: '2026-09-23T00:00:00.000Z',
    pricing: { status: 'unpriced' },
    ...fields,
  };
}

const subagent: ChildWorkItem = {
  producer: 'engine-subagent',
  reporterThreadId: 'conv',
  childId: 'agent-1',
  status: 'completed',
  depth: 1,
  title: 'Search the repo',
  kindLabel: 'general-purpose',
  usage: { totalTokens: 41_108, toolUses: 3, durationMs: 65_000 },
};

/** A Claude conversation with a subagent and a Codex delegate. */
const tree = buildThreadUsageTree({
  conversationId: 'conv',
  provider: 'claude',
  receipts: [
    receipt('t1', { inputTokens: 1_000, outputTokens: 200 }),
    receipt('c1', { reportedCost: { amount: 0.25, currency: 'USD' } }),
  ],
  subagents: [{ item: subagent, provider: 'claude' }],
  delegates: [
    {
      location: 'local',
      item: {
        producer: 'station-delegate',
        reporterThreadId: 'task-1',
        childId: 'task-1',
        status: 'completed',
        title: 'Review the diff',
      },
      provider: 'codex',
      source: {
        conversationId: 'task-1',
        provider: 'codex',
        receipts: [
          receipt('t2', {
            provider: 'codex',
            inputTokens: 300,
            outputTokens: 50,
            estimatedCost: {
              amount: 2,
              currency: 'EUR',
              pricingSnapshotId: 'snap',
            },
          }),
        ],
        subagents: [],
        delegates: [],
      },
    },
  ],
});

function renderModal() {
  return render(
    <ConversationStatsModal
      isVisible
      isLoading={false}
      onToggle={vi.fn()}
      stats={{
        modelId: 'claude-sonnet-4-5',
        conversationId: 'conv',
        turns: 1,
        toolCalls: 0,
        measurement: { source: 'station-memory' },
      }}
      usageTree={tree}
    />,
  );
}

describe('conversation usage breakdown in the stats dialog', () => {
  test('shows the total, says it is partial and why, and keeps cost currencies apart', () => {
    renderModal();
    const section = screen.getByRole('region', { name: 'Usage with children' });
    // 1,200 own + 350 delegate; the Claude subagent's figure is not added.
    expect(
      within(section).getByText('Total: 1,550 input + output tokens'),
    ).toBeTruthy();
    // Claude counts uncached input and Codex's convention isn't established:
    // the dialog says so instead of claiming they differ.
    expect(section.textContent).toContain(
      "It isn't established whether these engines (Claude Code, Codex) count cached input the same way.",
    );
    expect(section.textContent).not.toContain('mixes two measures');
    expect(section.textContent).toContain('$0.25 reported');
    expect(section.textContent).toContain('€2.00 estimated');
    expect(within(section).getByText('Partial')).toBeTruthy();
    // One cause: the Claude subagent's tokens. Its cost is in the parent's,
    // and the delegate is counted whole, so the cost is complete.
    const reasons = within(section)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^Tokens not counted: Claude Code/);
  });

  test('expands into own turns, then each child nested, with its status in plain words', () => {
    renderModal();
    const toggle = screen.getByRole('button', { name: 'Show breakdown (3)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const rows = within(
      screen.getByRole('region', { name: 'Usage with children' }),
    )
      .getAllByRole('listitem')
      .filter((item) => item.classList.contains('thread-usage-breakdown__row'));
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual([
      'conversation',
      'engine-subagent',
      'station-delegate',
    ]);
    expect(rows[0].textContent).toContain('This conversation (own turns)');
    expect(rows[0].textContent).toContain(
      '1,200 input + output tokens · $0.25 reported',
    );
    expect(rows[1].textContent).toContain('Subagent: Search the repo');
    expect(rows[1].textContent).toContain(
      'last request 41,108 tokens (not its usage) · 3 tool uses · 1 min 5 s',
    );
    expect(rows[1].textContent).toContain(
      'Tokens not in total, cost already in parent.',
    );
    expect(rows[1].style.getPropertyValue('--thread-usage-level')).toBe('1');
    expect(rows[2].textContent).toContain('Delegated task: Review the diff');
    expect(rows[2].textContent).toContain('Usage added to total.');
  });
});
