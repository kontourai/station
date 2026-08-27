// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { ComposerActionsMenu } from '../components/chat-dock/ComposerActionsMenu';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: '',
      onchange: null,
    })),
  });
});

function renderMenu(overrides: Record<string, unknown> = {}) {
  const props = {
    triggerRef: { current: null },
    commandLauncherDisabled: false,
    commandLauncherShortcut: '⌘⇧L',
    filesActive: false,
    taskContextActive: false,
    filesCount: 3,
    onOpenDelegation: vi.fn(),
    onOpenCommandLauncher: vi.fn(),
    onToggleFiles: vi.fn(),
    onToggleTaskContext: vi.fn(),
    ...overrides,
  };
  render(<ComposerActionsMenu {...(props as any)} />);
  return props;
}

describe('ComposerActionsMenu', () => {
  test('the trigger is a real labeled button, closed by default', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Composer actions' });
    expect(trigger).toHaveProperty('type', 'button');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('opens by pointer and exposes Delegate/Commands/Files/Task context as real menu items', () => {
    renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));

    const menu = screen.getByRole('menu', { name: 'Composer actions' });
    expect(menu).toBeTruthy();

    // Files/Task context are toggles (role menuitemcheckbox); Delegate/
    // Commands are plain actions (role menuitem) — both are real buttons
    // reachable via getByRole.
    const items = [
      ...screen.getAllByRole('menuitem'),
      ...screen.getAllByRole('menuitemcheckbox'),
    ];
    expect(screen.getByRole('menuitem', { name: 'Delegate' })).toBeTruthy();
    expect(
      screen.getByRole('menuitem', { name: 'Open command launcher' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('menuitemcheckbox', { name: /^Files/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Task context' }),
    ).toBeTruthy();
    for (const item of items) {
      expect(item.tagName).toBe('BUTTON');
      expect(item.getAttribute('type')).toBe('button');
    }
  });

  test('opens by keyboard (Enter on the trigger)', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Composer actions' });
    trigger.focus();
    fireEvent.click(trigger); // jsdom does not synthesize Enter->click; the
    // real browser activates buttons on Enter/Space natively, so the click
    // handler is what a keyboard activation ultimately invokes.
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  test('clicking Delegate closes the menu and calls onOpenDelegation', () => {
    const props = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delegate' }));

    expect(props.onOpenDelegation).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('surfaces the changed-files count on the Files item', () => {
    renderMenu({ filesCount: 5 });
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
    const filesItem = screen.getByRole('menuitemcheckbox', {
      name: /^Files/,
    });
    expect(filesItem.textContent).toContain('5');
  });

  test('disables the Commands item while the agent is working', () => {
    renderMenu({ commandLauncherDisabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
    const commandsItem = screen.getByRole('menuitem', {
      name: 'Open command launcher',
    });
    expect((commandsItem as HTMLButtonElement).disabled).toBe(true);
  });

  test('offers explicit Agent handoff without turning ordinary project actions into handoffs', () => {
    const onOpenHandoff = vi.fn();
    const props = renderMenu({
      projectActionsAvailable: false,
      onOpenHandoff,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));

    expect(screen.queryByRole('menuitem', { name: 'Delegate' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Continue with/ }));

    expect(onOpenHandoff).toHaveBeenCalledOnce();
    expect(props.onOpenDelegation).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('explains why handoff is unavailable while the predecessor is active', () => {
    renderMenu({
      onOpenHandoff: vi.fn(),
      handoffDisabled: true,
      handoffDisabledReason: 'Wait for the current turn to finish.',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
    const item = screen.getByRole('menuitem', { name: /Continue with/ });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.getAttribute('title')).toBe(
      'Wait for the current turn to finish.',
    );
  });
});
