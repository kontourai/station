/**
 * @vitest-environment jsdom
 *
 * (archive#1783). `HOME_LIFECYCLE_LABELS` is shared, and this
 * sheet renders `lifecycleLabel` as RAW TEXT — so adding `'Unanswerable'` for
 * the Home row put the wire enum straight into a user-facing line here
 * ("Current · Unanswerable"), with none of the basis, while the Home row two
 * files over carried both. Same label, two answers, one of them a bare
 * adjective.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { MobileTaskSwitcher } from '../components/chat-dock/MobileTaskSwitcher';
import type { HomeWorkItem } from '../views/home/home-view-model';

const NOTICE =
  "Unanswerable by the serving Station (no adapter for provider 'acme') — observed by station-7f3a at 2026-08-03T12:04:03.000Z.";

function task(overrides: Partial<HomeWorkItem> = {}): HomeWorkItem {
  return {
    id: 'chat:stranded',
    kind: 'chat',
    kindLabel: 'Direct chat',
    title: 'Draft the release note',
    projectLabel: 'Station',
    agentLabel: 'Claude Code',
    modelLabel: 'Sonnet',
    lifecycleLabel: 'Unanswerable',
    unanswerableNotice: NOTICE,
    updatedAt: Date.now(),
    chatSessionId: 'stranded',
    ...overrides,
  };
}

function renderSheet(tasks: HomeWorkItem[], pending = false) {
  return render(
    <MobileTaskSwitcher
      open
      tasks={tasks}
      pending={pending}
      activeChatSessionId={null}
      visualViewportStyle={{}}
      triggerRef={createRef<HTMLButtonElement>()}
      onClose={vi.fn()}
      onFocusChat={vi.fn()}
      onOpenConversation={vi.fn()}
      onOpenSession={vi.fn()}
      now={Date.now()}
    />,
  );
}

describe('MobileTaskSwitcher answerability basis', () => {
  test('reports pending reads instead of claiming there are no chats', () => {
    renderSheet([], true);
    expect(
      screen
        .getByRole('status', { name: 'Loading chats and tasks' })
        .getAttribute('aria-busy'),
    ).toBe('true');
    expect(screen.queryByText('No chats yet.')).toBeNull();
  });

  test('claims the settled empty state only after pending clears', () => {
    renderSheet([]);
    expect(screen.getByText('No chats yet.')).toBeTruthy();
  });

  test('a failed read offers retry instead of claiming the list is empty', () => {
    const retry = vi.fn();
    render(
      <MobileTaskSwitcher
        open
        tasks={[]}
        loadError
        onRetryLoad={retry}
        activeChatSessionId={null}
        visualViewportStyle={{}}
        triggerRef={createRef<HTMLButtonElement>()}
        onClose={vi.fn()}
        onFocusChat={vi.fn()}
        onOpenConversation={vi.fn()}
        onOpenSession={vi.fn()}
      />,
    );
    expect(screen.queryByText('No chats yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  test('renders the observation, not just the label', () => {
    renderSheet([task()]);
    // The shared inbox row (archive#3312) carries the observation
    // under the shared testid — one anatomy, one hook, both hosts.
    const notice = screen.getByTestId('inbox-row-answerability').textContent;
    expect(notice).toContain("no adapter for provider 'acme'");
    expect(notice).toContain('station-7f3a');
    expect(notice).toContain('2026-08-03T12:04:03.000Z');
  });

  test('translates the label instead of leaking the wire enum', () => {
    renderSheet([task()]);
    expect(screen.getByText('Elsewhere')).toBeTruthy();
    expect(screen.queryByText('Unanswerable')).toBeNull();
  });

  test('control: an ordinary row is untouched and unannotated', () => {
    renderSheet([
      task({
        id: 'chat:live',
        lifecycleLabel: 'Running',
        unanswerableNotice: undefined,
      }),
    ]);
    expect(screen.queryByTestId('inbox-row-answerability')).toBeNull();
    // The shared row renders ONE status line (#3043). Its word is the lane's
    // word, "Running" (never "Active"), and it appears once.
    const row = screen.getByTestId('inbox-row');
    expect(
      within(row).getByText('Running', { selector: '.inbox-row__word' }),
    ).toBeTruthy();
    expect(within(row).getAllByText('Running')).toHaveLength(1);
    expect(within(row).queryByText('Active')).toBeNull();
    expect(screen.getByRole('heading', { name: /^Running/ })).toBeTruthy();
  });
});

describe('MobileTaskSwitcher lane-move focus', () => {
  test('a focused row that moves Running -> Idle keeps focus in the sheet', () => {
    const props = {
      open: true,
      activeChatSessionId: null,
      visualViewportStyle: {},
      triggerRef: createRef<HTMLButtonElement>(),
      onClose: vi.fn(),
      onFocusChat: vi.fn(),
      onOpenConversation: vi.fn(),
      onOpenSession: vi.fn(),
      now: Date.now(),
    };
    const running = task({
      id: 'chat:moving',
      chatSessionId: 'moving',
      title: 'Moving row',
      lifecycleLabel: 'Running',
      unanswerableNotice: undefined,
    });
    const other = task({
      id: 'chat:other',
      chatSessionId: 'other',
      title: 'Other row',
      lifecycleLabel: 'Ready',
      unanswerableNotice: undefined,
    });
    const view = render(
      <MobileTaskSwitcher {...props} tasks={[running, other]} />,
    );
    const name = 'Moving row, Station';
    screen.getByRole('button', { name }).focus();
    expect(document.activeElement).toBe(screen.getByRole('button', { name }));

    view.rerender(
      <MobileTaskSwitcher
        {...props}
        tasks={[{ ...running, lifecycleLabel: 'Ready' }, other]}
      />,
    );
    expect(screen.queryByRole('heading', { name: /^Running/ })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name }));
  });
});
