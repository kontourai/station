/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ConversationStatsModal } from './ConversationStatsModal';
import type { ConversationStatsSnapshot } from './types';

/**
 * station#3201: the panel used to render every absent measurement as `0`
 * and `$0.0000`, beside a header that WAS derived — one heading, one real
 * number, six invented ones, with no way to tell them apart. These tests
 * pin the three states apart end to end.
 */

const baseProps = {
  isVisible: true,
  isLoading: false,
  onToggle: vi.fn(),
};

function renderModal(stats: ConversationStatsSnapshot) {
  return render(<ConversationStatsModal {...baseProps} stats={stats} />);
}

/** Reads the "<label>: <value>" row the modal renders for a figure. */
function rowValue(label: string): string | undefined {
  const node = screen
    .getAllByText((_, element) => {
      const text = element?.textContent ?? '';
      return (
        element?.children.length === 0 && text.trim().startsWith(`${label}:`)
      );
    })
    .at(0);
  return node?.textContent?.split(':').slice(1).join(':').trim();
}

const MEASURED: ConversationStatsSnapshot = {
  modelId: 'claude-sonnet-4-5',
  conversationId: 'c1',
  turns: 2,
  toolCalls: 3,
  inputTokens: 1_200,
  outputTokens: 340,
  totalTokens: 1_540,
  estimatedCost: 0.0125,
  contextTokens: 20_000,
  contextWindowPercentage: 10,
  userMessageTokens: 400,
  assistantMessageTokens: 340,
  systemPromptTokens: 900,
  mcpServerTokens: 120,
  contextFilesTokens: 0,
  measurement: { source: 'station-memory' },
};

describe('ConversationStatsModal — measured figures', () => {
  test('renders every reported figure, cost included', () => {
    renderModal(MEASURED);

    expect(rowValue('In')).toBe('1,200');
    expect(rowValue('Out')).toBe('340');
    expect(rowValue('Total')).toBe('1,540');
    expect(screen.getByText('Total: $0.0125')).toBeTruthy();
    expect(screen.getByText('Per Turn: $0.0063')).toBeTruthy();
  });

  test('a Station-measured session gets no unreported disclosure', () => {
    renderModal(MEASURED);

    expect(screen.queryByText(/did not report/)).toBeNull();
  });

  test('a reported zero cost still renders as a cost, not a dash', () => {
    renderModal({ ...MEASURED, estimatedCost: 0 });

    expect(screen.getByText('Total: $0.0000')).toBeTruthy();
  });
});

describe('ConversationStatsModal — unmeasured figures', () => {
  /**
   * The exact shape behind station#3201's screenshot: an ACP/OpenCode
   * session reports context occupancy and nothing else.
   */
  const UNMEASURED: ConversationStatsSnapshot = {
    modelId: 'opencode-glm',
    conversationId: 'c2',
    turns: 1,
    toolCalls: 0,
    contextTokens: 27_554,
    contextWindowPercentage: 13.8,
    measurement: { source: 'engine-events', provider: 'acp' },
  };

  test('renders an em-dash for every unreported token figure — never a zero', () => {
    renderModal(UNMEASURED);

    expect(rowValue('In')).toBe('—');
    expect(rowValue('Out')).toBe('—');
    expect(rowValue('Total')).toBe('—');
    expect(screen.queryByText('In: 0')).toBeNull();
    expect(screen.queryByText('Out: 0')).toBeNull();
  });

  test('renders an em-dash for an unreported cost — never $0.0000', () => {
    renderModal(UNMEASURED);

    // Both the token total and the cost total are unmeasured here, so the
    // dash appears twice — the point is that neither is a `0`.
    expect(screen.getAllByText('Total: —')).toHaveLength(2);
    expect(screen.getByText('Per Turn: —')).toBeTruthy();
    expect(screen.queryByText(/\$0\.0000/)).toBeNull();
  });

  test('names the engine and the classes it did not report', () => {
    renderModal(UNMEASURED);

    const note = screen.getByText(/did not report/).textContent ?? '';
    expect(note).toContain('Custom engine');
    expect(note).toContain('token counts');
    expect(note).toContain('cost');
    // Context usage WAS reported here, so the note must not claim it wasn't.
    expect(note).not.toContain('context usage');
  });

  test('the derived context header still renders — it is the one real number', () => {
    renderModal(UNMEASURED);

    expect(screen.getByText('13.8%')).toBeTruthy();
    expect(screen.getByText(/27,554 tokens/)).toBeTruthy();
  });

  test('falls back to the raw provider id, and then to a neutral phrase, rather than inventing an engine name', () => {
    renderModal({
      ...UNMEASURED,
      measurement: { source: 'engine-events', provider: 'brand-new-engine' },
    });
    expect(screen.getByText(/brand-new-engine did not report/)).toBeTruthy();

    screen.getByText(/brand-new-engine/); // sanity: rendered once above
  });

  test('a session with no provider attributed says so without naming one', () => {
    renderModal({
      ...UNMEASURED,
      measurement: { source: 'engine-events' },
    });

    expect(
      screen.getByText(/This session’s engine did not report/),
    ).toBeTruthy();
  });
});

