/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { PaneHeadSlotsContext } from '../../../workspace-panes/PaneHeadSlots';
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

test('in a host that draws its head, the tab strip joins the head row and the pane draws no bar of its own (#3046 round)', () => {
  const leading = document.createElement('div');
  document.body.append(leading);
  try {
    const props = {
      presentation: 'pane' as const,
      terminalOpen: true,
      tabs: [{ id: 'one', type: 'shell' as const, label: 'Shell 1' }],
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
    };
    const { container } = render(
      <PaneHeadSlotsContext.Provider value={{ leading, trailing: null }}>
        <CodingTerminalPanel {...props} />
      </PaneHeadSlotsContext.Provider>,
    );
    expect(container.querySelector('.coding-layout__terminal-bar')).toBeNull();
    const strip = within(leading).getByRole('tablist', {
      name: 'Terminal tabs',
    });
    // One tab still shows: it is where its close, rename and mode live.
    expect(within(strip).getAllByRole('tab')).toHaveLength(1);
    expect(within(leading).getByTitle('New terminal')).toBeTruthy();
    expect(
      within(leading).getByRole('button', { name: 'Close Shell 1' }),
    ).toBeTruthy();
  } finally {
    leading.remove();
  }
});

test('in a host’s head with no terminal yet, the strip offers no "+": the empty state’s own button says it', () => {
  const leading = document.createElement('div');
  document.body.append(leading);
  try {
    render(
      <PaneHeadSlotsContext.Provider value={{ leading, trailing: null }}>
        <CodingTerminalPanel
          presentation="pane"
          terminalOpen
          tabs={[]}
          activeTabId=""
          editingTabId={null}
          onSelectTab={vi.fn()}
          onStartRename={vi.fn()}
          onFinishRename={vi.fn()}
          onCancelRename={vi.fn()}
          onCloseTab={vi.fn()}
          onToggleTabMode={vi.fn()}
          canTogglePTY={() => false}
          onOpenNewTerminal={vi.fn()}
          projectSlug="demo"
          workingDir="/workspace"
        />
      </PaneHeadSlotsContext.Provider>,
    );
    expect(within(leading).queryByTitle('New terminal')).toBeNull();
    expect(screen.getByRole('button', { name: '+ New Terminal' })).toBeTruthy();
  } finally {
    leading.remove();
  }
});
