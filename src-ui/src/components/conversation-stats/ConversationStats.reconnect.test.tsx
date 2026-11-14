// @vitest-environment jsdom

/**
 * The engine MCP panel's Sign in / Reconnect reach the Session's engine:
 * ConversationStats owns the mutation and hands the real modal its handler,
 * the in-flight server and the outcome line. The SDK mutation is the seam
 * mocked here; the route and the client have their own tests.
 */

import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  ConversationStats,
  engineMcpReconnectNotice,
} from './ConversationStats';

const mutateAsync = vi.hoisted(() => vi.fn());

vi.mock('@kontourai/station-sdk', () => ({
  useStatsQuery: () => ({
    data: {
      modelId: 'claude-sonnet-4.6',
      turns: 1,
      toolCalls: 0,
      measurement: { source: 'engine-events', provider: 'acp' },
    },
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
  useReconnectEngineMcpServerMutation: () => ({ mutateAsync }),
}));

// Failure wording has its own owner and tests; here it only has to reach
// the panel.
vi.mock('../../utils/errorText', () => ({
  userFacingErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

// The compaction control reads the Station's connections; it is not under
// test here.
vi.mock('./ContextCompactionControl', () => ({
  ContextCompactionControl: () => null,
}));

const SERVERS = [
  {
    name: 'docs',
    state: 'needs-auth' as const,
    scope: 'engine-config' as const,
  },
  { name: 'tracker', state: 'failed' as const, scope: 'session' as const },
];

function panel(executionThreadId?: string, engineMcpReconnect = true) {
  return (
    <ConversationStats
      agentSlug="kiro"
      conversationId="conversation-1"
      apiBase="http://station.test"
      isVisible
      onToggle={() => {}}
      engineMcpServers={SERVERS}
      engineMcpReconnect={engineMcpReconnect}
      {...(executionThreadId ? { executionThreadId } : {})}
    />
  );
}

afterEach(() => {
  cleanup();
  mutateAsync.mockReset();
});

describe('ConversationStats engine MCP reconnect', () => {
  test('Sign in asks the Session’s engine to start the sign-in and says what came of it', async () => {
    mutateAsync.mockResolvedValue({ kind: 'answered', success: true });
    render(panel('thread-live'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in: docs' }),
    );
    expect(mutateAsync).toHaveBeenCalledWith({
      threadId: 'thread-live',
      serverName: 'docs',
      startOAuth: true,
    });
    expect(
      await screen.findByText(
        'Asked the engine to sign in to docs. Its sign-in link appears in the chat.',
      ),
    ).toBeTruthy();
  });

  test('Reconnect sends no sign-in, and an engine refusal is shown as the engine said it', async () => {
    mutateAsync.mockResolvedValue({
      kind: 'answered',
      success: false,
      text: 'Server tracker is not configured',
    });
    render(panel('thread-live'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Reconnect: tracker' }),
    );
    expect(mutateAsync).toHaveBeenCalledWith({
      threadId: 'thread-live',
      serverName: 'tracker',
      startOAuth: false,
    });
    expect(
      await screen.findByText('Server tracker is not configured'),
    ).toBeTruthy();
  });

  test('a failed request is said, not swallowed', async () => {
    mutateAsync.mockRejectedValue(new Error('Session not live'));
    render(panel('thread-live'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Sign in: docs' }),
    );
    await waitFor(() =>
      expect(
        // The dialog is portalled out of the render container.
        document.querySelector('.engine-mcp-status__notice')?.textContent,
      ).toBe('Session not live'),
    );
    // The button is usable again once the request settled.
    expect(
      (
        screen.getByRole('button', {
          name: 'Sign in: docs',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  test('with no live Session to command, the panel offers no action', async () => {
    render(panel());
    expect(
      await screen.findByRole('region', { name: 'Engine MCP servers' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Sign in:|Reconnect:/ }),
    ).toBeNull();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  test('a live Session whose engine cannot reconnect (Codex) gets no action', async () => {
    render(panel('thread-live', false));
    expect(
      await screen.findByRole('region', { name: 'Engine MCP servers' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Sign in:|Reconnect:/ }),
    ).toBeNull();
  });

  test.each<[EngineCommandOutcome, string]>([
    [{ kind: 'not-declared' }, "This engine can't reconnect its MCP servers."],
    [
      { kind: 'unsupported' },
      "This Station can't reconnect an engine's MCP servers. Updating Station may add it.",
    ],
    [{ kind: 'failed', message: 'boom' }, 'boom'],
    [{ kind: 'answered', success: false }, 'docs did not reconnect.'],
  ])('outcome %j reads %s', (outcome, text) => {
    expect(engineMcpReconnectNotice('docs', false, outcome)).toBe(text);
  });
});
