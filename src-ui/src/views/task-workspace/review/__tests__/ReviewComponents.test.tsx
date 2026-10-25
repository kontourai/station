/** @vitest-environment jsdom */

import {
  countThreads,
  deriveThreadView,
} from '@kontourai/station-contracts/task-review';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigationStore } from '../../../../contexts/navigation-store';
import { ReviewCommentsRail } from '../ReviewCommentsRail';
import { ReviewDocumentView } from '../ReviewDocumentView';
import { ReviewImageView } from '../ReviewImageView';
import { ReviewItemList } from '../ReviewItemList';
import { ReviewThreadCard } from '../ReviewThreadCard';
import { TaskReviewLayout } from '../TaskReviewLayout';
import { ReviewGallery } from './ReviewGallery';
import {
  capture,
  captureArtifact,
  captureThread,
  items,
  plan,
  screenSrc,
  text,
  thread,
  threads,
} from './review-fixtures';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  window.getSelection()?.removeAllRanges();
});

const actions = () => ({
  draftScope: 'station-1:account-1',
  resolveAuthor: (author: { kind: string }) => ({
    name: author.kind === 'session' ? 'Claude Code' : 'Brian',
    ...(author.kind === 'session' ? { startedBy: { name: 'Brian' } } : {}),
  }),
  onReply: vi.fn(),
  onResolve: vi.fn(),
  onReopen: vi.fn(),
});

function selectText(container: HTMLElement, exact: string) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && !node.textContent?.includes(exact)) node = walker.nextNode();
  if (!node) throw new Error(`Rendered selection target missing: ${exact}`);
  const start = node.textContent!.indexOf(exact);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + exact.length);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(container);
}

