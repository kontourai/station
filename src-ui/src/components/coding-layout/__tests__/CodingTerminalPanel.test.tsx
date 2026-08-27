/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { CodingTerminalPanel } from '../CodingTerminalPanel';

vi.mock('../../acp-connections/ACPChatPanel', () => ({
  ACPChatPanel: () => <div>Agent chat</div>,
}));
vi.mock('../TerminalPanel', () => ({
  TerminalPanel: ({ terminalId }: { terminalId: string }) => (
    <div>Terminal {terminalId}</div>
  ),
}));

function renderPane(
  overrides: Partial<React.ComponentProps<typeof CodingTerminalPanel>> = {},
) {
  const props: React.ComponentProps<typeof CodingTerminalPanel> = {
    presentation: 'pane',
    terminalOpen: true,
    tabs: [
      { id: 'one', type: 'shell', label: 'Shell 1' },
      { id: 'two', type: 'shell', label: 'Shell 2' },
    ],
    activeTabId: 'one',
    editingTabId: null,
    onSelectTab: vi.fn(),
    onStartRename: vi.fn(),
    onFinishRename: vi.fn(),
    onCancelRename: vi.fn(),
    onCloseTab: vi.fn(),
    onToggleTabMode: vi.fn(),
    canTogglePTY: () => false,
    onOpenNewTerminal: vi.fn(),
    projectSlug: 'demo',
    workingDir: '/workspace',
    ...overrides,
  };
  render(<CodingTerminalPanel {...props} />);
  return props;
}

test('uses a host-compatible tablist with roving keyboard focus and separate close controls', () => {
  const props = renderPane();
  const first = screen.getByRole('tab', { name: 'Shell 1' });
  const second = screen.getByRole('tab', { name: 'Shell 2' });

  expect(first.getAttribute('aria-selected')).toBe('true');
  expect(second.getAttribute('aria-selected')).toBe('false');
  expect(screen.queryByTitle(/Hide terminal/)).toBeNull();

  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowRight' });
  expect(props.onSelectTab).toHaveBeenCalledWith('two');
  expect(document.activeElement).toBe(second);

  fireEvent.click(screen.getByRole('button', { name: 'Close Shell 1' }));
  expect(props.onCloseTab).toHaveBeenCalledWith('one');
});
