/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// The built-in commands load on demand (epic #61). When that chunk fails, a
// typed command is not sent anywhere — the handler cannot tell a built-in from
// a model passthrough without it — and a later dispatch loads it again.
const chunk = vi.hoisted(() => ({ fail: true }));

vi.mock('../slashCommands/builtins', async (importOriginal) => {
  if (chunk.fail)
    throw new Error('Failed to fetch dynamically imported module');
  return importOriginal();
});

const mocks = vi.hoisted(() => ({
  chatState: {
    agentSlug: 'station',
    provider: 'station',
    input: '',
  } as Record<string, unknown>,
  agents: [{ slug: 'station', name: 'Station', skills: [] as string[] }],
  updateChat: vi.fn(),
  addEphemeralMessage: vi.fn(),
  runSkill: vi.fn().mockResolvedValue(undefined),
  readSkillDetail: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useRunSkill: () => ({ mutateAsync: mocks.runSkill }),
  useSkillDetailReader: () => mocks.readSkillDetail,
}));
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
  useAgents: () => mocks.agents,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost' }),
}));

import { useSlashCommandHandler } from '../hooks/useSlashCommandHandler';

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

function mountHandler() {
  const { result } = renderHook(() => useSlashCommandHandler(), { wrapper });
  return (command: string) =>
    result.current('session-1', command, { autocomplete });
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

describe('when the built-in commands chunk fails to load', () => {
  test('sends nothing and says so, then a later dispatch loads the commands', async () => {
    chunk.fail = true;
    const run = mountHandler();
    // Let the mount-time warm-up fail first, so the dispatch below is not
    // simply joining it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await expect(run('/chat')).resolves.toBe(true);
    expect(autocomplete.openNewChat).not.toHaveBeenCalled();
    expect(mocks.addEphemeralMessage).toHaveBeenCalledTimes(1);
    const message = mocks.addEphemeralMessage.mock.calls[0]?.[1]?.content;
    expect(message).toContain("Could not load Station's built-in commands");
    expect(message).toContain('/chat was not sent');
    expect(message).toContain('Try again');

    chunk.fail = false;
    mocks.addEphemeralMessage.mockClear();
    await expect(run('/chat')).resolves.toBe(true);
    expect(autocomplete.openNewChat).toHaveBeenCalledTimes(1);
    expect(mocks.addEphemeralMessage).not.toHaveBeenCalled();
  });
});
