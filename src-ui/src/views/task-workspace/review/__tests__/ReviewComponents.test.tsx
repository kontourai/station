/** @vitest-environment jsdom */

import type { TaskReviewFilter } from '@kontourai/station-contracts/task-review';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigationStore } from '../../../../contexts/navigation-store';
import { ReviewCommentsRail } from '../ReviewCommentsRail';
import { ReviewDocumentView } from '../ReviewDocumentView';
import { ReviewImageView } from '../ReviewImageView';
import { ReviewThreadCard } from '../ReviewThreadCard';
import { ReviewGallery } from './ReviewGallery';
import {
  currentArtifact,
  plan,
  screenSrc,
  text,
  thread,
  threads,
} from './review-fixtures';

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

const actions = () => ({
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
    render(
      <ReviewThreadCard
        thread={threads[0]}
        current={currentArtifact(plan)}
        {...actions()}
      />,
    );
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
    fireEvent.click(screen.getByRole('button', { name: 'October replay' }));
    expect(
      screen.getByRole('img', { name: 'October export replay' }),
    ).toBeTruthy();
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
        suffix: '** before summing.\n\n## Test case',
      },
      'Keep this rounding rule.',
    );
  });

  it('keeps source offsets when markdown escapes and entities change rendered length', async () => {
    const create = vi.fn();
    const source = 'Use &amp; rounding \\*rules\\* today.';
    const { container } = render(
      <ReviewDocumentView
        artifact={plan}
        title="plan.md"
        text={source}
        onCreateThread={create}
      />,
    );
    selectText(container.querySelector('article')!, 'rounding');
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

  it('derives filter counts and sends exactly the selected actionable open threads', () => {
    const send = vi.fn();
    function Rail() {
      const [filter, setFilter] = useState<TaskReviewFilter>('open');
      const [selected, setSelected] = useState<readonly string[]>([
        'open-1',
        'open-2',
        'old',
        'sent',
        'resolved',
        'missing',
        'open-1',
      ]);
      return (
        <ReviewCommentsRail
          threads={threads}
          currentArtifact={currentArtifact}
          filter={filter}
          onFilterChange={setFilter}
          selectedThreadIds={selected}
          onSelectionChange={setSelected}
          onSend={send}
          {...actions()}
        />
      );
    }
    render(<Rail />);
    expect(screen.getByRole('button', { name: 'Open 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Outdated 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resolved 1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send 2' }));
    expect(send).toHaveBeenCalledWith(['open-1', 'open-2']);
    fireEvent.click(screen.getByLabelText('Select thread 1'));
    fireEvent.click(screen.getByLabelText('Select thread 2'));
    expect(
      screen.getByRole('button', { name: 'Send 0' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Outdated 1' }));
    expect(
      within(screen.getByRole('article', { name: 'Thread 3' })).getByText(
        'Round the final total',
      ),
    ).toBeTruthy();
  });

  it('keeps unknown freshness in Open, without claiming it is current', () => {
    render(
      <ReviewCommentsRail
        threads={[thread('unknown', 1)]}
        currentArtifact={() => ({ status: 'unavailable' })}
        filter="open"
        onFilterChange={vi.fn()}
        selectedThreadIds={[]}
        onSelectionChange={vi.fn()}
        onSend={vi.fn()}
        {...actions()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open 1' })).toBeTruthy();
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Outdated 0' })).toBeTruthy();
  });

  it('creates a normalized positive-area region using only the keyboard', async () => {
    const create = vi.fn();
    render(
      <ReviewImageView
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
      <ReviewThreadCard
        thread={threads[4]}
        current={currentArtifact(plan)}
        {...actions()}
        onReply={reply}
      />,
    );
    expect(screen.getByText('October replay · claimed')).toBeTruthy();
    expect(screen.queryByText(/passed/)).toBeNull();
    expect(screen.getByText('Started by Brian')).toBeTruthy();
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