describe('ConversationStatsModal — partially measured figures', () => {
  /** Claude Code: tokens and cost reported, context occupancy reported too. */
  const PARTIAL: ConversationStatsSnapshot = {
    modelId: 'claude-sonnet-4-5',
    conversationId: 'c3',
    turns: 2,
    toolCalls: 5,
    inputTokens: 900,
    outputTokens: 120,
    totalTokens: 1_020,
    measurement: { source: 'engine-events', provider: 'claude' },
  };

  test('shows the tokens that were reported and dashes only the cost', () => {
    renderModal(PARTIAL);

    // Claude's declared cache-inclusivity is 'disjoint' (input excludes
    // cache), so the In label carries the qualifier the declaration backs
    // (station#4196).
    expect(rowValue('In (uncached)')).toBe('900');
    expect(rowValue('Out')).toBe('120');
    expect(rowValue('Total')).toBe('1,020');
    expect(screen.getByText('Total: —')).toBeTruthy();
  });

  test('the disclosure names only the classes actually missing', () => {
    renderModal(PARTIAL);

    const note = screen.getByText(/did not report/).textContent ?? '';
    expect(note).toContain('Claude Code');
    expect(note).toContain('cost');
    expect(note).toContain('context usage');
    expect(note).not.toContain('token counts');
  });

  test('per-turn averages dash the unmeasured breakdown instead of averaging zero', () => {
    renderModal(PARTIAL);

    // `userMessageTokens` is a Station-engine context measurement; an
    // external engine never reports it, and `|| 0` used to average it to 0.
    expect(rowValue('User')).toBe('—');
    expect(rowValue('Assistant')).toBe('—');
    expect(screen.getByText(/Total In \(uncached\)\s*:\s*450/)).toBeTruthy();
  });

  test('activity counts still render as numbers — Station counts those itself', () => {
    renderModal(PARTIAL);

    expect(screen.getByText('Turns: 2')).toBeTruthy();
    expect(screen.getByText('Tool Calls: 5')).toBeTruthy();
  });
});

/**
 * Review H1. `stats === null` is what a settled-empty read AND a failed read
 * both look like, and `useStats` dropped the query error entirely — so a
 * failed stats read was drawn as "No stats available", a measurement claim
 * over a request that never answered. Same defect shape as SHELL-09.
 */
