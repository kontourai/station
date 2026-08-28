/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    ...actual,
    useConversationInventoryQuery: vi.fn(),
  };
});

const sdk = await import('@kontourai/station-sdk');
const { SessionPickerModal } = await import(
  '../components/modals/SessionPickerModal'
);

afterEach(cleanup);
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe('SessionPickerModal', () => {
  test('uses canonical inventory and restores the selected conversation project', () => {
    vi.mocked(sdk.useConversationInventoryQuery).mockReturnValue({
      data: [
        {
          id: 'conversation-beta',
          source: 'runtime',
          agentSlug: 'codex',
          projectSlug: 'beta',
          title: 'Codex Beta history',
          model: 'gpt-5-codex',
          createdAt: '2026-08-02T12:00:00.000Z',
          updatedAt: '2026-08-02T12:01:00.000Z',
          messageCount: 2,
          mutable: false,
        },
      ],
      isLoading: false,
    } as ReturnType<typeof sdk.useConversationInventoryQuery>);
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <SessionPickerModal
        isOpen
        onClose={onClose}
        onSelect={onSelect}
        agents={[{ slug: 'codex', name: 'Codex' }]}
        projects={[{ slug: 'beta', name: 'Beta Project' }]}
      />,
    );

    expect(screen.getByText('Codex Beta history')).toBeTruthy();
    expect(screen.getByText('Codex · Beta Project')).toBeTruthy();
    expect(screen.getByText('2 messages')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Codex Beta history/ }));

    expect(onSelect).toHaveBeenCalledWith(
      'conversation-beta',
      'codex',
      'beta',
      'Beta Project',
      'gpt-5-codex',
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(sdk.useConversationInventoryQuery).toHaveBeenCalledWith({
      enabled: true,
    });
  });

  // archive#771 regression: this used to render the SAME "No conversations
  // found" a genuinely-empty inventory shows, with no indication the read
  // had failed — `AutoSelectModal` has no error prop of its own, so the
  // fix distinguishes the two facts in the empty-message text itself.
  //
  // archive#771: the first-pass copy said "Try
  // again." with no button behind it — a fabricated affordance. The modal
  // is conditionally mounted by its parent (`{showSessionPicker && (...)}`),
  // so closing and reopening it genuinely remounts the query; the copy now
  // names that real affordance instead of an absent one.
  test('says the read failed and names the real retry affordance, not a fabricated one', () => {
    vi.mocked(sdk.useConversationInventoryQuery).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('inventory unavailable'),
    } as ReturnType<typeof sdk.useConversationInventoryQuery>);

    render(
      <SessionPickerModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        agents={[]}
        projects={[]}
      />,
    );

    expect(
      screen.getByText(
        'Could not load conversations. Close and reopen to try again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('No conversations found')).toBeNull();
    // No button-shaped retry affordance exists on this SDK component — the
    // copy must not imply one that isn't there.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });
});
