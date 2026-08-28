/**
 * @vitest-environment jsdom
 *
 * archive#1434 — the assistant row's identity surfaces compose into ONE
 * story, with #1410's turn provenance envelope as the single per-turn
 * authority.
 *
 * The two halves shipped separately and deferred to each other: #1424's
 * attribution strip suppressed its engine chip everywhere (constant-null
 * `resolveTurnEngine`), and #1410's card rendered engine/model identity next
 * to a pre-existing `message__model-badge` that showed the *requested* model
 * bare while the card's pill preferred `reportedModel` — two model statements
 * on one row, the less truthful one unlabelled.
 *
 * Every assertion below reads RENDERED HUMAN TEXT, because the defect class
 * this closes ("the row says two different things about the same fact") only
 * ever shows up in what a person sees.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
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
vi.mock('../components/icons/UserIcon', () => ({
  UserIcon: () => null,
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

const gap = { state: 'unavailable', reason: 'not-reported-by-engine' } as const;
const stationGap = {
  state: 'unavailable',
  reason: 'not-captured-by-station',
} as const;

function observed<T>(value: T, eventId = 'e1') {
  return {
    state: 'observed' as const,
    value,
    observedFrom: [{ eventId, method: 'turn.completed' as const }],
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    envelopeVersion: 1,
    sessionId: 'thread-1',
    turnId: 'turn-7',
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

function renderRow(msg: ChatMessage) {
  return render(
    withQueryClient(
      <MessageBubble
        msg={msg}
        idx={0}
        activeSession={{
          id: 'thread-1',
          agentSlug: 'dev-agent',
          agentName: 'Dev Agent',
          messages: [msg],
        }}
        agents={[]}
        chatFontSize={14}
        showReasoning={false}
        showToolDetails={false}
        onCopy={() => {}}
        owner={{ id: 'brian', label: 'Brian Anderson' }}
      />,
    ),
  );
}

/** How many times a string appears in the row's rendered text. */
function occurrences(container: HTMLElement, needle: string): number {
  const text = container.textContent ?? '';
  return text.split(needle).length - 1;
}