describe('review components', () => {
  it('blocks route navigation until an unsaved reply is explicitly discarded', () => {
    navigationStore.navigate('/review-draft-origin');
    render(<ReviewThreadCard thread={threads[0]} {...actions()} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Write reply to thread 1' }),
    );
    fireEvent.change(screen.getByLabelText('Reply to thread 1'), {
      target: { value: 'Unsent reply' },
    });
    act(() => navigationStore.navigate('/review-draft-target'));
    expect(window.location.pathname).toBe('/review-draft-origin');
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Unsaved Changes' })).getByRole(
        'button',
        { name: 'Cancel' },
      ),
    );
    expect(screen.getByLabelText('Reply to thread 1')).toHaveProperty(
      'value',
      'Unsent reply',
    );
    act(() => navigationStore.navigate('/review-draft-target'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(window.location.pathname).toBe('/review-draft-target');
    expect(screen.getByLabelText('Reply to thread 1')).toHaveProperty(
      'value',
      '',
    );
  });
  it('selects a Screen from the item list without losing a filtered reply draft', () => {
    render(<ReviewGallery />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Write reply to thread 1' }),
    );
    fireEvent.change(screen.getByLabelText('Reply to thread 1'), {
      target: { value: 'Keep my draft.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Outdated 1' }));
    fireEvent.click(screen.getByRole('button', { name: /October replay/ }));
    expect(
      screen.getByRole('img', { name: 'October export replay' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /plan.md/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open 4' }));
    expect(screen.getByLabelText('Reply to thread 1')).toHaveProperty(
      'value',
      'Keep my draft.',
    );
  });
  it('creates a source quote with exact text, prefix and suffix from a markdown selection', async () => {
    const create = vi.fn();
    const { container } = render(
      <ReviewDocumentView
        draftScope="station-1:account-1:task-1:2026-10-25"
        artifact={plan}
        title="plan.md"
        text={text}
        threads={threads}
        onCreateThread={create}
      />,
    );
    expect(container.querySelector('mark')?.textContent).toBe(
      'half-even rounding',
    );
    selectText(container.querySelector('article')!, 'half-even rounding');
    if (screen.queryByRole('toolbar', { name: 'Selection actions' }))
      fireEvent.click(screen.getByRole('button', { name: 'Comment C' }));
    fireEvent.change(screen.getByLabelText('New comment'), {
      target: { value: 'Keep this rounding rule.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      {
        kind: 'text-quote',
        start: 41,
        end: 59,
        exact: 'half-even rounding',
        prefix: 'h\n\nRound each taxed line with **',
        suffix: '** before summing.\n\nRound `qty ×',
      },
      'Keep this rounding rule.',
      'half-even rounding',
    );
  });

  it('keeps source offsets when markdown escapes and entities change rendered length', async () => {
    const create = vi.fn();
    const source = 'Use &amp; rounding \\*rules\\* today.';
    const { container } = render(
      <ReviewDocumentView
        draftScope="station-1:account-1:task-1:2026-10-25"
        artifact={plan}
        title="plan.md"
        text={source}
        onCreateThread={create}
      />,
    );
    selectText(container.querySelector('article')!, 'rounding');
    if (screen.queryByRole('toolbar', { name: 'Selection actions' }))
      fireEvent.click(screen.getByRole('button', { name: 'Comment C' }));
    fireEvent.change(screen.getByLabelText('New comment'), {
      target: { value: 'Explain.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toEqual({
      kind: 'text-quote',
      start: 10,
      end: 18,
      exact: 'rounding',
      prefix: 'Use &amp; ',
      suffix: ' \\*rules\\* today.',
    });
  });

  it('bulk sends every sendable thread in the current filter, including a pending Sent follow-up', async () => {
    const send = vi.fn();
    const followUp = {
      ...thread('follow-up', 9, ['comment', 'sent', 'reply']),
      deliveryStatus: 'confirmed' as const,
    };
    const candidates = [...threads, followUp];
    render(
      <ReviewCommentsRail
        artifactKey="plan:plan"
        threads={candidates}
        counts={countThreads(candidates)}
        onSend={send}
        {...actions()}
      />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send 4' }));
    await waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(
        ['open-1', 'open-2', 'replied', 'follow-up'],
        'send',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Outdated 1' }));
    expect(screen.getByRole('button', { name: 'Send 0' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      within(screen.getByRole('article', { name: 'Thread 3' })).getByText(
        'Round the final total',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resolved 1' }));
    expect(screen.getByRole('button', { name: 'Send 0' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: 'All 7' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send 4' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenLastCalledWith(
      ['open-1', 'open-2', 'replied', 'follow-up'],
      'send',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Thread 9 actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Send' }));
    await waitFor(() =>
      expect(send).toHaveBeenLastCalledWith(['follow-up'], 'send'),
    );
  });

  it('keeps unknown freshness in Open, without claiming it is current', () => {
    render(
      <ReviewCommentsRail
        artifactKey="plan:plan"
        threads={[
          deriveThreadView(thread('unknown', 1), { status: 'unavailable' }),
        ]}
        counts={{ open: 1, outdated: 0, resolved: 0 }}
        filter="open"
        onFilterChange={vi.fn()}
        onSend={vi.fn()}
        {...actions()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open 1' })).toBeTruthy();
    expect(
      screen.getByRole('img', { name: 'Artifact freshness unavailable' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Outdated' })).toBeTruthy();
  });

  it('creates a normalized positive-area region using only the keyboard', async () => {
    const create = vi.fn();
    render(
      <ReviewImageView
        draftScope="station-1:account-1:task-1:2026-10-25"
        artifact={captureArtifact}
        src={screenSrc}
        alt="October replay"
        onSelectThread={vi.fn()}
        onCreateThread={create}
      />,
    );
    const target = screen.getByRole('button', { name: 'Place region pin' });
    target.focus();
    fireEvent.keyDown(target, { key: 'ArrowRight' });
    fireEvent.keyDown(target, { key: 'ArrowUp' });
    // JSDOM does not synthesize the native keyboard activation click.
    fireEvent.click(target, { detail: 0 });
    if (screen.queryByRole('toolbar', { name: 'Selection actions' }))
      fireEvent.click(screen.getByRole('button', { name: 'Comment C' }));
    fireEvent.change(screen.getByLabelText('New comment'), {
      target: { value: 'Check this total.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      { kind: 'region', x: 0.5, y: 0.45999999999999996, w: 0.04, h: 0.04 },
      'Check this total.',
    );
  });

  it('labels unverified gates as claimed, keeps a failed reply draft, and clears it only on success', async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(new Error('Reply unavailable'))
      .mockResolvedValueOnce(undefined);
    render(
      <ReviewThreadCard thread={threads[4]} {...actions()} onReply={reply} />,
    );
    expect(screen.getByText('October replay · claimed')).toBeTruthy();
    expect(screen.queryByText(/passed/)).toBeNull();
    expect(screen.getByText("Brian's agent")).toBeTruthy();
    expect(
      screen
        .getByTitle("Brian's agent")
        .querySelector('.task-room-avatar--agent')?.textContent,
    ).toBe('CC');
    expect(
      screen
        .getByTitle("Brian's agent")
        .querySelector('.review-avatar__starter')?.textContent,
    ).toBe('B');
    fireEvent.click(
      screen.getByRole('button', { name: 'Write reply to thread 5' }),
    );
    const draft = screen.getByLabelText('Reply to thread 5');
    fireEvent.change(draft, { target: { value: 'Please explain the gate.' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reply to thread 5' }),
    );
    await screen.findByRole('alert');
    expect(draft).toHaveProperty('value', 'Please explain the gate.');
    fireEvent.click(
      screen.getByRole('button', { name: 'Post reply to thread 5' }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText('Reply to thread 5')).toBeNull(),
    );
    expect(reply).toHaveBeenLastCalledWith(
      'replied',
      'Please explain the gate.',
    );
  });
});

function selectRendered(
  container: HTMLElement,
  exact: string,
  blockEndpoint = false,
) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    nodes.push(node as Text);
    node = walker.nextNode();
  }
  const rendered = nodes.map((node) => node.data).join('');
  const from = rendered.indexOf(exact);
  if (from < 0) throw new Error(`Selection missing: ${exact} in ${rendered}`);
  const range = document.createRange();
  let cursor = 0;
  for (const node of nodes) {
    if (from >= cursor && from < cursor + node.length)
      range.setStart(node, from - cursor);
    if (
      from + exact.length > cursor &&
      from + exact.length <= cursor + node.length
    )
      range.setEnd(node, from + exact.length - cursor);
    cursor += node.length;
  }
  if (blockEndpoint) {
    const block = container.querySelector('p')!;
    range.setEnd(block, block.childNodes.length);
  }
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(container);
}
async function postComment(body = 'Check the rounding rule.') {
  const commentAction = screen.queryByRole('button', { name: 'Comment C' });
  if (commentAction) fireEvent.click(commentAction);
  fireEvent.change(screen.getByLabelText('New comment'), {
    target: { value: body },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
}

describe('review regressions', () => {
  it.each([
    ['inline code', 'Round `qty * rate` today.', 'qty * rate', 'qty * rate'],
    [
      'list continuation',
      '- first line\n  continued here',
      'continued here',
      'continued here',
    ],
    [
      'multi-line blockquote',
      '> first line\n> next line',
      'first line\nnext line',
      'first line\n> next line',
    ],
    [
      'fenced code',
      '```ts\nconst total = 53553;\n```',
      'total = 53553',
      'total = 53553',
    ],
    [
      'block endpoint',
      'Round the total.',
      'Round the total.',
      'Round the total.',
    ],
    [
      'path mention',
      'Read src/invoice.ts today.',
      'src/invoice.ts',
      'src/invoice.ts',
    ],
    [
      'inline path',
      'Read `src/invoice.ts` today.',
      'src/invoice.ts',
      'src/invoice.ts',
    ],
    [
      'bold crossing',
      'Round **half-even** today.',
      'Round half-even today.',
      'Round **half-even** today.',
    ],
    [
      'list crossing',
      '- first line\n  continued here',
      'first line\ncontinued here',
      'first line\n  continued here',
    ],
    [
      'CRLF',
      'First\r\n\r\nRound the total.',
      'Round the total.',
      'Round the total.',
    ],
  ])(
    'maps %s through the real markdown renderer and retains the displayed quote',
    async (kind, source, rendered, raw) => {
      const create = vi.fn();
      const { container } = render(
        <ReviewDocumentView
          draftScope="station-1:account-1:task-1:2026-10-25"
          artifact={plan}
          title="plan.md"
          text={source}
          onCreateThread={create}
        />,
      );
      selectRendered(
        container.querySelector('article')!,
        rendered,
        kind === 'block endpoint',
      );
      if (kind === 'path mention' || kind === 'inline path')
        expect(
          screen.queryByRole('link', { name: 'src/invoice.ts' }),
        ).toBeNull();
      await postComment();
      await waitFor(() => expect(create).toHaveBeenCalledOnce());
      const [anchor, , quote] = create.mock.calls[0];
      expect(anchor.exact).toBe(raw);
      expect(
        source.replace(/\r\n?/g, '\n').slice(anchor.start, anchor.end),
      ).toBe(raw);
      expect(quote).toBe(rendered);
    },
  );

  it('makes text comments reachable with keyboard selection and C', async () => {
    const create = vi.fn();
    const { container } = render(
      <ReviewDocumentView
        draftScope="station-1:account-1:task-1:2026-10-25"
        artifact={plan}
        title="plan.md"
        text="Round the total."
        onCreateThread={create}
      />,
    );
    const article = container.querySelector('article')!;
    article.focus();
    expect(document.activeElement).toBe(article);
    const range = document.createRange();
    range.selectNodeContents(article.querySelector('p')!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(article, { key: 'c' });
    expect(screen.getByLabelText('New comment')).toBeTruthy();
    await postComment();
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
  });

  it('refuses a stale document selection and keeps its draft', async () => {
    const create = vi.fn();
    const props = { artifact: plan, title: 'plan.md', onCreateThread: create };
    const { container, rerender } = render(
      <ReviewDocumentView
        draftScope="station-1:account-1:task-1:2026-10-25"
        {...props}
        text="Round the total."
      />,
    );
    selectRendered(container.querySelector('article')!, 'the total');
    fireEvent.click(screen.getByRole('button', { name: 'Comment C' }));
    fireEvent.change(screen.getByLabelText('New comment'), {
      target: { value: 'Use each line.' },
    });
    rerender(
      <ReviewDocumentView
        draftScope="station-1:account-1:task-1:2026-10-25"
        {...props}
        text="Round each line."
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Document changed. Select text again.',
    );
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByLabelText('New comment')).toHaveProperty(
      'value',
      'Use each line.',
    );
  });

  it('highlights only mapped unresolved ranges and links them to the card', () => {
    const source = 'Use &amp; rounding today.';
    const good = {
      ...thread('highlight', 1),
      anchor: {
        kind: 'text-quote',
        start: 10,
        end: 18,
        exact: 'rounding',
        prefix: '',
        suffix: '',
      } as const,
    };
    const insideEntity = {
      ...thread('entity', 2),
      anchor: {
        kind: 'text-quote',
        start: 6,
        end: 9,
        exact: 'amp',
        prefix: '',
        suffix: '',
      } as const,
    };
    const resolved = {
      ...thread('resolved-highlight', 3, ['comment', 'resolved']),
      anchor: {
        kind: 'text-quote',
        start: 19,
        end: 24,
        exact: 'today',
        prefix: '',
        suffix: '',
      } as const,
    };
    const select = vi.fn();
    const { container } = render(
      <>
        <ReviewDocumentView
          draftScope="station-1:account-1:task-1:2026-10-25"
          artifact={plan}
          title="plan.md"
          text={source}
          threads={[good, insideEntity, resolved]}
          onCreateThread={vi.fn()}
          onSelectThread={select}
        />
        <ReviewThreadCard thread={good} {...actions()} />
      </>,
    );
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('rounding');
    expect(marks[0].tabIndex).toBe(0);
    fireEvent.click(marks[0]);
    expect(select).toHaveBeenCalledWith('highlight');
    expect(document.activeElement).toBe(
      screen.getByRole('article', { name: 'Thread 1' }),
    );
  });

  it('dispatches Resolve and Reopen to different callbacks and collapses resolved threads', async () => {
    const callbacks = actions();
    const { rerender } = render(
      <ReviewThreadCard thread={threads[0]} {...callbacks} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve thread 1' }));
    await waitFor(() =>
      expect(callbacks.onResolve).toHaveBeenCalledWith('open-1'),
    );
    expect(callbacks.onReopen).not.toHaveBeenCalled();
    rerender(<ReviewThreadCard thread={threads[5]} {...callbacks} />);
    expect(
      screen.queryByRole('button', { name: 'Write reply to thread 6' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reopen thread 6' }));
    await waitFor(() =>
      expect(callbacks.onReopen).toHaveBeenCalledWith('resolved'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Expand resolved thread 6' }),
    );
    expect(
      screen.getByText('Keep the untaxed hosting line unchanged.'),
    ).toBeTruthy();
  });

  it('focuses the reply, reports expanded state and restores focus on cancel or Esc', () => {
    render(<ReviewThreadCard thread={threads[0]} {...actions()} />);
    const trigger = screen.getByRole('button', {
      name: 'Write reply to thread 1',
    });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(
      screen.getByLabelText('Reply to thread 1'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel reply to thread 1' }),
    );
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    const input = screen.getByLabelText('Reply to thread 1');
    fireEvent.change(input, { target: { value: 'Discard me' } });
    expect(screen.getByText('draft saved')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByLabelText('Reply to thread 1')).toBeNull();
  });

  it('distinguishes claimed and verified commit chips and opens the supplied evidence', () => {
    const open = vi.fn();
    const replied = threads[4];
    const { rerender } = render(
      <ReviewThreadCard
        thread={replied}
        {...actions()}
        onOpenEvidence={open}
      />,
    );
    const verified = screen.getByRole('button', { name: '7c04e1d' });
    fireEvent.click(verified);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ commitVerified: true }),
    );
    const unverified = {
      ...replied,
      events: replied.events.map((event) =>
        event.kind === 'agent-reply'
          ? {
              ...event,
              evidence: {
                ...event.evidence,
                commitVerified: false,
                gateVerified: event.evidence?.gateVerified ?? false,
              },
            }
          : event,
      ),
    };
    rerender(
      <ReviewThreadCard
        thread={unverified}
        {...actions()}
        onOpenEvidence={open}
      />,
    );
    expect(
      screen.getByRole('button', { name: '7c04e1d · claimed' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: '7c04e1d' })).toBeNull();
  });

  it('maps mouse pins in image coordinates and refuses other-capture or malformed pins', async () => {
    const create = vi.fn();
    render(
      <ReviewImageView
        draftScope="station-1:account-1:task-1:2026-10-25"
        artifact={captureArtifact}
        capture={capture}
        src={screenSrc}
        alt="Replay"
        threads={[
          captureThread,
          {
            ...captureThread,
            threadId: 'other',
            ordinal: 8,
            artifact: { ...captureArtifact, id: 'screen-2' },
          },
          {
            ...captureThread,
            threadId: 'bad',
            ordinal: 9,
            anchor: { kind: 'region', x: 0.99, y: 0.5, w: 0.2, h: 0.1 },
          },
          {
            ...captureThread,
            threadId: 'resolved-pin',
            ordinal: 10,
            baseState: 'resolved',
            state: 'resolved',
          },
        ]}
        onSelectThread={vi.fn()}
        onCreateThread={create}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open thread 7' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open thread 8' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open thread 9' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open thread 10' })).toBeNull();
    expect(screen.getByTitle(capture.commit).textContent).toBe('7c04e1d');
    const target = screen.getByRole('button', { name: 'Place region pin' });
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      width: 800,
      height: 400,
    } as DOMRect);
    fireEvent.click(target, { detail: 1, clientX: 300, clientY: 350 });
    await postComment();
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toEqual({
      kind: 'region',
      x: 0.23,
      y: 0.73,
      w: 0.04,
      h: 0.04,
    });
  });

  it('uses server projections and counts, provides send modes, and copies when send is unavailable', async () => {
    const send = vi.fn(),
      copy = vi.fn();
    const props = {
      artifactKey: 'plan:plan',
      threads: [
        {
          ...threads[0],
          baseState: 'agent-replied' as const,
          state: 'agent-replied' as const,
        },
      ],
      counts: { open: 9, outdated: 3, resolved: 2 },
      filter: 'open' as const,
      onFilterChange: vi.fn(),
      ...actions(),
    };
    const { rerender } = render(
      <ReviewCommentsRail {...props} onSend={send} />,
    );
    expect(screen.getByRole('button', { name: 'Open 9' })).toBeTruthy();
    expect(screen.getByText('Replied')).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Choose send mode' })[0],
    );
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'Send + Resolve' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send + Resolve 1' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(['open-1'], 'send-and-resolve'),
    );
    rerender(<ReviewCommentsRail {...props} onCopyForAgent={copy} />);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Copy for agent' })[0],
    );
    await waitFor(() => expect(copy).toHaveBeenCalledWith(['open-1']));
  });
});

it('keeps item, Open filter and outline counts aligned and hides zero counts', () => {
  const { container } = render(
    <TaskReviewLayout
      items={
        <ReviewItemList
          items={items}
          selectedKind="plan"
          selectedItemId="plan"
          onSelectItem={vi.fn()}
        />
      }
      content={
        <ReviewDocumentView
          draftScope="counts"
          artifact={{ ...plan, revision: 'v3' }}
          text={text}
          title="plan.md"
          threads={threads}
          onCreateThread={vi.fn()}
        />
      }
      comments={
        <ReviewCommentsRail
          artifactKey="plan"
          threads={threads}
          counts={countThreads(threads)}
          {...actions()}
        />
      }
    />,
  );
  const itemList = screen.getByRole('navigation', { name: 'Review items' });
  const item = within(itemList).getByRole('button', {
    name: 'plan.md, 4 open threads',
  });
  expect(item.getAttribute('aria-current')).toBe('true');
  expect(
    within(itemList)
      .getByRole('button', { name: 'Brief' })
      .querySelector('.review-count'),
  ).toBeNull();
  const outline = within(itemList).getByRole('navigation', {
    name: 'Document outline',
  });
  expect(
    [...outline.querySelectorAll('.review-count')].reduce(
      (sum, node) => sum + Number(node.textContent),
      0,
    ),
  ).toBe(4);
  expect(screen.getByRole('button', { name: 'Open 4' })).toBeTruthy();
  fireEvent.click(
    within(outline).getByRole('button', { name: 'Verify, 1 open threads' }),
  );
  expect(document.activeElement).toBe(
    container.querySelector('h2:last-of-type'),
  );
});

it('remembers filters per artifact, preserves saved drafts across remounts, and supports hotkeys', async () => {
  render(<ReviewGallery />);
  const documentView = screen.getByRole('article', { name: 'plan.md content' });
  documentView.focus();
  fireEvent.keyDown(documentView, { key: 'j' });
  expect(document.activeElement).toBe(
    screen.getByRole('article', { name: 'Thread 1' }),
  );
  fireEvent.keyDown(document.activeElement!, { key: 'j' });
  expect(document.activeElement).toBe(
    screen.getByRole('article', { name: 'Thread 2' }),
  );
  fireEvent.keyDown(document.activeElement!, { key: 'k' });
  expect(document.activeElement).toBe(
    screen.getByRole('article', { name: 'Thread 1' }),
  );
  fireEvent.keyDown(documentView, { key: 'c', code: 'KeyC', altKey: true });
  await waitFor(() =>
    expect(screen.getByLabelText('Last review action').textContent).toBe(
      'send:open-1,open-2,replied',
    ),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Write reply to thread 1' }),
  );
  fireEvent.change(screen.getByLabelText('Reply to thread 1'), {
    target: { value: 'Keep this draft.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Outdated 1' }));
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Review items' })).getByRole(
      'button',
      { name: /October replay/ },
    ),
  );
  expect(
    screen.getByRole('button', { name: 'Open 1' }).getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Review items' })).getByRole(
      'button',
      { name: /plan.md/ },
    ),
  );
  expect(
    screen
      .getByRole('button', { name: 'Outdated 1' })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Open 4' }));
  expect(screen.getByLabelText('Reply to thread 1')).toHaveProperty(
    'value',
    'Keep this draft.',
  );
});

it('quotes the selection in the composer and submits a saved comment with Command-Enter', async () => {
  const create = vi.fn();
  const { container } = render(
    <ReviewDocumentView
      draftScope="station-1:account-1:task-1:2026-10-25"
      artifact={plan}
      title="plan.md"
      text="Round the total."
      onCreateThread={create}
    />,
  );
  const article = container.querySelector('article')!;
  selectRendered(article, 'the total');
  expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Comment C' }));
  const dialog = screen.getByRole('dialog', { name: 'New review comment' });
  expect(dialog.querySelector('blockquote')?.textContent).toBe('the total');
  const input = screen.getByLabelText('New comment');
  fireEvent.change(input, { target: { value: 'Keep the tax precision.' } });
  expect(screen.getByText('draft saved')).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  await waitFor(() =>
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ exact: 'the total' }),
      'Keep the tax precision.',
      'the total',
    ),
  );
});

it('shows queued and unconfirmed delivery distinctly and retries failed sends', async () => {
  const send = vi.fn();
  const props = {
    ...actions(),
    onSend: send,
    delivery: { agentName: 'Claude Code', working: true },
  };
  const { rerender } = render(
    <ReviewThreadCard thread={threads[3]} {...props} />,
  );
  expect(screen.getByText('Queued').getAttribute('title')).toBe(
    'Queued: agent is working',
  );
  rerender(
    <ReviewThreadCard
      thread={{ ...threads[3], deliveryStatus: 'unconfirmed' }}
      {...props}
    />,
  );
  expect(screen.getByText('Unconfirmed')).toBeTruthy();
  expect(screen.queryByText('Queued')).toBeNull();
  rerender(
    <ReviewThreadCard
      thread={thread('failed', 8, ['comment', 'sent', 'send-failed'])}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(['failed'], 'send'));
  rerender(
    <ReviewThreadCard
      thread={{
        ...thread('failed', 8, ['comment', 'sent', 'send-failed', 'sent']),
        deliveryStatus: 'confirmed',
      }}
      {...props}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(screen.queryByText('Delivery failed')).toBeNull();
  expect(screen.getByText('Queued').getAttribute('title')).toBe(
    'Queued: agent is working',
  );
});

it('clamps the selection composer inside the viewport near its bottom-right edge', () => {
  const { container } = render(
    <ReviewDocumentView
      draftScope="task-geometry"
      artifact={plan}
      title="plan.md"
      text="Round the total."
      onCreateThread={vi.fn()}
    />,
  );
  const article = container.querySelector('article')!;
  const range = document.createRange();
  range.selectNodeContents(article.querySelector('p')!);
  Object.defineProperty(range, 'getBoundingClientRect', {
    value: () => ({ left: 10000, bottom: 10000 }),
  });
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  fireEvent.mouseUp(article);
  fireEvent.click(screen.getByRole('button', { name: 'Comment C' }));
  const panel = screen.getByRole('dialog', { name: 'New review comment' });
  expect(panel.style.getPropertyValue('--review-left')).toBe(
    `${window.innerWidth - 368}px`,
  );
  expect(panel.style.getPropertyValue('--review-top')).toBe(
    `${window.innerHeight - 240}px`,
  );
});

it('keeps comment drafts separate for different Station/account/Task scopes', () => {
  const props = {
    artifact: plan,
    title: 'plan.md',
    text: 'Round the total.',
    onCreateThread: vi.fn(),
  };
  const { container, rerender } = render(
    <ReviewDocumentView {...props} draftScope="account-A:task-A" />,
  );
  selectRendered(container.querySelector('article')!, 'the total');
  fireEvent.click(screen.getByRole('button', { name: 'Comment C' }));
  fireEvent.change(screen.getByLabelText('New comment'), {
    target: { value: 'Only for task A.' },
  });
  rerender(<ReviewDocumentView {...props} draftScope="account-B:task-B" />);
  expect(screen.getByLabelText('New comment')).toHaveProperty('value', '');
});

it('opens a block comment with C from the focused document without a pointer selection', async () => {
  const create = vi.fn();
  const { container } = render(
    <ReviewDocumentView
      draftScope="keyboard-task"
      artifact={plan}
      title="plan.md"
      text="Round the total."
      onCreateThread={create}
    />,
  );
  const article = container.querySelector('article')!;
  article.focus();
  fireEvent.keyDown(article, { key: 'c' });
  await postComment();
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      { kind: 'block', startLine: 1, endLine: 1 },
      'Check the rounding rule.',
      'Round the total.',
    ),
  );
});

it('keeps a document link click separate from block comment creation', () => {
  render(
    <ReviewDocumentView
      draftScope="link-task"
      artifact={plan}
      title="plan.md"
      text="[Jump to verification](#verification)"
      onCreateThread={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Jump to verification' }));
  expect(
    screen.queryByRole('toolbar', { name: 'Selection actions' }),
  ).toBeNull();
});

it('partitions persisted reply drafts by the current account scope', () => {
  const props = { thread: threads[0], ...actions() };
  const { rerender } = render(
    <ReviewThreadCard {...props} draftScope="account-A" />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Write reply to thread 1' }),
  );
  fireEvent.change(screen.getByLabelText('Reply to thread 1'), {
    target: { value: 'Private draft for account A.' },
  });
  rerender(<ReviewThreadCard {...props} draftScope="account-B" />);
  expect(screen.getByLabelText('Reply to thread 1')).toHaveProperty(
    'value',
    '',
  );
  rerender(<ReviewThreadCard {...props} draftScope="account-A" />);
  expect(screen.getByLabelText('Reply to thread 1')).toHaveProperty(
    'value',
    'Private draft for account A.',
  );
});

it('copies a standalone thread with artifact context when an agent cannot receive it', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  try {
    render(<ReviewThreadCard thread={threads[0]} {...actions()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thread 1 actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy for agent' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain('plan:plan @ v2');
    expect(writeText.mock.calls[0][0]).toContain('Thread 1 (open-1)');
    expect(writeText.mock.calls[0][0]).toContain(
      'ERP rounds half-up on the sum.',
    );
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

it('prevents a second reopen while the collapsed thread action is pending', async () => {
  const resolutions: { resolve: () => void }[] = [];
  const reopen = vi.fn(
    () => new Promise<void>((resolve) => resolutions.push({ resolve })),
  );
  render(
    <ReviewThreadCard thread={threads[5]} {...actions()} onReopen={reopen} />,
  );
  const button = screen.getByRole('button', { name: 'Reopen thread 6' });
  fireEvent.click(button);
  expect(button.hasAttribute('disabled')).toBe(true);
  fireEvent.click(button);
  expect(reopen).toHaveBeenCalledOnce();
  await act(async () => resolutions[0].resolve());
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
});

it('hides default state and body-inferred verdict chips while showing the projected non-default state', () => {
  const approved = {
    ...threads[0],
    events: [{ ...threads[0].events[0], body: 'Approved.' }],
  };
  const { rerender } = render(
    <ReviewThreadCard thread={approved} {...actions()} />,
  );
  const card = screen.getByRole('article', { name: 'Thread 1' });
  expect(within(card).queryByText('Open')).toBeNull();
  expect(within(card).queryByText('Approve')).toBeNull();
  expect(within(card).getByText('Approved.')).toBeTruthy();
  rerender(<ReviewThreadCard thread={threads[4]} {...actions()} />);
  expect(screen.getByText('Replied')).toBeTruthy();
});

it('pairs a card and its pin on hover and focus, and opens the matching numbered card', () => {
  const select = vi.fn();
  render(
    <TaskReviewLayout
      items={null}
      content={
        <ReviewImageView
          draftScope="pair"
          artifact={captureArtifact}
          src={screenSrc}
          alt="Invoice"
          threads={[captureThread]}
          onSelectThread={select}
          onCreateThread={vi.fn()}
        />
      }
      comments={<ReviewThreadCard thread={captureThread} {...actions()} />}
    />,
  );
  const card = screen.getByRole('article', { name: 'Thread 7' });
  const pin = screen.getByRole('button', { name: 'Open thread 7' });
  expect(within(card).getByText('#7')).toBeTruthy();
  expect(pin.getAttribute('aria-controls')).toBe(card.id);
  fireEvent.mouseEnter(card);
  expect(pin.getAttribute('data-review-emphasized')).toBe('true');
  fireEvent.mouseLeave(card);
  expect(pin.hasAttribute('data-review-emphasized')).toBe(false);
  fireEvent.mouseEnter(pin);
  expect(card.getAttribute('data-review-emphasized')).toBe('true');
  fireEvent.mouseLeave(pin);
  act(() => pin.focus());
  expect(card.getAttribute('data-review-emphasized')).toBe('true');
  fireEvent.click(pin);
  expect(select).toHaveBeenCalledWith('capture-thread');
  expect(document.activeElement).toBe(card);
});

it('derives the revision transition from artifact metadata even with no threads', () => {
  render(
    <ReviewDocumentView
      draftScope="revision"
      artifact={{ ...plan, revision: 'v3' }}
      previousArtifact={plan}
      title="plan.md"
      text={text}
      threads={[]}
      onCreateThread={vi.fn()}
    />,
  );
  expect(screen.getByText('v2 → v3')).toBeTruthy();
});
