/**
 * @vitest-environment jsdom
 *
 * REVIEW HIGH (station#1783). `HOME_LIFECYCLE_LABELS` is shared, and this
 * sheet renders `lifecycleLabel` as RAW TEXT — so adding `'Unanswerable'` for
 * the Home row put the wire enum straight into a user-facing line here
 * ("Current · Unanswerable"), with none of the basis, while the Home row two
 * files over carried both. Same label, two answers, one of them a bare
 * adjective.
 */
import { render, screen } from '@testing-library/react';
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

function renderSheet(tasks: HomeWorkItem[]) {
  return render(
    <MobileTaskSwitcher
      open
      tasks={tasks}
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
  test('renders the observation, not just the label', () => {
    renderSheet([task()]);
    // The shared inbox row (kontourai/station#3312) carries the observation
    // under the shared testid — one anatomy, one hook, both hosts.
    const notice = screen.getByTestId('inbox-row-answerability').textContent;
    expect(notice).toContain("no adapter for provider 'acme'");
    expect(notice).toContain('station-7f3a');
    expect(notice).toContain('2026-08-03T12:04:03.000Z');
  });

  test('translates the label instead of leaking the wire enum', () => {
    renderSheet([task()]);
    expect(screen.getByText("Can't answer here")).toBeTruthy();
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
    // The shared row renders the lifecycle CHIP ("Active"), not the raw
    // 'Running' wire enum the old bespoke row leaked (#3312 richness parity).
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.queryByText('Running')).toBeNull();
  });
});
