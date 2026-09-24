/**
 * @vitest-environment jsdom
 *
 * archive#1410: proves the provenance card is actually reachable from a real
 * assistant chat row — the fold and the card can both be correct while the
 * row never renders one. Uses the REAL MessageBubble; only the dependencies
 * that would drag in react-query/markdown are mocked.
 *
 * #2211: the card no longer renders inline in the turn footer. The row keeps
 * the transcript focused on the answer: the footer is icon-copy + rating +
 * overflow, and "Turn provenance" opens the SAME card in a dialog.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
// The trace links are gated on this setting. The behavioural tests below cover
// the pre-footer site (`!hasTurnFooter`) and the footer site; the source-text
// contract test separately proves that both guarded sites remain in the file.
const developerTools = { enabled: false };
vi.mock('../contexts/DeviceSettingsContext', async () => {
  const actual = await vi.importActual<
    typeof import('../contexts/DeviceSettingsContext')
  >('../contexts/DeviceSettingsContext');
  const { deviceSettingsStore } = await vi.importActual<
    typeof import('../lib/device-settings-store')
  >('../lib/device-settings-store');
  return {
    ...actual,
    useDeviceSettings: () => ({
      ...deviceSettingsStore.getSnapshot(),
      developerToolsEnabled: developerTools.enabled,
    }),
  };
});
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
          messageCount: 1,
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

/** #2211: provenance opens from the overflow menu, as a dialog. */
async function openProvenanceDialog() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'More answer actions' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Turn provenance' }));
  await screen.findByLabelText(/^Answer provenance/);
}

