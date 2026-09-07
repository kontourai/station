// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentData } from '../contexts/AgentsContext';
import type { ProjectMetadata } from '../contexts/ProjectsContext';
import { useNewChatSelectionModel } from '../hooks/useNewChatSelectionModel';

const state = vi.hoisted(() => ({
  agents: [] as unknown[],
  projects: [] as unknown[],
}));
vi.mock('@kontourai/station-sdk', () => ({
  useAgentsQuery: () => ({
    data: state.agents,
    isFetching: false,
    error: null,
    catalogState: 'current',
    refetch: async () => ({}),
  }),
  useProjectsQuery: () => ({
    data: state.projects,
    isFetching: false,
    isSuccess: true,
    error: null,
    refetch: async () => ({}),
  }),
  useEngineConnectionsQuery: () => ({
    data: [],
    isFetching: false,
    error: null,
    refetch: async () => ({}),
  }),
  useModelConnectionsQuery: () => ({
    data: [],
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
  state.agents = [OLD];
  state.projects = [PROJECT];
});

describe('returned New Chat uses current canonical rows within caller scope', () => {
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
});
