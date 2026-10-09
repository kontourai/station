// @vitest-environment jsdom
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { GLOBAL_CONTEXT } from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';
import { AuthorityPersistenceContext } from '../contexts/AuthorityPersistenceContext';
import type { ProjectMetadata } from '../contexts/ProjectsContext';
import {
  buildLastChosenModelBindingKey,
  trackLastChosenModel,
} from '../hooks/lastChosenModel';
import { useNewChatSelectionModel } from '../hooks/useNewChatSelectionModel';
import { trackContextAgent } from '../hooks/useRecentAgents';

const state = vi.hoisted(() => ({
  agents: [] as unknown[],
  reconciling: false,
  readRevision: 0,
  refetchAgents: vi.fn(async () => ({})),
  projects: [] as unknown[],
  projectDetailSuccess: true,
  picker: {
    agentConnections: [] as unknown[],
    modelConnections: [] as unknown[],
  },
}));
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'ui-scope-test-authority',
    isCurrent: () => true,
  }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAgentsQuery: () => ({
    data: state.agents,
    isFetching: false,
    error: null,
    catalogState: state.reconciling ? 'reconciling' : undefined,
    dataUpdatedAt: state.readRevision,
    refetch: state.refetchAgents,
  }),
  useProjectsQuery: () => ({
    data: state.projects,
    isFetching: false,
    isSuccess: true,
    error: null,
    refetch: async () => ({}),
  }),
  useModelPickerCatalogQuery: () => ({
    data: state.picker,
    isLoading: false,
    isFetching: false,
    error: null,
    refetch: async () => ({}),
  }),
  useACPConnectionsQuery: () => ({
    data: [],
    isFetching: false,
    error: null,
    refetch: async () => ({}),
  }),
  useProjectLayoutQuery: () => ({ data: undefined }),
  useProjectQuery: () => ({
    data: {},
    isFetching: false,
    isSuccess: state.projectDetailSuccess,
    error: null,
    refetch: async () => ({}),
  }),
}));
vi.mock('../contexts/ConfigContext', () => ({ useConfig: () => undefined }));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ selectedProject: null, selectedProjectLayout: null }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  activeChatsStore: { getSnapshot: () => ({}) },
}));
const OLD = {
  slug: 'assistant',
  name: 'Assistant',
  available: true,
  model: 'old',
  modelOptions: [{ id: 'old', name: 'Old' }],
} as AgentData;
const PROJECT = {
  slug: 'alpha',
  name: 'Alpha',
  layoutCount: 0,
} as ProjectMetadata;
beforeEach(() => {
  state.reconciling = false;
  state.readRevision = 0;
  state.refetchAgents.mockReset();
  state.refetchAgents.mockImplementation(async () => ({}));
  state.agents = [OLD];
  state.projects = [PROJECT];
  state.picker = { agentConnections: [], modelConnections: [] };
  state.projectDetailSuccess = true;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('returned New Chat uses current canonical rows within caller scope', () => {
  test('refreshes unchanged retained rows until the goal catalog is current', async () => {
    vi.useFakeTimers();
    state.reconciling = true;
    const view = renderHook(() =>
      useNewChatSelectionModel({
        agents: [OLD],
        projects: [PROJECT],
        selectedContext: 'alpha',
        revalidateSelection: true,
      }),
    );
    expect(view.result.current.setupFetching).toBe(true);
    state.refetchAgents.mockImplementationOnce(async () => {
      state.readRevision++;
      view.rerender();
      return {};
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(state.refetchAgents).toHaveBeenCalledTimes(1);
    state.refetchAgents.mockImplementationOnce(async () => {
      state.reconciling = false;
      state.readRevision++;
      view.rerender();
      return {};
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(state.refetchAgents).toHaveBeenCalledTimes(2);
    expect(view.result.current.setupFetching).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(state.refetchAgents).toHaveBeenCalledTimes(2);
  });
  test('same Agent ID cannot retain old readiness or Model configuration', () => {
    const view = renderHook(
      ({ returned }) =>
        useNewChatSelectionModel({
          agents: [OLD],
          projects: [PROJECT],
          selectedContext: 'alpha',
          revalidateSelection: returned,
        }),
      { initialProps: { returned: false } },
    );
    expect(view.result.current.viewModel.flatList[0].available).toBe(true);
    const current = {
      ...OLD,
      available: false,
      unavailableReason: 'Authorization revoked',
      model: 'new',
      modelOptions: [{ id: 'new', name: 'New' }],
    };
    state.agents = [current];
    view.rerender({ returned: true });
    const shown = view.result.current.viewModel.flatList[0];
    expect(shown.available).toBe(false);
    expect(shown.unavailableReason).toBe('Authorization revoked');
    expect(
      view.result.current.modelsForAgent(shown).map((model) => model.id),
    ).toEqual(['new']);
    expect(view.result.current.defaultEffectiveModelForAgent(shown).id).toBe(
      'new',
    );
  });
  test('refresh cannot widen the caller scope or substitute a deleted Project', () => {
    state.agents = [OLD, { ...OLD, slug: 'outside-scope' }];
    state.projects = [];
    const view = renderHook(() =>
      useNewChatSelectionModel({
        agents: [OLD],
        projects: [PROJECT],
        selectedContext: 'alpha',
        revalidateSelection: true,
      }),
    );
    expect(
      view.result.current.viewModel.flatList.map((agent) => agent.slug),
    ).toEqual(['assistant']);
    expect(view.result.current.viewModel.selectedProject).toBeUndefined();
    expect(view.result.current.viewModel.currentContextOption).toBeUndefined();
    expect(view.result.current.viewModel.isGlobal).toBe(false);
  });

  test('offered cross-engine routes refuse known profile capability loss while leaving unknown support undecided', () => {
    const profile: AgentData = {
      slug: agentId('reviewer'),
      name: 'Reviewer',
      available: true,
      profileCapabilities: ['instructions', 'toolSelection'],
      execution: { agentConnectionId: engineConnectionId('claude') },
    };
    const initialBinding: AgentData = {
      slug: agentId('codex'),
      name: 'Codex',
      available: true,
      engineDefault: true,
      executionDefault: true,
      unsupportedProfileCapabilities: ['toolSelection'],
      execution: { agentConnectionId: engineConnectionId('codex') },
    };
    let binding = initialBinding;
    const connection = (id: string): AgentConnectionView => ({
      id: engineConnectionId(id),
      kind: 'agent',
      type: id,
      name: id,
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: {},
      setup: { state: 'ready', detected: true, configured: true },
      runtimeCatalog: {
        source: 'live',
        models: [{ id: 'model', name: 'Model', originalId: 'model' }],
        builtInModels: [],
      },
    });
    state.picker = {
      agentConnections: [connection('claude'), connection('codex')],
      modelConnections: [],
    };
    const view = renderHook(() =>
      useNewChatSelectionModel({
        agents: [profile, binding],
        projects: [],
        selectedContext: GLOBAL_CONTEXT,
      }),
    );
    const blocked = view.result.current
      .executionModelsForAgent(profile)
      .find((model) => model.executionAgentId === binding.slug);
    expect(blocked?.available).toBe(false);
    expect(blocked?.unavailableReason).toContain('tool restrictions');
    binding = { ...initialBinding, unsupportedProfileCapabilities: [] };
    view.rerender();
    const supported = view.result.current
      .executionModelsForAgent(profile)
      .find((model) => model.executionAgentId === binding.slug);
    expect(supported).toBeDefined();
    expect(supported?.available).not.toBe(false);
    expect(supported?.unavailableReason).toBeUndefined();
    binding = { ...initialBinding, unsupportedProfileCapabilities: undefined };
    view.rerender();
    const unknown = view.result.current
      .executionModelsForAgent(profile)
      .find((model) => model.executionAgentId === binding.slug);
    expect(unknown).toBeDefined();
    expect(unknown?.available).not.toBe(false);
    expect(unknown?.unavailableReason).toBeUndefined();
  });

  test('model list comes from the persisted picker catalog, not raw connections', () => {
    const agent = {
      ...OLD,
      execution: { agentConnectionId: 'codex' },
    } as AgentData;
    state.agents = [agent];
    state.picker = {
      agentConnections: [
        {
          id: 'codex',
          kind: 'agent',
          type: 'codex',
          name: 'Codex',
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          prerequisites: [],
          config: {},
          setup: { state: 'ready', detected: true, configured: true },
          runtimeCatalog: {
            source: 'live',
            models: [
              {
                id: 'gpt-6-astra',
                name: 'GPT-6-Astra',
                originalId: 'gpt-6-astra',
              },
            ],
            builtInModels: [],
          },
        },
      ],
      modelConnections: [],
    };
    const view = renderHook(() =>
      useNewChatSelectionModel({
        agents: [agent],
        projects: [PROJECT],
        selectedContext: 'alpha',
      }),
    );
    expect(
      view.result.current.modelsForAgent(agent).map((model) => model.id),
    ).toEqual(['gpt-6-astra']);
  });
});

// #3312 review: Home stays mounted and names the default selection Start
// will use, so the selection must follow what it is derived from.
describe('the default selection stays current for a mounted surface', () => {
  const TWO_MODELS = {
    ...OLD,
    modelOptions: [
      { id: 'old', name: 'Old' },
      { id: 'newer', name: 'Newer' },
    ],
  } as AgentData;

  test('a Model chosen elsewhere meanwhile becomes the default', () => {
    state.agents = [TWO_MODELS];
    const view = renderHook(() =>
      useNewChatSelectionModel({
        agents: [TWO_MODELS],
        projects: [PROJECT],
        selectedContext: GLOBAL_CONTEXT,
      }),
    );
    expect(view.result.current.defaultSelection.effectiveModel.id).toBe('old');
    act(() =>
      trackLastChosenModel(buildLastChosenModelBindingKey(TWO_MODELS), 'newer'),
    );
    expect(view.result.current.defaultSelection.effectiveModel.id).toBe(
      'newer',
    );
  });

  test('an Agent remembered elsewhere meanwhile becomes the default', () => {
    const OTHER = { ...OLD, slug: 'other', name: 'Other' } as AgentData;
    state.agents = [OLD, OTHER];
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthorityPersistenceContext.Provider
        value={{ status: 'verified', namespace: 'ns-1', observation: null }}
      >
        {children}
      </AuthorityPersistenceContext.Provider>
    );
    const view = renderHook(
      () =>
        useNewChatSelectionModel({
          agents: [OLD, OTHER],
          projects: [PROJECT],
          selectedContext: GLOBAL_CONTEXT,
        }),
      { wrapper },
    );
    expect(view.result.current.defaultSelection.agent?.slug).toBe('assistant');
    // Another surface (the dock's draft) remembers a choice for this
    // context; this mounted surface follows without remounting.
    act(() => trackContextAgent('ns-1', '__global__', 'other'));
    expect(view.result.current.defaultSelection.agent?.slug).toBe('other');
    // A choice for a different context leaves this one alone.
    act(() => trackContextAgent('ns-1', 'alpha', 'assistant'));
    expect(view.result.current.defaultSelection.agent?.slug).toBe('other');
  });

  test('a project context is resolved only once its detail has loaded', () => {
    state.projectDetailSuccess = false;
    const select = (selectedContext: string) =>
      renderHook(() =>
        useNewChatSelectionModel({
          agents: [OLD],
          projects: [PROJECT],
          selectedContext,
        }),
      ).result.current.selectedContextResolved;
    expect(select('alpha')).toBe(false);
    expect(select('__global__')).toBe(true);
    state.projectDetailSuccess = true;
    expect(select('alpha')).toBe(true);
  });
});