describe('MessageBubble turn provenance (station#1410, #2211)', () => {
  afterEach(() => {
    developerTools.enabled = false;
  });

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
  // is a feature nobody can use. #2211: it rides inside the provenance
  // dialog, reached from the overflow menu.
  it('keeps the overflow as the only chrome; the menu lists the turn record, the dialog hosts it', async () => {
    renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      answerEligible: true,
      provenance: envelope,
    });

    expect(screen.getByRole('button', { name: 'Copy message' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Share this answer/ }),
    ).toBeNull();
    // No inline provenance disclosure in the footer any more.
    expect(screen.queryByRole('button', { name: 'Provenance' })).toBeNull();

    // The MENU lists both the record and the action…
    fireEvent.click(
      await screen.findByRole('button', { name: 'More answer actions' }),
    );
    expect(
      await screen.findByRole(
        'menuitem',
        { name: 'Add this answer to a Task (turn turn-7)' },
        // The attach affordance mounts beside a lazy message chunk; under
        // full-corpus worker load its dynamic import can exceed findByRole's
        // 1s default, redding this file corpus-only while isolation stays
        // green (the archive#1045 load-composition class). The longer bound
        // changes nothing about test power: an absent affordance still fails.
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('menuitem', { name: 'Turn provenance' }),
    ).toBeTruthy();

    // …and choosing provenance swaps the menu for the dialog that hosts the
    // card, share affordance included.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn provenance' }));
    await screen.findByLabelText('Answer provenance for turn turn-7');
    expect(
      await screen.findByRole('button', {
        name: 'Share this answer (turn turn-7)',
      }),
    ).toBeTruthy();
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

  it('hides the trace link unless developer tools are on, and shows it when they are', async () => {
    developerTools.enabled = false;
    const off = renderRow({
      role: 'assistant',
      content: 'Traced.',
      provenance: envelope,
      traceId: 'trace-abcdef12',
    } as ChatMessage);
    expect(off.container.querySelector('.message__trace')).toBeNull();
    off.unmount();

    developerTools.enabled = true;
    const on = renderRow({
      role: 'assistant',
      content: 'Traced.',
      provenance: envelope,
      traceId: 'trace-abcdef12',
    } as ChatMessage);
    expect(on.container.querySelector('.message__trace')).not.toBeNull();
  });

  it('gates the trace link on an assistant row without a turn footer', () => {
    developerTools.enabled = false;
    const off = renderRow({
      role: 'assistant',
      content: 'Legacy traced answer.',
      traceId: 'trace-legacy12',
    } as ChatMessage);
    expect(off.container.querySelector('.message__trace')).toBeNull();
    off.unmount();

    developerTools.enabled = true;
    const on = renderRow({
      role: 'assistant',
      content: 'Legacy traced answer.',
      traceId: 'trace-legacy12',
    } as ChatMessage);
    expect(on.container.querySelector('.message__trace')).not.toBeNull();
  });

  it('offers the provenance dialog for an ineligible answer even when Task attachment is unavailable', async () => {
    // #2211 changed what the overflow is FOR: it is the per-turn record's
    // home, so a row with only a readable envelope (not eligible for Task)
    // still gets the menu, with only the provenance item in it.
    await import('../components/chat/TurnActionsMenu');
    renderRow({
      role: 'assistant',
      content: 'Still working.',
      provenance: envelope,
    });
    fireEvent.click(
      await screen.findByRole('button', { name: 'More answer actions' }),
    );
    expect(
      screen.getByRole('menuitem', { name: 'Turn provenance' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('menuitem', { name: /Add this answer to a Task/ }),
    ).toBeNull();
  });

  it('does not render an empty overflow menu while the last answer is thinking', async () => {
    await import('../components/chat/TurnActionsMenu');
    renderRow(
      {
        role: 'assistant',
        content: 'Still thinking.',
        turnId: 'turn-thinking',
        answerEligible: true,
      },
      { isThinking: true },
    );
    await act(async () => {});
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

  it('opens the provenance card in a dialog on demand and keeps it out of the resting row', async () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      provenance: envelope,
    });

    // Resting row: no card anywhere.
    expect(screen.queryByLabelText(/^Answer provenance/)).toBeNull();

    await openProvenanceDialog();

    const card = screen.getByLabelText('Answer provenance for turn turn-7');
    // #2211: the dialog IS the disclosure — the card opens expanded, and its
    // detail carries the checkable raw slug the collapsed headline used to
    // stand down from ("Codex (codex)").
    expect(card.textContent).toContain('(codex)');
    // SF7: the ROW still states the engine exactly once — the attribution
    // chip's product name, with no duplicate statement on the row itself.
    expect(container.querySelectorAll('.engine-chip')).toHaveLength(1);
    expect(container.querySelector('.engine-chip')?.textContent).toBe('Codex');
    // archive#1802: the badge used to read "7 gaps" here, counting Station's
    // own not-yet-captured signals as if they were findings about this answer.
    expect(card.textContent).not.toMatch(/\d+ gaps?/);
  });

  it('keeps the accountable human in the provenance dialog, not the row chip', async () => {
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
    await openProvenanceDialog();
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
    await openProvenanceDialog();
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

  it('renders no provenance affordance on a user row', () => {
    renderRow({
      role: 'user',
      content: 'Ask something.',
      provenance: envelope,
    });

    expect(screen.queryByLabelText(/^Answer provenance/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'More answer actions' }),
    ).toBeNull();
  });

  it('renders no provenance affordance, and claims nothing, when the turn has no envelope', () => {
    renderRow({ role: 'assistant', content: 'Here is the answer.' });

    expect(screen.queryByLabelText(/^Answer provenance/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'More answer actions' }),
    ).toBeNull();
    expect(screen.getByText('Here is the answer.')).toBeTruthy();
  });

  // #2211: settled reasoning leaves the bubble. The record stays reachable
  // through the same overflow menu, as a dialog.
  describe('settled reasoning (#2211)', () => {
    const reasoningRow = {
      role: 'assistant' as const,
      content: 'The answer, briefly.',
      turnId: 'turn-reasoned',
      contentParts: [
        {
          type: 'reasoning' as const,
          content: 'Two words of thought.',
        },
        { type: 'text' as const, content: 'The answer, briefly.' },
      ],
    };

    it('renders no inline reasoning section on a settled row, and offers it in the overflow', async () => {
      renderRow(reasoningRow);

      expect(screen.queryByText(/Reasoning ·/)).toBeNull();
      expect(screen.queryByText('Two words of thought.')).toBeNull();

      fireEvent.click(
        await screen.findByRole('button', { name: 'More answer actions' }),
      );
      expect(
        screen.getByRole('menuitem', { name: 'Reasoning (4 words)' }),
      ).toBeTruthy();
    });

    it('opens the reasoning text in a dialog from the overflow', async () => {
      renderRow(reasoningRow);

      fireEvent.click(
        await screen.findByRole('button', { name: 'More answer actions' }),
      );
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Reasoning (4 words)' }),
      );

      expect(await screen.findByText('Two words of thought.')).toBeTruthy();
      expect(screen.getByText('Reasoning')).toBeTruthy();
    });
  });

  /**
   * #1536 B3. `GET …/turns/:turnId/basis` answers 404 unless the turn's own
   * ordered lifecycle says it completed normally, and 404 there is an answer
   * rather than a fault — the route keeps 503 for a read it could not perform.
   * The client's precondition was `answerEligible` alone, a weaker claim, so an
   * ABORTED turn asked for a basis the server can only refuse and rendered that
   * refusal as "Basis · Unavailable" on a healthy instance.
   */
  describe('the Basis affordance asks only what the route can answer', () => {
    /** The affordance lives inside the dialog-hosted card's detail. */
    async function expandProvenance() {
      await openProvenanceDialog();
      await act(async () => {});
    }

    it('offers Basis for a turn whose envelope records a completed outcome', async () => {
      renderRow({
        role: 'assistant',
        content: 'Here is the answer.',
        turnId: 'turn-7',
        answerEligible: true,
        provenance: envelope,
      });
      await expandProvenance();

      // The Basis affordance mounts through a lazy chunk inside the dialog.
      expect(
        await screen.findByRole(
          'button',
          { name: 'Basis' },
          { timeout: 10_000 },
        ),
      ).toBeTruthy();
    });

    it('offers no Basis for an aborted turn, however eligible its answer', async () => {
      renderRow({
        role: 'assistant',
        content: 'Partial answer.',
        turnId: 'turn-7',
        answerEligible: true,
        provenance: { ...envelope, outcome: 'aborted' },
      });
      await expandProvenance();

      expect(screen.queryByRole('button', { name: 'Basis' })).toBeNull();
      // The rest of the provenance card is unaffected: an aborted turn still
      // has an engine and a turn id worth checking.
      expect(screen.getByLabelText(/^Answer provenance/)).toBeTruthy();
    });
  });
});
