// @vitest-environment jsdom
import {
  agentId,
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import type { NewChatDefault } from '@kontourai/station-contracts/config';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  firstSignedInAgent,
  GLOBAL_CONTEXT,
} from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';
import { useNewChatSelectionModel } from '../hooks/useNewChatSelectionModel';
import { resetRecordNewChatDefaultForTests } from '../hooks/useRecordNewChatDefault';

const state = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  capability: true as boolean | null,
  connections: [] as unknown[],
  catalogFetching: false,
  record: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useNewChatDefaultCapability: () => ({ data: state.capability }),
  useRecordNewChatDefaultMutation: () => ({ mutate: state.record }),
  useAgentsQuery: () => ({
    data: [],
    isFetching: false,
    error: null,
    catalogState: undefined,
    dataUpdatedAt: 0,
    refetch: async () => ({}),
  }),
  useProjectsQuery: () => ({
    data: [],
    isFetching: false,
    isSuccess: true,
    error: null,
    refetch: async () => ({}),
  }),
  useModelPickerCatalogQuery: () => ({
    data: { agentConnections: state.connections, modelConnections: [] },
    isLoading: false,
    isFetching: state.catalogFetching,
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
    isSuccess: true,
    error: null,
    refetch: async () => ({}),
  }),
  useProjectChatDefaultsQuery: () => ({
    data: undefined,
    isFetching: false,
    isPending: false,
  }),
}));
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'new-chat-default-authority',
    isCurrent: () => true,
  }),
}));
vi.mock('../contexts/ConfigContext', () => ({
  useConfig: () => state.config,
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ selectedProject: null, selectedProjectLayout: null }),
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  activeChatsStore: { getSnapshot: () => ({}) },
}));

/** An engine's own Agent, as the enriched catalog serves a detected engine. */
function engineAgent(id: string, name: string, available: boolean): AgentData {
  return {
    slug: agentId(id),
    name,
    available,
    ...(available ? {} : { unavailableReason: `${name} is not signed in.` }),
    engineId: engineId(id),
    engineDisplayName: name,
    engineConnectionType: id,
    provenance: {
      origin: 'engine-detection',
      engineId: id,
      detectedAt: '2026-11-22T00:00:00Z',
    },
    execution: { agentConnectionId: engineConnectionId(id) },
  } as AgentData;
}

/** The connection a ready engine is served with in the picker catalog. */
function connection(id: string, name: string, status = 'ready') {
  return {
    id,
    name,
    type: id,
    kind: 'agent',
    config: {},
    enabled: true,
    status,
    capabilities: ['agent-runtime'],
  };
}

const STATION = {
  slug: agentId('station'),
  name: 'Station Assistant',
  available: true,
} as AgentData;

function renderSelection(agents: AgentData[]) {
  return renderHook(
    ({ list }) =>
      useNewChatSelectionModel({
        agents: list,
        projects: [],
        selectedContext: GLOBAL_CONTEXT,
      }),
    { initialProps: { list: agents } },
  );
}

beforeEach(() => {
  resetRecordNewChatDefaultForTests();
  state.config = { defaultModel: '' };
  state.capability = true;
  state.catalogFetching = false;
  state.connections = [];
  state.record.mockReset();
  localStorage.clear();
});
afterEach(() => cleanup());

