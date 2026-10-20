/**
 * @vitest-environment jsdom
 */

import type { AgentMcpPromptListing } from '@kontourai/station-contracts/mcp-prompts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatState: {
    agentSlug: 'writer',
    provider: 'station',
    input: '',
  } as Record<string, unknown>,
  updateChat: vi.fn(),
  addEphemeralMessage: vi.fn(),
  runPrompt: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    // The real cache key, so the handler reads what the list query wrote.
    agentMcpPromptsQueryKey: actual.agentMcpPromptsQueryKey,
    runAgentMcpPrompt: mocks.runPrompt,
    useRunSkill: () => ({ mutateAsync: vi.fn() }),
    useSkillDetailReader: () => vi.fn(),
  };
});
vi.mock('../contexts/ActiveChatsContext', () => ({
  activeChatsStore: {
    getSnapshot: () => ({ 'session-1': mocks.chatState }),
  },
  useActiveChatActions: () => ({
    updateChat: mocks.updateChat,
    addEphemeralMessage: mocks.addEphemeralMessage,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'writer', name: 'Writer', skills: [] }],
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost' }),
}));

import { agentMcpPromptsQueryKey } from '@kontourai/station-sdk';
import { useSlashCommandHandler } from '../hooks/useSlashCommandHandler';
import { mcpPromptCommandDescription } from '../hooks/useSlashCommands';

const LISTING: AgentMcpPromptListing = {
  prompts: [
    {
      command: 'fixture:summarize',
      serverId: 'fixture',
      name: 'summarize',
      description: 'Summarize a topic in a chosen tone.',
      arguments: [
        { name: 'topic', required: true },
        { name: 'tone', required: false },
      ],
    },
  ],
  unavailable: [],
};

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const autocomplete = {
  openModel: vi.fn(),
  openNewChat: vi.fn(),
  closeCommand: vi.fn(),
  closeAll: vi.fn(),
};

function run(command: string) {
  const { result } = renderHook(() => useSlashCommandHandler(), { wrapper });
  return result.current('session-1', command, { autocomplete });
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Literal pinned beside the derived key: the list query's cache entry.
  expect(agentMcpPromptsQueryKey('writer')).toEqual([
    'agent-mcp-prompts',
    'writer',
  ]);
  queryClient.setQueryData(agentMcpPromptsQueryKey('writer'), LISTING);
  mocks.updateChat.mockClear();
  mocks.addEphemeralMessage.mockClear();
  mocks.runPrompt.mockReset();
});

describe('#3284 an MCP prompt as a slash command', () => {
  test('runs the prompt with typed arguments and sends its text as the turn', async () => {
    mocks.runPrompt.mockResolvedValue({
      serverId: 'fixture',
      name: 'summarize',
      text: 'Summarize MCP in a brisk tone.',
    });
    await expect(run('/fixture:summarize "MCP" tone=brisk')).resolves.toBe(
      'Summarize MCP in a brisk tone.',
    );
    expect(mocks.runPrompt).toHaveBeenCalledWith('writer', {
      serverId: 'fixture',
      name: 'summarize',
      arguments: { topic: 'MCP', tone: 'brisk' },
    });
    expect(mocks.updateChat).toHaveBeenCalledWith('session-1', { input: '' });
  });

  test('a missing required argument sends nothing', async () => {
    await expect(run('/fixture:summarize')).resolves.toBe(true);
    expect(mocks.runPrompt).not.toHaveBeenCalled();
    expect(mocks.addEphemeralMessage).toHaveBeenCalledWith('session-1', {
      role: 'system',
      content:
        '/fixture:summarize needs a value for <topic> — nothing was sent',
    });
  });

  test("the server's refusal is shown and nothing is sent", async () => {
    mocks.runPrompt.mockRejectedValue(
      new Error(
        'The prompt includes image content, which Station cannot insert',
      ),
    );
    await expect(run('/fixture:summarize MCP')).resolves.toBe(true);
    expect(mocks.addEphemeralMessage).toHaveBeenCalledWith('session-1', {
      role: 'system',
      content:
        'Could not run /fixture:summarize: The prompt includes image content, which Station cannot insert',
    });
  });

  test('the menu row says what it does and what it takes', () => {
    expect(mcpPromptCommandDescription(LISTING.prompts[0])).toBe(
      'Summarize a topic in a chosen tone. · <topic> [tone]',
    );
  });
});
