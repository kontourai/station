/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { navigate, setActiveChat, setDockState, updateChat } = vi.hoisted(
  () => ({
    navigate: vi.fn(),
    setActiveChat: vi.fn(),
    setDockState: vi.fn(),
    updateChat: vi.fn(),
  }),
);

vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: [] }),
}));
vi.mock('../contexts/ModelsContext', () => ({ useModels: () => [] }));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'station', name: 'Station' }],
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    activeChat: 'session-1',
    setActiveChat,
    setDockState,
    navigate,
  }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  activeChatsStore: { updateChat },
  useActiveChatActions: () => ({ updateChat }),
  useAllActiveChats: () => ({
    'session-1': { agentSlug: 'station', input: '', attachments: [] },
  }),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => vi.fn(() => 'new-session'),
}));
vi.mock('../hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({
    catalog: [
      {
        cmd: '/clear',
        description: 'Clear the chat',
        source: 'builtin',
        availability: { available: true },
      },
      {
        cmd: '/mcp',
        description: 'List servers',
        source: 'builtin',
        availability: {
          available: false,
          reason: 'Requires MCP capability',
        },
      },
      {
        cmd: '/review-release',
        description: 'Review it',
        source: 'skill',
        availability: { available: true },
      },
      // a server-disabled clash loser renders as its own row,
      // keyed apart from the winner it shares a word with.
      {
        cmd: '/review-release',
        description: 'The loser',
        source: 'skill',
        availability: {
          available: false,
          reason:
            "'/review-release' is already used by the skill 'review-release'",
        },
      },
    ],
  }),
}));

import { CommandsView } from '../views/CommandsView';

describe('CommandsView', () => {
  beforeEach(() => {
    navigate.mockReset();
  });

  test('shows provenance and named gating, then stages an available command in chat', () => {
    render(<CommandsView />);

    expect(screen.getAllByText('Skill').length).toBe(2);
    expect(screen.getByText('Requires MCP capability')).toBeTruthy();

    const buttons = screen.getAllByRole('button', { name: 'Use in chat' });
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[2]);

    expect(updateChat).toHaveBeenCalledWith('session-1', {
      input: '/review-release ',
    });
    expect(setActiveChat).toHaveBeenCalledWith('session-1');
    expect(setDockState).toHaveBeenCalledWith(true);
  });

  // a clash loser the server disabled is a ROW, not an absence —
  // its diagnostic is the reason it is unavailable, rendered by the same
  // unavailable status the capability-gated rows use.
  test('renders a disabled command skill with its server diagnostic', () => {
    render(<CommandsView />);

    expect(
      screen.getAllByText(
        "'/review-release' is already used by the skill 'review-release'",
      ).length,
    ).toBe(1);

    const buttons = screen.getAllByRole('button', { name: 'Use in chat' });
    expect((buttons[3] as HTMLButtonElement).disabled).toBe(true);
  });

  // The catalogue stays its own tab rather than folding into a Skills filter:
  // it is the only list that holds builtins, engine commands and authored
  // commands together, and `/clear` is not a skill and never will be. What it
  // does drop is the retired noun — and it gains the one place to author a new
  // command, which is a command-enabled skill.
  test('creates a new command as a command-enabled skill', () => {
    render(<CommandsView />);
    fireEvent.click(screen.getByRole('button', { name: '+ New command' }));

    expect(navigate).toHaveBeenCalledWith('/guidance/new', {
      tab: 'skills',
      filter: 'commands',
    });
  });
});