describe('the default for new chats', () => {
  test('a second engine becoming ready does not move the stored default', () => {
    const stored: NewChatDefault = {
      agent: agentId('codex'),
      reason: 'first-signed-in',
    };
    state.config = { defaultModel: '', newChatDefault: stored };
    state.connections = [connection('codex', 'Codex')];
    const view = renderSelection([
      STATION,
      engineAgent('claude', 'Claude Code', false),
      engineAgent('codex', 'Codex', true),
    ]);
    expect(view.result.current.defaultSelection.agent?.slug).toBe('codex');

    // Claude Code signs in. It is first in the fixed order, and the default
    // stays on Codex because Codex is what Station recorded.
    state.connections = [
      connection('claude', 'Claude Code'),
      connection('codex', 'Codex'),
    ];
    view.rerender({
      list: [
        STATION,
        engineAgent('claude', 'Claude Code', true),
        engineAgent('codex', 'Codex', true),
      ],
    });
    expect(view.result.current.defaultSelection.agent?.slug).toBe('codex');
    expect(view.result.current.newChatDefaultSlug).toBe('codex');
    expect(state.record).not.toHaveBeenCalled();
  });

  test('a stored default that cannot start is passed over for this chat and kept', () => {
    state.config = {
      defaultModel: '',
      newChatDefault: { agent: 'codex', reason: 'first-signed-in' },
    };
    state.connections = [connection('claude', 'Claude Code')];
    const view = renderSelection([
      STATION,
      engineAgent('claude', 'Claude Code', true),
      engineAgent('codex', 'Codex', false),
    ]);
    expect(view.result.current.defaultSelection.agent?.slug).toBe('claude');
    expect(view.result.current.newChatDefaultSlug).toBe('codex');
    expect(state.record).not.toHaveBeenCalled();
  });

  test('with none stored, Station records the first engine signed in, in fixed order', () => {
    state.connections = [connection('codex', 'Codex')];
    const view = renderSelection([
      STATION,
      engineAgent('claude', 'Claude Code', false),
      engineAgent('codex', 'Codex', true),
    ]);
    // Station's own Agent is listed first and can run, but an engine that
    // is signed in comes before it.
    expect(view.result.current.defaultSelection.agent?.slug).toBe('codex');
    expect(state.record).toHaveBeenCalledTimes(1);
    expect(state.record).toHaveBeenCalledWith({
      agent: 'codex',
      reason: 'first-signed-in',
    });
  });

  test('nothing is recorded while the engine first in line is not yet selectable', () => {
    // The catalog already says Claude Code can run; its connection has not
    // turned ready. Recording now would hand the default to Codex.
    state.connections = [
      connection('claude', 'Claude Code', 'degraded'),
      connection('codex', 'Codex'),
    ];
    renderSelection([
      engineAgent('claude', 'Claude Code', true),
      engineAgent('codex', 'Codex', true),
    ]);
    expect(state.record).not.toHaveBeenCalled();
  });

  test('nothing is recorded while reads settle, or on a host without the record', () => {
    state.connections = [connection('codex', 'Codex')];
    const agents = [engineAgent('codex', 'Codex', true)];
    state.catalogFetching = true;
    renderSelection(agents);
    cleanup();
    state.catalogFetching = false;
    state.capability = false;
    renderSelection(agents);
    cleanup();
    state.capability = true;
    state.config = undefined;
    renderSelection(agents);
    expect(state.record).not.toHaveBeenCalled();
  });
});

describe('firstSignedInAgent', () => {
  test('Claude Code, Codex, other engines as listed, then Station; never an authored Agent', () => {
    const opencode = engineAgent('opencode', 'OpenCode', true);
    const authored = {
      slug: agentId('reviewer'),
      name: 'Reviewer',
      available: true,
      execution: { agentConnectionId: engineConnectionId('claude') },
    } as AgentData;
    const claude = engineAgent('claude', 'Claude Code', true);
    const codex = engineAgent('codex', 'Codex', true);
    expect(
      firstSignedInAgent([authored, STATION, opencode, codex, claude]),
    ).toBe(claude);
    expect(firstSignedInAgent([authored, STATION, opencode, codex])).toBe(
      codex,
    );
    expect(firstSignedInAgent([authored, STATION, opencode])).toBe(opencode);
    expect(firstSignedInAgent([authored, STATION])).toBe(STATION);
    expect(firstSignedInAgent([authored])).toBeUndefined();
  });

  test('an engine alias another Agent on that engine stands in for is never picked', () => {
    const alias = {
      ...engineAgent('claude', 'Claude Code', true),
      engineDefault: true,
    } as AgentData;
    const materialized = {
      ...engineAgent('claude', 'Claude Code', true),
      slug: agentId('claude-code'),
    } as AgentData;
    expect(firstSignedInAgent([alias, materialized])).toBe(materialized);
  });
});
