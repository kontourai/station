/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { navigate, setActiveChat, setDockState } = vi.hoisted(() => ({
  navigate: vi.fn(),
  setActiveChat: vi.fn(),
  setDockState: vi.fn(),
}));

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

import {
  ActiveChatsProvider,
  activeChatsStore,
} from '../contexts/ActiveChatsContext';
import { CommandsView } from '../views/CommandsView';

describe('CommandsView', () => {
  beforeEach(() => {
    navigate.mockReset();
    for (const key of Object.keys(activeChatsStore.getSnapshot()))
      activeChatsStore.removeChat(key);
    activeChatsStore.initChat('session-1', {
      agentSlug: 'station',
      agentName: 'Station',
    });
  });

  test('shows provenance and named gating, then stages an available command in chat', () => {
    render(
      <ActiveChatsProvider>
        <CommandsView />
      </ActiveChatsProvider>,
    );

    expect(screen.getAllByText('Skill').length).toBe(2);
    expect(screen.getByText('Requires MCP capability')).toBeTruthy();

    const buttons = screen.getAllByRole('button', { name: 'Use in chat' });
    expect((buttons[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[2]);

    expect(activeChatsStore.getSnapshot()['session-1'].input).toBe(
      '/review-release ',
    );
    expect(setActiveChat).toHaveBeenCalledWith('session-1');
    expect(setDockState).toHaveBeenCalledWith(true);
  });

  test('profiles the mounted command catalog during token delivery', () => {
    let commits = 0;
    const mounted = render(
      <ActiveChatsProvider>
        <Profiler id="commands" onRender={() => commits++}>
          <CommandsView />
        </Profiler>
      </ActiveChatsProvider>,
    );
    const initial = commits;
    const started = performance.now();
    for (let index = 0; index < 100; index++) {
      act(() =>
        activeChatsStore.updateChat('session-1', {
          streamingMessage: {
            role: 'assistant',
            content: 'word '.repeat(index + 1),
          },
        }),
      );
    }
    process.stdout.write(
      `COMMANDS_PROFILE ${JSON.stringify({ updates: commits - initial, cpuMs: performance.now() - started })}\n`,
    );
    expect(screen.getAllByRole('button', { name: 'Use in chat' })).toHaveLength(
      4,
    );
    mounted.unmount();
  });

  // a clash loser the server disabled is a ROW, not an absence —
  // its diagnostic is the reason it is unavailable, rendered by the same
  // unavailable status the capability-gated rows use.
  test('renders a disabled command skill with its server diagnostic', () => {
    render(
      <ActiveChatsProvider>
        <CommandsView />
      </ActiveChatsProvider>,
    );

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
    render(
      <ActiveChatsProvider>
        <CommandsView />
      </ActiveChatsProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '+ New command' }));

    expect(navigate).toHaveBeenCalledWith('/guidance/new', {
      tab: 'skills',
      filter: 'commands',
    });
  });
});
