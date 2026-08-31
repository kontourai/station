/**
 * @vitest-environment jsdom
 *
 * archive#1410: proves the provenance card is actually reachable from a real
 * assistant chat row — the fold and the card can both be correct while the
 * row never renders one. Uses the REAL MessageBubble; only the dependencies
 * that would drag in react-query/markdown are mocked.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../types';

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
// UserIcon reads the auth context; irrelevant to what this file asserts.
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => null,
}));
vi.mock('../components/chat/ConnectedAnswerBasisAffordance', () => ({
  ConnectedAnswerBasisAffordance: () => <button type="button">Basis</button>,
}));

const { MessageBubble } = await import('../components/chat/MessageBubble');

/**
 * archive#1423 added a share affordance to the assistant row, and it mints
 * through a react-query mutation — so the real row now needs a client. Given
 * for real rather than mocked away: this file exists to prove what the REAL
 * row renders, and a row that cannot mount inside the app's own provider tree
 * is exactly the defect it would otherwise miss.
 */
function withQueryClient(ui: ReactElement) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {ui}
    </QueryClientProvider>
  );
}

const envelope = {
  envelopeVersion: 1,
  sessionId: 'thread-1',
  turnId: 'turn-7',
  outcome: 'completed',
  observedAt: '2026-08-01T00:00:00.000Z',
  engine: {
    state: 'observed',
    value: { provider: 'codex' },
    observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
  },
  requestedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
  reportedModel: { state: 'unavailable', reason: 'not-reported-by-engine' },
  tools: { state: 'unavailable', reason: 'not-reported-by-engine' },
  usage: { state: 'unavailable', reason: 'not-reported-by-engine' },
  routingReceipt: { state: 'unavailable', reason: 'not-captured-by-station' },
  sources: { state: 'unavailable', reason: 'not-captured-by-station' },
  trustReport: { state: 'unavailable', reason: 'not-captured-by-station' },
};

function renderRow(
  msg: ChatMessage,
  props: { accountableHuman?: string | null; isThinking?: boolean } = {},
) {
  const { isThinking, ...messageBubbleProps } = props;
  return render(
    withQueryClient(
      <MessageBubble
        msg={msg}
        idx={0}
        activeSession={{
          id: 'thread-1',
          agentSlug: 'agent',
          messages: [msg],
          isThinking,
        }}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        {...messageBubbleProps}
      />,
    ),
  );
}

