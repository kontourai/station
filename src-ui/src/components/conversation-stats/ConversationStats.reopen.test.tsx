// @vitest-environment jsdom

/**
 * A reopened conversation has no live `engine-mcp.status` state, so the
 * engine MCP panel reads the server's folded report from the conversation
 * stats. The stats here are what the real fold and wire parser produce from
 * persisted events; the SDK query is the seam mocked.
 */

import {
  type ConversationStatsResponse,
  parseConversationStatsResponse,
} from '@kontourai/station-contracts/runtime';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatEngineMcpServer } from '../../contexts/active-chats-state';
import { ConversationStats } from './ConversationStats';

const query = vi.hoisted(() => ({
  data: undefined as ConversationStatsResponse | undefined,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useStatsQuery: () => ({
    data: query.data,
    error: null,
    refetch: vi.fn(),
    isLoading: false,
  }),
  StationHttpError: class extends Error {},
  useConversationUsageTreeQuery: () => ({
    data: undefined,
    error: null,
    isPending: false,
    fetchStatus: 'idle',
  }),
  useReconnectEngineMcpServerMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('./ContextCompactionControl', () => ({
  ContextCompactionControl: () => null,
}));

function mcpEvent(
  index: number,
  servers: unknown[],
  complete: boolean,
  reconnect?: true,
): CanonicalRuntimeEvent {
  return {
    eventId: `e${index}`,
    provider: 'acp',
    threadId: 'thread-1',
    createdAt: '2026-11-13T00:00:00.000Z',
    method: 'engine-mcp.status',
    servers: servers as never,
    complete,
    ...(reconnect ? { reconnect } : {}),
  };
}

/** The stats the server would answer after these events, through the wire parser. */
function storedStats(events: CanonicalRuntimeEvent[]) {
  const aggregate = foldUsageEvents(events);
  return parseConversationStatsResponse(
    JSON.parse(
      JSON.stringify({
        modelId: 'auto',
        turns: aggregate.turns,
        toolCalls: aggregate.toolCalls,
        measurement: { source: 'engine-events', provider: 'acp' },
        ...(aggregate.engineMcp ? { engineMcp: aggregate.engineMcp } : {}),
      }),
    ),
  );
}

const REPORTED = [
  mcpEvent(
    0,
    [
      { name: 'docs', state: 'needs-auth', scope: 'engine-config' },
      { name: 'tracker', state: 'failed', scope: 'session' },
    ],
    true,
    true,
  ),
];

function reopened(props: {
  executionThreadId?: string;
  engineMcpServers?: ChatEngineMcpServer[];
}) {
  return (
    <ConversationStats
      agentSlug="kiro"
      conversationId="conversation-1"
      apiBase="http://station.test"
      isVisible
      onToggle={() => {}}
      {...props}
    />
  );
}

afterEach(() => {
  cleanup();
  query.data = undefined;
});

describe('ConversationStats engine MCP panel after reopen', () => {
  test('shows the stored servers with their actions when the stored report could reconnect', async () => {
    query.data = storedStats(REPORTED);
    render(reopened({ executionThreadId: 'thread-1' }));
    const region = await screen.findByRole('region', {
      name: 'Engine MCP servers',
    });
    expect(within(region).getByText('docs')).toBeTruthy();
    expect(within(region).getByText('Sign-in needed')).toBeTruthy();
    expect(within(region).getByText('tracker')).toBeTruthy();
    expect(
      within(region).getByRole('button', { name: 'Sign in: docs' }),
    ).toBeTruthy();
    expect(
      within(region).getByRole('button', { name: 'Reconnect: tracker' }),
    ).toBeTruthy();
  });

  test('a stored report without reconnect offers no action', async () => {
    query.data = storedStats([
      mcpEvent(
        0,
        [{ name: 'docs', state: 'needs-auth', scope: 'engine-config' }],
        true,
      ),
    ]);
    render(reopened({ executionThreadId: 'thread-1' }));
    expect(
      await screen.findByRole('region', { name: 'Engine MCP servers' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Sign in:|Reconnect:/ }),
    ).toBeNull();
  });

  test('a partial live report after reopen updates the stored list instead of replacing it', async () => {
    query.data = storedStats(REPORTED);
    render(
      reopened({
        executionThreadId: 'thread-1',
        engineMcpServers: [
          { name: 'docs', state: 'ready', scope: 'engine-config' },
        ],
      }),
    );
    const region = await screen.findByRole('region', {
      name: 'Engine MCP servers',
    });
    expect(within(region).getByText('Ready')).toBeTruthy();
    expect(within(region).queryByText('Sign-in needed')).toBeNull();
    expect(within(region).getByText('tracker')).toBeTruthy();
  });

  test('no stored or live report, no panel', async () => {
    query.data = storedStats([]);
    render(reopened({ executionThreadId: 'thread-1' }));
    await screen.findByRole('dialog');
    expect(
      screen.queryByRole('region', { name: 'Engine MCP servers' }),
    ).toBeNull();
  });
});
