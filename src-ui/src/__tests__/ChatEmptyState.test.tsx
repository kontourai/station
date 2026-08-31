/**
 * @vitest-environment jsdom
 */

import type { SystemStatus } from '@kontourai/station-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

let currentStatus: SystemStatus | null | undefined;
const navigate = vi.fn();

// Minimal `AgentData`-shaped fixtures — only the fields `agentEngineDescriptor`
// (utils/engine.ts) reads. Defaults to `[]` so an agent slug the fixture list
// doesn't mention resolves to "unknown", matching the pre-archive#1193
// slug-only behavior for the common ordinary-Station-agent case.
let currentAgents: Array<{
  slug: string;
  name: string;
  source?: string | null;
  engineId?: string;
  connectionName?: string | null;
  engineDisplayName?: string | null;
  model?: string;
  execution?: { agentConnectionId?: string | null };
}> = [];

// True in every test unless a test explicitly puts the agent catalog into
// its still-loading state (archive#1193) — mirrors
// `useAgentsLoaded`'s real "resolved successfully at least once" signal.
let currentAgentsLoaded = true;

vi.mock('../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({
    data: currentStatus,
    isLoading: currentStatus === undefined,
    isError: false,
  }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate,
  }),
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => currentAgents,
  useAgentsLoaded: () => currentAgentsLoaded,
}));

import { ChatEmptyState } from '../components/chat/ChatEmptyState';

function createStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    prerequisites: [],
    acp: {
      connected: false,
      connections: [],
    },
    providers: {
      configuredChatReady: false,
      configured: [],
      detected: {
        ollama: false,
        bedrock: false,
      },
    },
    clis: {},
    recommendation: {
      code: 'unconfigured',
      type: 'connections',
      actionLabel: 'Open Connections',
      title: 'No usable AI path is configured yet',
      detail:
        'Start Ollama locally or add a provider/runtime connection to make Station ready for first-run chat.',
    },
    ready: false,
    ...overrides,
  };
}

const RUNTIME_ONLY_RECOMMENDATION = {
  code: 'runtime-only' as const,
  type: 'runtimes' as const,
  actionLabel: 'Review engines',
  title: 'An engine is available',
  detail:
    'Station detected a ready engine. Ready engines can start a chat without a separate model connection.',
};