describe('MessageBubble turn provenance (station#1410)', () => {
  it('renders the checkpoint-derived workspace effect on its assistant turn', () => {
    renderRow({
      role: 'assistant',
      content: 'Done.',
      turnId: 'turn-7',
      changedFiles: {
        status: 'available',
        files: [
          { status: 'modified', path: 'src/main.ts' },
          {
            status: 'renamed',
            previousPath: 'old.ts',
            path: 'new.ts',
          },
        ],
      },
    });

    fireEvent.click(screen.getByText('2 changed files'));
    expect(screen.getByText('src/main.ts')).toBeTruthy();
    expect(screen.getByText('old.ts → new.ts')).toBeTruthy();
  });

  it.each([
    ['checkpoint_missing', 'A checkpoint for this turn is missing.'],
    [
      'checkpoint_failed',
      'Station failed to capture a checkpoint for this turn.',
    ],
    ['checkpoint_pruned', 'This turn’s checkpoint expired and was pruned.'],
  ] as const)('renders the %s changed-file reason', (reason, message) => {
    renderRow({
      role: 'assistant',
      content: 'Done.',
      turnId: 'turn-7',
      changedFiles: {
        status: 'unavailable',
        reason,
      },
    });

    expect(screen.getByText('Changed files unavailable')).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
  });

  // archive#1423: the share affordance must be reachable from the same real
  // row as the card — a mint button that only renders in its own unit test
  // is a feature nobody can use.
  it('keeps one inline action row and puts sharing in the provenance disclosure', async () => {
    renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      answerEligible: true,
      provenance: envelope,
    });

    const actions = document.querySelector('.turn-footer__actions');
    expect(getComputedStyle(actions!).flexWrap).toBe('nowrap');
    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Share this answer/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Provenance' }));
    expect(
      await screen.findByRole('button', {
        name: 'Share this answer (turn turn-7)',
      }),
    ).toBeTruthy();

    const overflow = await screen.findByRole('button', {
      name: 'More answer actions',
    });
    expect(overflow.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(overflow);
    expect(overflow.getAttribute('aria-expanded')).toBe('true');
    expect(
      // The attach affordance mounts beside a lazy message chunk; under full-
      // corpus worker load its dynamic import can exceed findByRole's 1s
      // default, redding this file corpus-only while isolation stays green
      // (the archive#1045 load-composition class). The longer bound changes
      // nothing about test power: an absent affordance still fails here.
      await screen.findByRole(
        'menuitem',
        { name: 'Add this answer to a Task (turn turn-7)' },
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(overflow.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.turn-footer [disabled]')).toBeNull();
  });

  it('offers no share affordance on a row with no readable envelope', () => {
    renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      provenance: { envelopeVersion: 99 },
    });

    expect(
      screen.queryByRole('button', { name: /Share this answer/ }),
    ).toBeNull();
  });

  it('does not render an empty overflow menu for provenance without an eligible answer', () => {
    renderRow({
      role: 'assistant',
      content: 'Still working.',
      provenance: envelope,
    });
    expect(
      screen.queryByRole('button', { name: 'More answer actions' }),
    ).toBeNull();
  });

  it('offers Task attachment for an explicitly completed assistant turn even when execution provenance was not recorded', async () => {
    renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-without-provenance',
      answerEligible: true,
    });

    fireEvent.click(
      await screen.findByRole('button', { name: 'More answer actions' }),
    );
    expect(
      await screen.findByRole('menuitem', {
        name: 'Add this answer to a Task (turn turn-without-provenance)',
      }),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Answer provenance/)).toBeNull();
  });

  it('does not offer Task attachment while the latest assistant turn is still active', () => {
    renderRow(
      {
        role: 'assistant',
        content: 'Still working.',
        turnId: 'turn-active',
      },
      { isThinking: true },
    );

    expect(
      screen.queryByRole('button', {
        name: 'Add this answer to a Task (turn turn-active)',
      }),
    ).toBeNull();
  });

  it('renders the provenance card on an assistant row that carries an envelope', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      provenance: envelope,
    });

    const card = screen.getByLabelText('Answer provenance for turn turn-7');
    expect(card).toBeTruthy();
    // SF7: the engine's product name, not its internal slug. archive#1434
    // moved that statement to the row's own attribution strip so the row
    // makes it exactly ONCE; the card's expanded Engine row still carries
    // the checkable raw slug.
    expect(container.querySelector('.engine-chip')?.textContent).toBe('Codex');
    expect(card.textContent).not.toContain('Codex');
    // archive#1802: the badge used to read "7 gaps" here, counting Station's
    // own not-yet-captured signals as if they were findings about this answer.
    // They read identically under every answer, so they are not per-answer
    // information and no longer reach the badge. This envelope describes a
    // healthy turn, so there is nothing notable to badge at all.
    expect(card.textContent).not.toMatch(/\d+ gaps?/);
  });

  it('keeps the accountable human in expanded provenance, not the row chip', async () => {
    renderRow(
      {
        role: 'assistant',
        content: 'Here is the answer.',
        turnId: 'turn-7',
        provenance: envelope,
      },
      { accountableHuman: 'Operator Person' },
    );

    expect(screen.queryByText('Operator Person')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Provenance' }));
    expect(screen.getByText('Accountable human')).toBeTruthy();
    expect(screen.getByText('Operator Person')).toBeTruthy();
  });

  it('keeps Basis inside Provenance and never renders it as a sibling action', async () => {
    renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      answerEligible: true,
      provenance: envelope,
    });

    expect(screen.queryByRole('button', { name: /^Basis/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Provenance' }));
    expect(
      await screen.findByRole(
        'button',
        { name: /^Basis/ },
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    expect(
      document
        .querySelector('.turn-provenance__detail')
        ?.contains(screen.getByRole('button', { name: /^Basis/ })),
    ).toBe(true);
  });

  it('renders no provenance card on a user row', () => {
    renderRow({
      role: 'user',
      content: 'Ask something.',
      provenance: envelope,
    });

    expect(screen.queryByLabelText(/^Answer provenance/)).toBeNull();
  });

  it('renders no provenance card, and claims nothing, when the turn has no envelope', () => {
    renderRow({ role: 'assistant', content: 'Here is the answer.' });

    expect(screen.queryByLabelText(/^Answer provenance/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Add this answer to a Task/ }),
    ).toBeNull();
    expect(screen.getByText('Here is the answer.')).toBeTruthy();
  });
});
