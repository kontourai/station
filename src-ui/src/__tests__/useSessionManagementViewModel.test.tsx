// @vitest-environment jsdom

import { engineId } from '@kontourai/station-contracts/agent-identity';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

let INVENTORY: unknown[] = [];

vi.mock('@kontourai/station-sdk', () => ({
  useConversationInventoryQuery: () => ({
    data: INVENTORY,
    isLoading: false,
    error: null,
  }),
}));

const { useSessionManagementViewModel } = await import(
  '../hooks/useSessionManagementViewModel'
);

function conversation(id: string, updatedAt = '2026-01-01T00:00:00Z') {
  return {
    id,
    agentSlug: id,
    title: `Conversation ${id}`,
    createdAt: updatedAt,
    updatedAt,
  };
}

function renderViewModel(
  agents: Parameters<typeof useSessionManagementViewModel>[0],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSessionManagementViewModel(agents), { wrapper });
}

describe('useSessionManagementViewModel — MED-2/round-3: every resolved agent gets an engine chip', () => {
  test('orders History newest-first, puts invalid timestamps last, and breaks equal timestamps by id', async () => {
    INVENTORY = [
      conversation('older', '2026-08-08T12:00:00.000Z'),
      conversation('equal-a', '2026-08-08T12:01:00.000Z'),
      conversation('invalid', 'not-a-timestamp'),
      conversation('newer', '2026-08-08T12:02:00.000Z'),
      conversation('equal-z', '2026-08-08T12:01:00.000Z'),
    ];
    const { result } = renderViewModel([]);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(
      result.current.conversations.map((conversation) => conversation.id),
    ).toEqual(['newer', 'equal-z', 'equal-a', 'older', 'invalid']);
  });

  test('a persisted Claude agent conversation carries its explicit engine identity', async () => {
    INVENTORY = [{ ...conversation('conv-claude'), agentSlug: 'claude' }];
    const { result } = renderViewModel([
      {
        slug: 'claude',
        name: 'Claude',
        engineId: engineId('claude-code'),
        engineDisplayName: 'Claude Code',
        execution: { agentConnectionId: 'claude' },
      },
    ]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    const conv = result.current.conversations.find(
      (c) => c.id === 'conv-claude',
    );
    expect(conv?.agentType).toBe('global');
    expect(conv?.agentEngine).toEqual({ name: 'Claude Code' });
  });

  test('a Station agent conversation carries a "Station" agentEngine', async () => {
    INVENTORY = [
      { ...conversation('conv-station'), agentSlug: 'plain-station-agent' },
    ];
    const { result } = renderViewModel([
      { slug: 'plain-station-agent', name: 'Plain Station Agent' },
    ]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    const conv = result.current.conversations.find(
      (c) => c.id === 'conv-station',
    );
    expect(conv?.agentType).toBe('global');
    expect(conv?.agentEngine).toEqual({ name: 'Station' });
  });

  test('an agent whose engine cannot be honestly resolved (unknown connection id, no server fields) carries no agentEngine', async () => {
    INVENTORY = [
      { ...conversation('conv-unresolved'), agentSlug: 'unresolved-agent' },
    ];
    const { result } = renderViewModel([
      {
        slug: 'unresolved-agent',
        name: 'Unresolved Agent',
        engineId: engineId('acme'),
        execution: { agentConnectionId: 'some-plugin-connection' },
      },
    ]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    const conv = result.current.conversations.find(
      (c) => c.id === 'conv-unresolved',
    );
    expect(conv?.agentEngine).toBeNull();
  });

  test('a command-backed Agent remains a normal Agent and carries its engine chip', async () => {
    INVENTORY = [{ ...conversation('conv-acp'), agentSlug: 'kiro' }];
    const { result } = renderViewModel([
      {
        slug: 'kiro',
        name: 'Kiro',
        source: 'acp',
        engineId: engineId('kiro'),
        engineDisplayName: 'Kiro Chat',
        engineConnectionType: 'acp',
        connectionName: 'Kiro Chat',
      },
    ]);

    await waitFor(() => expect(result.current.loading).toBe(false));
    const conv = result.current.conversations.find((c) => c.id === 'conv-acp');
    expect(conv?.agentType).toBe('acp');
    expect(conv?.agentEngine).toEqual({ name: 'Kiro Chat', model: undefined });
  });
});