describe('ConversationStatsModal read failure', () => {
  test('renders the failure with a retry, not "No stats available"', () => {
    const onRetry = vi.fn();
    render(
      <ConversationStatsModal
        {...baseProps}
        stats={null}
        error={new Error('stats read failed')}
        onRetry={onRetry}
      />,
    );

    expect(screen.queryByText('No stats available')).toBeNull();
    expect(
      screen.getByText('Unable to load conversation statistics'),
    ).toBeTruthy();
    expect(screen.getByText('stats read failed')).toBeTruthy();

    screen.getByRole('button', { name: 'Retry' }).click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('still says "No stats available" when the read genuinely settled empty', () => {
    render(<ConversationStatsModal {...baseProps} stats={null} />);

    expect(screen.getByText('No stats available')).toBeTruthy();
    expect(
      screen.queryByText('Unable to load conversation statistics'),
    ).toBeNull();
  });

  test('the wait outranks the failure while the first read is in flight', () => {
    render(
      <ConversationStatsModal
        {...baseProps}
        isLoading
        stats={null}
        error={new Error('stats read failed')}
      />,
    );

    expect(
      screen.getByLabelText('Loading conversation statistics'),
    ).toBeTruthy();
    expect(
      screen.queryByText('Unable to load conversation statistics'),
    ).toBeNull();
  });
});

describe('ConversationStatsModal — cache-honest totals (station#4196)', () => {
  /**
   * The wire shape the 212x known-answer fixture produces end to end (the
   * fold->wire half is pinned in `conversation-manager.test.ts` with the
   * same numbers): cold-cache 3-turn Claude session, input 30/45/60,
   * cache_creation 9000/400/700, cache_read 0/9000/9400.
   */
  const DISJOINT_CLAUDE: ConversationStatsSnapshot = {
    modelId: 'claude-sonnet-4-5',
    conversationId: 'c-cache',
    turns: 3,
    toolCalls: 0,
    inputTokens: 135,
    outputTokens: 600,
    totalTokens: 735,
    cacheReadTokens: 18_400,
    cacheWriteTokens: 10_100,
    measurement: { source: 'engine-events', provider: 'claude' },
  };

  test('renders cache rows and the exact honest prompt-side total for a disjoint provider', () => {
    renderModal(DISJOINT_CLAUDE);

    expect(rowValue('In (uncached)')).toBe('135');
    expect(rowValue('Cache read')).toBe('18,400');
    expect(rowValue('Cache write')).toBe('10,100');
    // The known answer: 135 + 10,100 + 18,400 — where the pre-fix modal
    // said 135 under the same "sent across all API calls" subtitle.
    expect(rowValue('Prompt total')).toBe('28,635');
    // And the card total includes cache too: 735 + 28,500.
    expect(rowValue('Total')).toBe('29,235');
  });

  test("an 'unverified' provider's figures are never summed — components render separately", () => {
    renderModal({
      modelId: 'gpt-5.3-codex',
      conversationId: 'c-codex',
      turns: 2,
      toolCalls: 1,
      inputTokens: 2_200,
      outputTokens: 800,
      totalTokens: 3_000,
      cacheReadTokens: 900,
      measurement: { source: 'engine-events', provider: 'codex' },
    });

    // No inclusivity claim on the label (whether codex's input already
    // contains its cached tokens is undeclared-as-unverified), no
    // Station-built sum anywhere — the provider's own figures stand.
    expect(rowValue('In')).toBe('2,200');
    expect(rowValue('Cache read')).toBe('900');
    expect(screen.queryByText(/Prompt total/)).toBeNull();
    expect(rowValue('Total')).toBe('3,000');
    expect(screen.queryByText(/3,900/)).toBeNull();
  });

  test('an absent-cache session gets no invented cache rows and keeps the uncached labeling', () => {
    renderModal({
      modelId: 'claude-sonnet-4-5',
      conversationId: 'c-nocache',
      turns: 1,
      toolCalls: 0,
      inputTokens: 500,
      outputTokens: 200,
      totalTokens: 700,
      measurement: { source: 'engine-events', provider: 'claude' },
    });

    // The declaration still backs the qualifier — claude input excludes
    // cache whether or not this session used any — but with no cache
    // observation there is no row and no summed claim (absent is not zero).
    expect(rowValue('In (uncached)')).toBe('500');
    expect(screen.queryByText(/Cache read/)).toBeNull();
    expect(screen.queryByText(/Cache write/)).toBeNull();
    expect(screen.queryByText(/Prompt total/)).toBeNull();
    expect(rowValue('Total')).toBe('700');
  });

  test('a Station-memory view keeps its plain labels — inclusivity is an engine-events concept', () => {
    renderModal(MEASURED);

    expect(rowValue('In')).toBe('1,200');
    expect(screen.queryByText(/uncached/)).toBeNull();
    expect(screen.queryByText(/Prompt total/)).toBeNull();
  });
});
