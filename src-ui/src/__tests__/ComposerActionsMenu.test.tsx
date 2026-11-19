// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react';
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
    onOpenDelegation: vi.fn(),
    onOpenCommandLauncher: vi.fn(),
    ...overrides,
  };
  render(<ComposerActionsMenu {...(props as any)} />);
  return props;
}

/** Answer `(pointer: coarse)` as given; every other query does not match. */
function withPointer(coarse: boolean, run: () => void) {
  const original = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('pointer: coarse') ? coarse : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      media: query,
      onchange: null,
    }),
  });
  try {
    run();
  } finally {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: original,
    });
  }
}

describe('ComposerActionsMenu command-launcher chord hint', () => {
  test('a fine pointer shows the chord on the Commands item', () => {
    withPointer(false, () => {
      renderMenu();
      fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
      const commands = screen.getByRole('menuitem', {
        name: 'Open command launcher',
      });
      expect(commands.querySelector('kbd')?.textContent).toBe('⌘⇧L');
      expect(commands.getAttribute('title')).toContain('⌘⇧L');
    });
  });

  // The phone report: chord hints a finger cannot press.
  test('a coarse pointer shows no chord, in the kbd or the label', () => {
    withPointer(true, () => {
      renderMenu();
      fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
      const commands = screen.getByRole('menuitem', {
        name: 'Open command launcher',
      });
      expect(commands.querySelector('kbd')).toBeNull();
      expect(commands.getAttribute('title')).toBe('Open command launcher');
    });
  });
});

describe('ComposerActionsMenu', () => {
  test('the trigger is a real labeled button, closed by default', () => {
    renderMenu();
    const trigger = screen.getByRole('button', { name: 'Composer actions' });
    expect(trigger).toHaveProperty('type', 'button');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('opens by pointer and groups its items: message, project work, conversation', () => {
    renderMenu({
      onOpenConversationReference: vi.fn(),
      onOpenTerminal: vi.fn(),
      onOpenCodingLayout: vi.fn(),
      onOpenHandoff: vi.fn(),
      onOpenContextReset: vi.fn(),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));

    const menu = screen.getByRole('menu', { name: 'Composer actions' });
    const groups = within(menu).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'Add to message',
      'Work in this project',
      'This conversation',
    ]);
    const names = (group: HTMLElement) =>
      within(group)
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-label') ?? item.textContent);
    expect(names(groups[0]!)).toEqual([
      'Reference chat…',
      'Open command launcher',
    ]);
    expect(names(groups[1]!)).toEqual([
      'Open terminalBottom dock',
      'Open in CodingMoves this chat',
      'Delegate…Resumable task',
    ]);
    // Reset is last and reads as the one row that costs something.
    const conversation = within(groups[2]!).getAllByRole('menuitem');
    expect(conversation.at(-1)!.textContent).toBe('Reset agent context…');
    expect(conversation.at(-1)!.getAttribute('data-tone')).toBe('danger');
    for (const item of within(menu).getAllByRole('menuitem')) {
      expect(item.tagName).toBe('BUTTON');
      expect(item.getAttribute('type')).toBe('button');
    }
    // Panel toggles live in the dock's More menu, not here.
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
  });

  test('clicking Delegate closes the menu and calls onOpenDelegation', () => {
    const props = renderMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delegate…' }));

    expect(props.onOpenDelegation).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('Open terminal closes the menu and opens the dock terminal', () => {
    const onOpenTerminal = vi.fn();
    renderMenu({ onOpenTerminal });
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Open terminal/ }));
    expect(onOpenTerminal).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  test('an unavailable terminal says why on the row itself', () => {
    const onOpenTerminal = vi.fn();
    renderMenu({
      onOpenTerminal,
      terminalDisabledReason: 'Set a working directory first',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
    const item = screen.getByRole('menuitem', { name: /^Open terminal/ });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.textContent).toContain('Set a working directory first');
    fireEvent.click(item);
    expect(onOpenTerminal).not.toHaveBeenCalled();
  });

  test('the coding row carries the layout name and moves the chat', () => {
    const onOpenCodingLayout = vi.fn();
    renderMenu({ onOpenCodingLayout, codingLayoutLabel: 'Open in Workbench' });
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
    fireEvent.click(
      screen.getByRole('menuitem', { name: /^Open in Workbench/ }),
    );
    expect(onOpenCodingLayout).toHaveBeenCalledOnce();
  });

  test('project rows are absent for a chat with no Project', () => {
    renderMenu({
      projectActionsAvailable: false,
      onOpenTerminal: vi.fn(),
      onOpenCodingLayout: vi.fn(),
      onOpenHandoff: vi.fn(),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Composer actions' }));
    expect(
      screen.queryByRole('menuitem', { name: /Open terminal/ }),
    ).toBeNull();
    expect(
      screen.queryByRole('menuitem', { name: /Open in Coding/ }),
    ).toBeNull();
    expect(screen.getAllByRole('group')).toHaveLength(1);
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

    expect(screen.queryByRole('menuitem', { name: 'Delegate…' })).toBeNull();
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
    // Visible text, not a tooltip: a phone has no hover.
    expect(item.textContent).toContain('Wait for the current turn to finish.');
  });
});
