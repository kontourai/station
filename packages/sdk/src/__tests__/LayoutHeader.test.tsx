/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

// `ActionButton`'s `internal` branch reads the SDK's navigation context,
// which needs an `SDKProvider`; `useAuth` falls back without one. Only the
// navigation hook is replaced, so the rest of the header runs as shipped.
vi.mock('../hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../hooks')>()),
  useNavigation: () => ({ navigate: vi.fn() }),
}));

import { LayoutHeader } from '../components/LayoutHeader';

function renderHeader(onTabPromptSelect = vi.fn()) {
  render(
    <LayoutHeader
      title="Sessions"
      description="Recent work"
      tabPrompts={[{ id: 'p1', label: 'Summarise', prompt: 'summarise' }]}
      onTabPromptSelect={onTabPromptSelect}
    />,
  );
  return onTabPromptSelect;
}

describe('LayoutHeader prompt dropdown', () => {
  test('catches outside clicks without adding a full-viewport tab stop', () => {
    renderHeader();

    const closedTabStops = screen.getAllByRole('button').length;
    fireEvent.click(
      screen.getByRole('button', { name: 'Sessions Quick actions' }),
    );
    const menuItem = screen.getByRole('button', { name: 'Summarise' });

    // Opening the menu may add exactly one tab stop: the menu item. The
    // click-outside catcher is a fixed, full-viewport element — as a `<button>`
    // it is an invisible tab stop between the toggle and the menu that
    // dismisses the menu on Enter, and this package styles no focus ring.
    expect(screen.getAllByRole('button')).toHaveLength(closedTabStops + 1);
    expect(
      screen.queryByRole('button', { name: /Close Sessions prompts/i }),
    ).toBeNull();

    const backdrop = document.querySelector(
      '.workspace-header__dropdown-backdrop',
    );
    expect(backdrop).not.toBeNull();
    expect(backdrop?.tagName).toBe('DIV');
    expect(backdrop?.hasAttribute('tabindex')).toBe(false);

    // Dismissal itself still works.
    fireEvent.click(backdrop as Element);
    expect(menuItem.isConnected).toBe(false);
    expect(
      document.querySelector('.workspace-header__dropdown-backdrop'),
    ).toBeNull();
  });
});

/**
 * station#2171: a host that cannot run a prompt says so, and the header
 * renders no control that would need a launcher. Before this the header
 * rendered every prompt it was handed, wired to a no-op when the host passed
 * no handler, so a docked Layout carrying prompts showed buttons that did
 * nothing. Absent (`undefined`) is the pre-existing contract: everything
 * renders. `external` and `internal` actions survive `false` because they
 * open or navigate without a launcher, and they work in that host.
 */
describe('LayoutHeader canLaunchPrompts (station#2171)', () => {
  const launcherActions = [
    { type: 'prompt' as const, label: 'Draft a summary', data: 'summary' },
    { type: 'inline-prompt' as const, label: 'Inline body', data: 'body' },
    { type: 'external' as const, label: 'Open docs', data: 'https://x/' },
    { type: 'internal' as const, label: 'Go to tasks', data: '/tasks' },
  ];

  test('absent, every prompt renders (the contract every existing host relies on)', () => {
    render(
      <LayoutHeader
        title="Notes"
        description=""
        actions={launcherActions}
        tabActions={[
          { type: 'prompt', label: 'Tab prompt', data: 'tab' } as any,
        ]}
        tabPrompts={[{ id: 'q', label: 'Quick one', prompt: 'quick' }]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Draft a summary' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Inline body' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tab prompt' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Notes Quick actions' }),
    ).toBeTruthy();
  });

  test('false renders no prompt, no global skill, no tab prompt and no quick-actions menu', () => {
    render(
      <LayoutHeader
        title="Notes"
        description=""
        canLaunchPrompts={false}
        actions={launcherActions}
        tabActions={[
          { type: 'prompt', label: 'Tab prompt', data: 'tab' } as any,
          // No `type` at all falls through to the prompt branch and calls
          // the launcher; it is not "external or internal", so it goes too.
          { id: 'untyped', label: 'Untyped tab action', prompt: 'u' } as any,
          { type: 'internal', label: 'Tab link', data: '/x' } as any,
        ]}
        tabPrompts={[{ id: 'q', label: 'Quick one', prompt: 'quick' }]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Draft a summary' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Inline body' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tab prompt' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Untyped tab action' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Notes Quick actions' }),
    ).toBeNull();
    // The two kinds that need no launcher stay, in both rows.
    expect(screen.getByRole('link', { name: 'Open docs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to tasks' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tab link' })).toBeTruthy();
  });

  test('false with only launcher-dependent prompts renders no prompt row at all', () => {
    const { container } = render(
      <LayoutHeader
        title="Notes"
        description=""
        canLaunchPrompts={false}
        layoutPrompts={[{ id: 'g', label: 'Global skill', prompt: 'g' }]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Global skill' })).toBeNull();
    // No tabs and nothing launchable: the header row that would hold the
    // prompts is not rendered, rather than rendered empty.
    expect(container.querySelector('.workspace-tabs__header')).toBeNull();
  });
});
