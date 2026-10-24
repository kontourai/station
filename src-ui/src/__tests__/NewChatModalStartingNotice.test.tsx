// @vitest-environment jsdom

/**
 * Automatic preparation connected an app whose first start is still running
 * (EngineStillStartingError). Its notice must reach the person; the built-in
 * Station agent, which is always in the list and here has no model
 * connection, must not take its place.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { NewChatModal } from '../components/modals/NewChatModal';
import { buildNewChatModalViewModel } from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';

const STARTING =
  'Kiro CLI is still starting for the first time. If it connects while Station is running, its Agent is added then; otherwise add it again later.';

vi.mock('../components/modals/AutomaticEnginePreparation', async (actual) => {
  const { useEffect } = await import('react');
  return {
    ...(await actual<object>()),
    AutomaticEnginePreparation: ({
      onStart,
      onComplete,
    }: {
      onStart: () => void;
      onComplete: (
        engineId?: string,
        failure?: string,
        notice?: string,
      ) => void;
    }) => {
      useEffect(() => {
        onStart();
        onComplete('kiro', undefined, STARTING);
      }, [onStart, onComplete]);
      return null;
    },
  };
});
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => undefined,
}));
vi.mock('../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({
    namespace: 'authority-1',
    status: 'verified',
  }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useAgentsQuery: () => ({ data: [] }),
  useConfigQuery: () => ({ data: {}, dataUpdatedAt: 1, refetch: vi.fn() }),
  useSkillExperienceInventoryQuery: () => ({
    data: { experiences: [], diagnostics: [] },
    refetch: vi.fn(),
  }),
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/useIsMobile', async (importActual) => ({
  ...(await importActual<typeof import('../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));
vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: (
    input: Parameters<typeof buildNewChatModalViewModel>[0],
  ) => {
    const [modelChoices, setModelChoices] = useState({});
    const [modelPickerAgent, setModelPickerAgent] = useState<AgentData | null>(
      null,
    );
    return {
      viewModel: buildNewChatModalViewModel({
        ...input,
        agentConnections: [],
        layoutAvailableAgents: [],
        recentSlugs: [],
      }),
      defaultSelection: {
        agent: input.agents.find((agent) => agent.available !== false),
      },
      runtimeLoading: false,
      modelsLoading: false,
      runtimeFetching: false,
      modelsFetching: false,
      runtimeError: undefined,
      modelConnections: [],
      refetchAgentConnections: vi.fn(),
      refetchModelConnections: vi.fn(),
      modelChoices,
      setModelChoices,
      modelPickerAgent,
      setModelPickerAgent,
      modelsForAgent: () => [],
      executionModelsForAgent: () => [],
      modelChoiceKey: (agent: AgentData) => agent.slug,
      defaultEffectiveModelForAgent: () => undefined,
    };
  },
}));

/** The built-in Station agent on a home with no model connection. */
const STATION_AGENT = {
  slug: 'station',
  name: 'Station',
  available: false,
  unavailableReason: 'No enabled LLM provider connection',
  unavailableFix: { kind: 'model-connection' },
} as AgentData;

beforeAll(() => {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

test('an app still on its first start is reported, not replaced by the Station agent', async () => {
  render(
    <NewChatModal
      agents={[STATION_AGENT]}
      projects={[]}
      onSelect={vi.fn()}
      onClose={vi.fn()}
      projectIconBySlug={new Map()}
      startWithDefault
    />,
  );

  expect(await screen.findByText('Your AI app is still starting')).toBeTruthy();
  expect(screen.getByText(STARTING)).toBeTruthy();
  expect(screen.queryByText(/Station needs one thing/)).toBeNull();
});