describe('assistant row identity composition (station#1434)', () => {
  it('resolves the engine chip from the turn envelope, in the card’s own vocabulary', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      provenance: envelope(),
    });

    // The strip's engine chip is back — and it names the engine the way the
    // card does (`engineLabelForProvider`), not the raw slug.
    const chip = container.querySelector('.engine-chip');
    expect(chip?.textContent).toBe('Claude Code');
    // …and it is stated exactly ONCE on the row: the card's collapsed
    // headline no longer repeats what the strip already says.
    expect(occurrences(container, 'Claude Code')).toBe(1);
    // The card is still there, and still the checkable record — with a
    // headline that says there is provenance to open rather than an empty
    // span where the engine used to be.
    const card = screen.getByLabelText('Answer provenance for turn turn-7');
    expect(card).toBeTruthy();
    expect(within(card).getByRole('button').textContent).toContain(
      'Provenance',
    );
  });

  it('names Station’s own engine "Station", never the raw adapter slug, on the governed naming surface', () => {
    // `station-agent` is the provider the Station-agent orchestration adapter
    // stamps on its canonical events; `bedrock`/`ollama` are Model
    // connections Station's own engine executes through. All three are the
    // same engine the picker and `agentEngineDescriptor` call "Station", so
    // a turn's chip must not read them back as ids.
    for (const provider of ['station-agent', 'bedrock', 'ollama']) {
      const { container, unmount } = renderRow({
        role: 'assistant',
        content: 'Here is the answer.',
        turnId: 'turn-7',
        provenance: envelope({ engine: observed({ provider }) }),
      });
      expect(container.querySelector('.engine-chip')?.textContent).toBe(
        'Station',
      );
      expect(occurrences(container, provider)).toBe(0);
      unmount();
    }
  });

  it('keeps the raw provider slug when the envelope names an engine this build has no product name for', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      provenance: envelope({
        engine: observed({ provider: 'some-new-engine' }),
      }),
    });

    // No invented label: the identifier the envelope observed IS the honest
    // answer, and it matches what the card's Engine row shows.
    expect(container.querySelector('.engine-chip')?.textContent).toBe(
      'some-new-engine',
    );
  });

  it('renders requested and reported models as two LABELLED claims when they disagree, and never repeats either', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      // The pre-existing bare badge would have shown this requested model
      // with no label at all, next to a card pill preferring the reported
      // one — the archive#1182 disagree case.
      model: 'sonnet-latest',
      provenance: envelope({
        requestedModel: observed('sonnet-latest', 'e2'),
        reportedModel: observed('sonnet-9-20260701', 'e3'),
      }),
    });

    const claims = container.querySelector('.message__model-claims');
    expect(claims).toBeTruthy();
    expect(within(claims as HTMLElement).getByText('Requested')).toBeTruthy();
    expect(within(claims as HTMLElement).getByText('Reported')).toBeTruthy();

    // The label and the value are separate WORDS, not one welded token: the
    // rendered text a person reads (and a screen reader announces, and a
    // copy-paste yields) is "Requested sonnet-latest".
    const rendered = Array.from(
      (claims as HTMLElement).querySelectorAll('.message__model-claim'),
    ).map((claim) => claim.textContent);
    expect(rendered).toEqual([
      'Requested sonnet-latest',
      'Reported sonnet-9-20260701',
    ]);

    // Each model identity is claimed exactly once on the row — the card's
    // collapsed pill does not restate the model the row already labels.
    expect(occurrences(container, 'sonnet-9-20260701')).toBe(1);
    // 'sonnet-latest' is a substring of nothing else here.
    expect(occurrences(container, 'sonnet-latest')).toBe(1);

    // And the legacy bare badge is gone: no unlabelled model claim survives.
    expect(container.querySelector('.message__model-badge')).toBeNull();

    // With BOTH facts stated on the row, the card's headline still says what
    // it is rather than collapsing to an empty span.
    const card = screen.getByLabelText('Answer provenance for turn turn-7');
    expect(within(card).getByRole('button').textContent).toContain(
      'Provenance',
    );
  });

  it('keeps the request’s options attached to the claim that names the request, attributed so they never read as engine-reported', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      modelOptions: { effort: 'high' },
      provenance: envelope({
        requestedModel: observed('sonnet-latest', 'e2'),
        reportedModel: observed('sonnet-9-20260701', 'e3'),
      }),
    });

    const [requested, reported] = Array.from(
      container.querySelectorAll('.message__model-claim'),
    );
    // The hover text a person reads: options ride the requested claim…
    expect(requested.getAttribute('title')).toBe(
      'Model requested · Station requested: effort: high',
    );
    // …and never the reported one, which would read as the engine's report.
    expect(reported.getAttribute('title')).toBe('Model reported by engine');
  });

  it('still surfaces the request’s options when the envelope observed only the model the engine reported', () => {
    // The pre-#1434 badge always carried effort/thinking; a reported-only
    // row must not lose them silently just because the request slot is a gap.
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      modelOptions: { effort: 'high' },
      provenance: envelope({
        reportedModel: observed('sonnet-9-20260701', 'e3'),
      }),
    });

    const claims = container.querySelectorAll('.message__model-claim');
    expect(claims).toHaveLength(1);
    expect(claims[0].textContent).toBe('Reported sonnet-9-20260701');
    expect(claims[0].getAttribute('title')).toBe(
      'Model reported by engine · Station requested: effort: high',
    );
  });

  it('adds no options note to a row that has none', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      provenance: envelope({
        reportedModel: observed('sonnet-9-20260701', 'e3'),
      }),
    });

    expect(
      container.querySelector('.message__model-claim')?.getAttribute('title'),
    ).toBe('Model reported by engine');
  });

  it('states one model claim when the engine reported back exactly what Station requested', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      model: 'sonnet-9-20260701',
      provenance: envelope({
        requestedModel: observed('sonnet-9-20260701', 'e2'),
        reportedModel: observed('sonnet-9-20260701', 'e3'),
      }),
    });

    const claims = container.querySelector('.message__model-claims');
    expect(within(claims as HTMLElement).getByText('Model')).toBeTruthy();
    expect(occurrences(container, 'sonnet-9-20260701')).toBe(1);
    expect(within(claims as HTMLElement).queryByText('Requested')).toBeNull();
  });

  it('claims no model at all when the envelope observed none — never back-filled from the request record the card is simultaneously reporting as a gap', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      // Station's own stored request. The envelope observed no model, and
      // the card says so; showing this next to that gap is exactly the
      // contradiction #1434 closes.
      model: 'claude-3-7-sonnet-latest',
      provenance: envelope(),
    });

    expect(container.querySelector('.message__model-claims')).toBeNull();
    expect(occurrences(container, 'Claude 3.7 Sonnet')).toBe(0);
    expect(occurrences(container, 'claude-3-7-sonnet-latest')).toBe(0);
  });

  it('degrades the strip to honest absence — and never crashes — on an envelope this build cannot read', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      model: 'claude-3-7-sonnet-latest',
      provenance: { envelopeVersion: 9999, engine: { state: 'observed' } },
    });

    // No engine chip, no partial claim, transcript intact.
    expect(container.querySelector('.engine-chip')).toBeNull();
    expect(screen.getByText('Here is the answer.')).toBeTruthy();
    expect(
      screen.getByText(/cannot read\. Nothing about this answer is being/),
    ).toBeTruthy();
    // An unreadable envelope is not an envelope: the row keeps the pre-#1434
    // badge behaviour rather than silently dropping the model it does know.
    expect(container.querySelector('.message__model-claims')).toBeNull();
    expect(screen.getByText('Claude 3.7 Sonnet')).toBeTruthy();
  });

  it('states no engine when the envelope is readable but its engine slot is a gap', () => {
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      turnId: 'turn-7',
      provenance: envelope({ engine: gap }),
    });

    expect(container.querySelector('.engine-chip')).toBeNull();
    // The card keeps its own honest headline when the row states nothing.
    const card = screen.getByLabelText('Answer provenance for turn turn-7');
    expect(within(card).getByRole('button').textContent).toContain(
      'Engine unknown',
    );
  });

  it('preserves non-accessibility output for a row with no provenance', () => {
    // The assertions pin existing row content and provenance behavior while
    // explicitly allowing the intentional button and SVG accessibility work.
    const { container } = renderRow({
      role: 'assistant',
      content: 'Here is the answer.',
      model: 'claude-3-7-sonnet-latest',
      modelOptions: { effort: 'high' },
    });

    const copy =
      container.querySelector<HTMLButtonElement>('.message__copy-btn');
    expect(copy?.type).toBe('button');
    expect(copy?.getAttribute('aria-label')).toBe('Copy message');
    expect(copy?.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(screen.getByText('Claude 3.7 Sonnet')).toBeTruthy();
    expect(screen.getByText('Here is the answer.')).toBeTruthy();
  });
});
