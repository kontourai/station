/**
 * @vitest-environment jsdom
 */

import type { AgentMcpPromptListing } from '@kontourai/station-contracts/mcp-prompts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Only the skill and ACP reads are stubbed. The MCP prompt listing goes
// through the real `useAgentMcpPromptsQuery`, so the menu reads the cache
// entry the list query owns.
vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return {
    agentMcpPromptsQueryKey: actual.agentMcpPromptsQueryKey,
    useAgentMcpPromptsQuery: actual.useAgentMcpPromptsQuery,
    useSkillsQuery: () => ({ data: [] }),
    useProviderCommandsQuery: () => ({ data: [] }),
  };
});
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'writer', name: 'Writer', skills: [] }],
}));

import { agentMcpPromptsQueryKey } from '@kontourai/station-sdk';
import { SlashCommandSelector } from '../components/chat/SlashCommandSelector';
import { useSlashCommands } from '../hooks/useSlashCommands';
import type { BindingStatus } from '../utils/execution';

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

const MCP_READY: BindingStatus = {
  bindingReadiness: 'ready',
  catalogSource: 'none',
  catalogReason: null,
  visibleModels: [],
  capabilityState: {
    system_prompt: true,
    mcp: true,
    tool_execution: true,
    model_catalog: false,
    model_selection: false,
  },
};

// The composer's own wiring: the hook's commands into the selector, with the
// query the composer derives from `/fixture` (everything after the slash).
function SlashMenu({ input }: { input: string }) {
  const { commands } = useSlashCommands('writer', null, MCP_READY);
  return (
    <SlashCommandSelector
      query={input.slice(1)}
      commands={commands}
      onSelect={() => {}}
      onClose={() => {}}
    />
  );
}

let queryClient: QueryClient;

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
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe('#3284 the slash menu lists an MCP prompt', () => {
  test('typing /fixture shows /fixture:summarize with its MCP badge', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <SlashMenu input="/fixture" />
      </QueryClientProvider>,
    );

    const menu = screen.getByRole('listbox', { name: 'Suggestions' });
    const row = within(menu).getByRole('option', {
      name: /\/fixture:summarize/,
    });
    expect(within(row).getByText('/fixture:summarize')).toBeTruthy();
    expect(within(row).getByText('MCP')).toBeTruthy();
    expect(
      within(row).getByText(
        'Summarize a topic in a chosen tone. · <topic> [tone]',
      ),
    ).toBeTruthy();
    // `/fixture` matches nothing else, so the prompt is the menu's only row.
    expect(within(menu).getAllByRole('option')).toHaveLength(1);
  });
});
