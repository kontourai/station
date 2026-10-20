/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ToolCallBatch } from '../components/chat/ToolCallBatch';
import { ToolCallDisplay } from '../components/chat/ToolCallDisplay';
import {
  splitToolCallRuns,
  type ToolCallLike,
  type ToolCallRun,
} from '../components/chat/tool-call-runs';

function runFor(parts: ToolCallLike[]): ToolCallRun {
  const [block] = splitToolCallRuns(parts);
  if (block?.type !== 'tool-call-run') {
    throw new Error('expected a tool-call run');
  }
  return block;
}

// The production renderer, so the sheet's rows are real rows.
const renderCall = (part: ToolCallLike, index: number) => (
  <ToolCallDisplay key={index} toolCall={part as never} />
);

const command = (
  id: string,
  state: string,
  extra: Partial<ToolCallLike> = {},
): ToolCallLike => ({
  type: 'tool-invocation',
  toolCallId: id,
  toolName: 'Bash',
  args: { command: `step ${id}` },
  state,
  ...(state === 'completed' ? { result: 'ok' } : {}),
  ...extra,
});

const summaryButton = () =>
  document.querySelector('button.tool-call-batch__summary') as HTMLElement;
const childRows = () =>
  [
    ...document.querySelectorAll<HTMLElement>(
      '.tool-call-batch__slot[data-open="true"] .tool-call-batch__child:not(.tool-call-batch__child--leaving)',
    ),
  ].filter((row) => row.dataset.toolCallId);

afterEach(() => {
  vi.useRealTimers();
});

describe('ToolCallBatch — live child rows', () => {
  test('a running batch is a stable summary plus one highlighted row per running call', () => {
    render(
      <ToolCallBatch
        run={runFor([
          command('a', 'completed'),
          command('b', 'completed'),
          command('c', 'completed'),
          command('d', 'running'),
        ])}
        renderCall={renderCall}
      />,
    );
    expect(summaryButton().textContent).toContain('4 commands · 3 done');
    // Nothing is past tense until every call settled.
    expect(summaryButton().textContent).not.toContain('Ran');
    const rows = childRows();
    expect(rows.map((row) => row.dataset.toolCallId)).toEqual(['d']);
    const label = rows[0]!.querySelector('.tool-call__label');
    expect(label?.textContent).toBe('Running step d');
    expect(label?.className).toContain('tool-call__label--active');
    // The summary itself is not a call and does not animate.
    expect(
      summaryButton().querySelector('.tool-call__label--active'),
    ).toBeNull();
  });

  test('shows at most two running calls, then how many more', () => {
    render(
      <ToolCallBatch
        run={runFor([
          command('a', 'running'),
          command('b', 'running'),
          command('c', 'running'),
          command('d', 'running'),
        ])}
        renderCall={renderCall}
      />,
    );
    expect(childRows().map((row) => row.dataset.toolCallId)).toEqual([
      'a',
      'b',
    ]);
    for (const row of childRows()) {
      expect(row.querySelector('.tool-call__label--active')).not.toBeNull();
    }
    expect(screen.getByText('+2 more')).toBeTruthy();
  });

  test('a failure badge shows while siblings still run', () => {
    render(
      <ToolCallBatch
        run={runFor([
          command('a', 'error', { error: 'exit 1' }),
          command('b', 'running'),
        ])}
        renderCall={renderCall}
      />,
    );
    expect(screen.getByText('1 failed')).toBeTruthy();
    expect(childRows().map((row) => row.dataset.toolCallId)).toEqual(['b']);
  });

  test('the next command crossfades into the same slot; the summary keeps its words', () => {
    const view = render(
      <ToolCallBatch
        run={runFor([command('a', 'running'), command('b', 'call')])}
        renderCall={renderCall}
      />,
    );
    view.rerender(
      <ToolCallBatch
        run={runFor([command('a', 'completed'), command('b', 'running')])}
        renderCall={renderCall}
      />,
    );
    expect(summaryButton().textContent).toContain('2 commands · 1 done');
    const slot = document.querySelector('.tool-call-batch__slot')!;
    expect(slot.getAttribute('data-open')).toBe('true');
    const leaving = slot.querySelector('.tool-call-batch__child--leaving');
    const entering = slot.querySelector('.tool-call-batch__child--entering');
    expect(leaving?.getAttribute('aria-hidden')).toBe('true');
    expect(leaving?.querySelector('.tool-call__label--active')).toBeNull();
    expect(entering?.getAttribute('data-tool-call-id')).toBe('b');
    // The outgoing row is removed when its fade ends. jsdom has no
    // AnimationEvent, so React listens for the prefixed name there.
    fireEvent(leaving!, new Event('webkitAnimationEnd', { bubbles: true }));
    expect(slot.querySelector('.tool-call-batch__child--leaving')).toBeNull();
  });

  test('a settled batch reads in the past tense and its live rows close', () => {
    const view = render(
      <ToolCallBatch
        run={runFor([command('a', 'completed'), command('b', 'running')])}
        renderCall={renderCall}
      />,
    );
    view.rerender(
      <ToolCallBatch
        run={runFor([command('a', 'completed'), command('b', 'completed')])}
        renderCall={renderCall}
      />,
    );
    expect(summaryButton().textContent).toContain('Ran 2 commands');
    expect(summaryButton().textContent).not.toContain('done');
    expect(
      document.querySelectorAll('.tool-call-batch__slot[data-open="true"]'),
    ).toHaveLength(0);
    // The closing slot keeps its last row for the height transition, but it
    // is hidden and no longer animates.
    expect(document.querySelector('.tool-call__label--active')).toBeNull();
    expect(
      document
        .querySelector('.tool-call-batch__slot')
        ?.getAttribute('aria-hidden'),
    ).toBe('true');
  });

  test('every running call is highlighted in the opened list too', async () => {
    render(
      <ToolCallBatch
        run={runFor([
          command('a', 'completed'),
          command('b', 'running'),
          command('c', 'running'),
        ])}
        renderCall={renderCall}
      />,
    );
    fireEvent.click(summaryButton());
    const sheet = await screen.findByRole('dialog');
    const active = sheet.querySelectorAll('.tool-call__label--active');
    expect([...active].map((label) => label.textContent)).toEqual([
      'Running step b',
      'Running step c',
    ]);
  });

  test('a running row shows its elapsed time only after ten seconds', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
    render(
      <ToolCallBatch
        run={runFor([
          command('a', 'running', {
            startedAt: '2026-10-20T11:59:57.000Z',
          }),
          command('b', 'running', {
            startedAt: '2026-10-20T11:59:30.000Z',
          }),
        ])}
        renderCall={renderCall}
      />,
    );
    const elapsed = (id: string) =>
      document
        .querySelector(`.tool-call-batch__child[data-tool-call-id="${id}"]`)
        ?.querySelector('.tool-call__elapsed')?.textContent ?? null;
    expect(elapsed('a')).toBeNull();
    expect(elapsed('b')).toBe('30s');
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    expect(elapsed('a')).toBe('11s');
    expect(elapsed('b')).toBe('38s');
  });
});