describe('ChatEmptyState', () => {
  beforeEach(() => {
    navigate.mockReset();
    currentAgents = [];
    currentAgentsLoaded = true;
  });

  test('shows the normal ready-state copy when chat is already configured', () => {
    currentStatus = createStatus({
      providers: {
        configuredChatReady: true,
        configured: [
          {
            id: 'ollama-local',
            type: 'ollama',
            enabled: true,
            capabilities: ['llm'],
          },
        ],
        detected: { ollama: true, bedrock: false },
      },
      recommendation: {
        code: 'configured-chat-ready',
        type: 'providers',
        actionLabel: 'Review model connections',
        title: 'A chat-capable model connection is already configured',
        detail: 'Station can already route chat through ollama.',
      },
      ready: true,
    });

    render(<ChatEmptyState agentSlug="dev-agent" agentName="Dev Agent" />);

    expect(screen.getByText('Start a conversation')).toBeTruthy();
    expect(
      screen.getByText('Type a message below to chat with Dev Agent'),
    ).toBeTruthy();
    expect(screen.queryByTestId('chat-empty-state-unconfigured')).toBeNull();
  });

  test('shows the normal copy while system status is still loading, to avoid a flash', () => {
    currentStatus = undefined;

    render(<ChatEmptyState agentSlug="dev-agent" agentName="Dev Agent" />);

    expect(screen.getByText('Start a conversation')).toBeTruthy();
    expect(screen.queryByTestId('chat-empty-state-unconfigured')).toBeNull();
  });

  test('does not show a setup CTA while prerequisite discovery is still pending', () => {
    // The pending snapshot is an all-false placeholder; it must not read as
    // "no chat configured" until discovery settles (chat-dock-maximize-readiness).
    currentStatus = createStatus({ prerequisitesState: 'pending' });

    render(<ChatEmptyState agentSlug="dev-agent" agentName="Dev Agent" />);

    expect(screen.queryByTestId('chat-empty-state-unconfigured')).toBeNull();
  });

  test('shows a guided setup CTA when no provider is configured', () => {
    currentStatus = createStatus();

    render(<ChatEmptyState agentSlug="dev-agent" agentName="Dev Agent" />);

    expect(screen.getByTestId('chat-empty-state-unconfigured')).toBeTruthy();
    expect(screen.getByText('Connect a model to start chatting')).toBeTruthy();
    expect(screen.queryByText('Start a conversation')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Connections' }));

    expect(navigate).toHaveBeenCalledWith('/connections/models');
  });

  test("routes an engine attention CTA to that engine's Agent Apps configuration", () => {
    currentStatus = createStatus({
      externalEngines: [
        {
          engineId: engineId('codex'),
          name: 'Codex',
          engineConnectionId: engineConnectionId('codex'),
          detected: true,
          ready: false,
          source: null,
          reason: 'sign_in_required',
        },
      ],
    });

    render(<ChatEmptyState agentSlug="dev-agent" agentName="Dev Agent" />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to Codex' }));
    expect(navigate).toHaveBeenCalledWith('/connections/engines/codex');
  });

  test('keeps model setup contextual for a Station agent when only a coding engine is available', () => {
    currentStatus = createStatus({
      recommendation: {
        code: 'runtime-only',
        type: 'runtimes',
        actionLabel: 'Review runtimes',
        title: 'An engine is available before chat is configured',
        detail:
          'Connected runtimes are detectable, but there is still no explicit chat-capable model connection configured.',
      },
      clis: { codex: true },
    });
    render(<ChatEmptyState agentSlug="dev-agent" agentName="Dev Agent" />);

    expect(screen.getByTestId('chat-empty-state-unconfigured')).toBeTruthy();
    expect(screen.getByText('Dev Agent needs a model connection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Connections' }));
    expect(navigate).toHaveBeenCalledWith('/connections/models');
  });

  test('does not block a connected runtime chat when no model connection exists', () => {
    currentStatus = createStatus({
      recommendation: {
        code: 'runtime-only',
        type: 'runtimes',
        actionLabel: 'Review runtimes',
        title: 'An engine is available before chat is configured',
        detail:
          'Connected runtimes are detectable, but there is still no explicit chat-capable model connection configured.',
      },
      clis: { codex: true },
    });
    currentAgents = [
      {
        slug: 'codex',
        name: 'Codex',
        engineId: 'codex',
        engineDisplayName: 'Codex',
        execution: { agentConnectionId: 'codex' },
      },
    ];

    render(<ChatEmptyState agentSlug="codex" agentName="Codex" />);

    expect(screen.getByText('Start a conversation')).toBeTruthy();
    expect(screen.queryByTestId('chat-empty-state-unconfigured')).toBeNull();
  });

  // archive#1193: a user-authored agent bound to an external
  // engine fell through and wrongly showed "needs a model connection"
  // (observed live on the dogfood). The fix resolves the agent's real engine
  // (`agentEngineDescriptor`, the same resolver the engine chip uses) instead
  // of guessing from id shape.
  describe('engine-agnostic readiness gate for user-authored agents (station#1193)', () => {
    test('does not show "needs a model connection" for a user-authored agent bound to an external engine', () => {
      currentStatus = createStatus({
        recommendation: RUNTIME_ONLY_RECOMMENDATION,
      });
      currentAgents = [
        {
          slug: 'claude-code-chat',
          name: 'Claude Code Chat',
          engineId: 'claude-code',
          engineDisplayName: 'Claude Code',
          execution: { agentConnectionId: 'claude-custom' },
        },
      ];

      render(
        <ChatEmptyState
          agentSlug="claude-code-chat"
          agentName="Claude Code Chat"
        />,
      );

      expect(screen.getByText('Start a conversation')).toBeTruthy();
      expect(screen.queryByTestId('chat-empty-state-unconfigured')).toBeNull();
    });

    test('still shows "needs a model connection" for a user-authored Station-engine agent', () => {
      currentStatus = createStatus({
        recommendation: RUNTIME_ONLY_RECOMMENDATION,
      });
      currentAgents = [
        {
          slug: 'dev-agent',
          name: 'Dev Agent',
          engineId: 'station',
        },
      ];

      render(<ChatEmptyState agentSlug="dev-agent" agentName="Dev Agent" />);

      expect(screen.getByTestId('chat-empty-state-unconfigured')).toBeTruthy();
      expect(
        screen.getByText('Dev Agent needs a model connection'),
      ).toBeTruthy();
    });

    // archive#1193: `useAgents` alone cannot tell "still
    // loading" from "durably empty" — both read as `[]`. Without gating on
    // `useAgentsLoaded`, a cold load where `status` resolves first would
    // read a genuine external-engine-bound agent as unresolved and flash the
    // wrong "needs a model connection" copy for one render before
    // self-correcting once the catalog lands.
    test('does not flash "needs a model connection" while the agent catalog is still loading', () => {
      currentStatus = createStatus({
        recommendation: RUNTIME_ONLY_RECOMMENDATION,
      });
      currentAgentsLoaded = false;
      currentAgents = [];

      render(
        <ChatEmptyState
          agentSlug="claude-code-chat"
          agentName="Claude Code Chat"
        />,
      );

      expect(screen.getByText('Start a conversation')).toBeTruthy();
      expect(screen.queryByTestId('chat-empty-state-unconfigured')).toBeNull();
    });
  });
});

import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
