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
  firstSignedInEngine,
  GLOBAL_CONTEXT,
  newChatFallbackAgent,
} from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';
import { useNewChatSelectionModel } from '../hooks/useNewChatSelectionModel';
import { resetRecordNewChatDefaultForTests } from '../hooks/useRecordNewChatDefault';

const state = vi.hoisted(() => ({
  config: undefined as Record<string, unknown> | undefined,
  capability: true as boolean | null,
  connections: [] as unknown[],
  /** The engine connections read in full, prerequisites included. */
  engines: [] as unknown[],
  catalogFetching: false,
  record: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useNewChatDefaultCapability: () => ({ data: state.capability }),
  useRecordNewChatDefaultMutation: () => ({ mutate: state.record }),
  useEngineConnectionsQuery: () => ({ data: state.engines, isFetching: false }),
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

/**
 * The connection a ready engine is served with in the picker catalog, which
 * projects prerequisites away.
 */
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
    prerequisites: [],
  };
}

/**
 * The same connection as the engine connections read serves it, with the
 * rows `buildCliRuntimePrerequisites` writes: `verified` is a login Station
 * checked and found signed in; `unchecked` is the optional row it writes
 * for an engine with no sign-in check.
 */
function engine(
  id: string,
  name: string,
  login:
    | 'verified'
    | 'signed-out'
    | 'unknown'
    | 'unchecked'
    | 'none' = 'verified',
) {
  const prerequisites = [
    {
      id: `${id}-cli`,
      name: `${name} CLI`,
      description: `Required to launch the ${name} engine.`,
      status: 'installed',
      category: 'required',
      installGuide: { steps: [`Install ${name}`] },
    },
    ...(login === 'none'
      ? []
      : [
          {
            id: `${id}-auth`,
            name: `${name} login`,
            description:
              login === 'verified'
                ? `${name} CLI credentials are present on this Station.`
                : login === 'signed-out'
                  ? `${name} CLI is not authenticated.`
                  : login === 'unknown'
                    ? `${name} CLI authentication could not be verified safely.`
                    : `${name} sign-in is not checked.`,
            status:
              login === 'verified'
                ? 'installed'
                : login === 'signed-out'
                  ? 'missing'
                  : 'error',
            category: login === 'unchecked' ? 'optional' : 'required',
            installGuide: { steps: [`Sign in to ${name}`] },
          },
        ]),
  ];
  return { ...connection(id, name), prerequisites };
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
  state.engines = [];
  state.record.mockReset();
  localStorage.clear();
});
afterEach(() => cleanup());

/** Each engine signed in as `engine()` describes, and ready in the catalog. */
function signedIn(...engines: ReturnType<typeof engine>[]) {
  state.engines = engines;
  state.connections = engines.map((entry) => connection(entry.id, entry.name));
}

describe('the default for new chats', () => {
  test('a second engine becoming ready does not move the stored default', () => {
    const stored: NewChatDefault = {
      agent: agentId('codex'),
      reason: 'first-signed-in',
    };
    state.config = { defaultModel: '', newChatDefault: stored };
    signedIn(engine('codex', 'Codex'));
    const view = renderSelection([
      STATION,
      engineAgent('claude', 'Claude Code', false),
      engineAgent('codex', 'Codex', true),
    ]);
    expect(view.result.current.defaultSelection.agent?.slug).toBe('codex');

    // Claude Code signs in. It is first in the fixed order, and the default
    // stays on Codex because Codex is what Station recorded.
    signedIn(engine('claude', 'Claude Code'), engine('codex', 'Codex'));
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
    signedIn(engine('claude', 'Claude Code'));
    const view = renderSelection([
      STATION,
      engineAgent('claude', 'Claude Code', true),
      engineAgent('codex', 'Codex', false),
    ]);
    expect(view.result.current.defaultSelection.agent?.slug).toBe('claude');
    expect(view.result.current.newChatDefaultSlug).toBe('codex');
    expect(state.record).not.toHaveBeenCalled();
  });

  test('a stale stored default with nothing able to start is not reported as a missing Agent', () => {
    state.config = {
      defaultModel: '',
      newChatDefault: { agent: 'deleted-agent', reason: 'chosen' },
    };
    const view = renderSelection([engineAgent('claude', 'Claude Code', false)]);
    expect(view.result.current.defaultSelection.agent).toBeUndefined();
    expect(
      view.result.current.defaultSelection.missingPreferredAgentSlug,
    ).toBeUndefined();
  });

  test('with none stored, Station records the first engine signed in, in fixed order', () => {
    signedIn(engine('codex', 'Codex'));
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

  test('Station’s own engine is the fallback, never recorded; Claude Code is recorded once it signs in', () => {
    signedIn(engine('claude', 'Claude Code', 'signed-out'));
    const view = renderSelection([
      STATION,
      engineAgent('claude', 'Claude Code', false),
    ]);
    expect(view.result.current.defaultSelection.agent?.slug).toBe('station');
    expect(state.record).not.toHaveBeenCalled();

    signedIn(engine('claude', 'Claude Code'));
    view.rerender({
      list: [STATION, engineAgent('claude', 'Claude Code', true)],
    });
    expect(state.record).toHaveBeenCalledTimes(1);
    expect(state.record).toHaveBeenCalledWith({
      agent: 'claude',
      reason: 'first-signed-in',
    });
    expect(view.result.current.defaultSelection.agent?.slug).toBe('claude');
  });

  test('an engine whose sign-in Station cannot check is the fallback, never recorded', () => {
    // first-run-03: Claude Code signed out, OpenCode runs with sign-in not
    // checked (no login row, as an ACP engine has none).
    // Gemini's check ran and could not tell: a required login row that is
    // errored, not met.
    signedIn(
      engine('claude', 'Claude Code', 'signed-out'),
      engine('opencode', 'OpenCode', 'none'),
      engine('muse', 'Muse Code', 'unchecked'),
      engine('gemini', 'Gemini CLI', 'unknown'),
    );
    const view = renderSelection([
      engineAgent('claude', 'Claude Code', false),
      engineAgent('opencode', 'OpenCode', true),
      engineAgent('muse', 'Muse Code', true),
      engineAgent('gemini', 'Gemini CLI', true),
    ]);
    expect(view.result.current.defaultSelection.agent?.slug).toBe('gemini');
    expect(state.record).not.toHaveBeenCalled();
  });

  test('an Agent someone authored on Claude Code does not take Claude Code out of the order', () => {
    signedIn(engine('claude', 'Claude Code'), engine('codex', 'Codex'));
    const alias = {
      ...engineAgent('claude', 'Claude Code', true),
      engineDefault: true,
    } as AgentData;
    const reviewer = {
      slug: agentId('reviewer'),
      name: 'Reviewer',
      available: true,
      execution: { agentConnectionId: engineConnectionId('claude') },
    } as AgentData;
    const view = renderSelection([
      STATION,
      reviewer,
      alias,
      engineAgent('codex', 'Codex', true),
    ]);
    expect(state.record).toHaveBeenCalledWith({
      agent: 'claude',
      reason: 'first-signed-in',
    });
    expect(view.result.current.defaultSelection.agent?.slug).toBe('claude');
  });

  test('nothing is recorded while the engine first in line is not yet selectable', () => {
    // Claude Code is signed in and the catalog says it can run; its
    // connection has not turned ready. Recording now would hand the
    // default to Codex.
    state.engines = [engine('claude', 'Claude Code'), engine('codex', 'Codex')];
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
    signedIn(engine('codex', 'Codex'));
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

describe('the fixed order', () => {
  const claude = engineAgent('claude', 'Claude Code', true);
  const codex = engineAgent('codex', 'Codex', true);
  const opencode = engineAgent('opencode', 'OpenCode', true);
  const gemini = engineAgent('gemini', 'Gemini CLI', true);
  const authored = {
    slug: agentId('reviewer'),
    name: 'Reviewer',
    available: true,
    execution: { agentConnectionId: engineConnectionId('claude') },
  } as AgentData;

  test('Claude Code, Codex, other engines, then Station; never an authored Agent', () => {
    expect(
      newChatFallbackAgent([authored, STATION, opencode, codex, claude]),
    ).toBe(claude);
    expect(newChatFallbackAgent([authored, STATION, opencode, codex])).toBe(
      codex,
    );
    expect(newChatFallbackAgent([authored, STATION, opencode])).toBe(opencode);
    expect(newChatFallbackAgent([authored, STATION])).toBe(STATION);
    expect(newChatFallbackAgent([authored])).toBeUndefined();
  });

  test('other engines are ordered by engine id, whatever the list order', () => {
    expect(newChatFallbackAgent([opencode, gemini])).toBe(gemini);
    expect(newChatFallbackAgent([gemini, opencode])).toBe(gemini);
    const verified = () => true;
    expect(firstSignedInEngine([opencode, gemini], verified)).toBe(gemini);
    expect(firstSignedInEngine([gemini, opencode], verified)).toBe(gemini);
  });

  test('only a verified engine is recordable, and Station never is', () => {
    const verifiedIds = new Set(['codex']);
    const verified = (agent: AgentData) => verifiedIds.has(agent.slug);
    expect(firstSignedInEngine([STATION, claude, codex], verified)).toBe(codex);
    expect(firstSignedInEngine([STATION, opencode], () => true)).toBe(opencode);
    expect(firstSignedInEngine([STATION], () => true)).toBeUndefined();
  });

  test('an engine alias another of that engine’s own Agents stands in for is never picked', () => {
    const alias = { ...claude, engineDefault: true } as AgentData;
    const materialized = {
      ...claude,
      slug: agentId('claude-code'),
    } as AgentData;
    expect(newChatFallbackAgent([alias, materialized])).toBe(materialized);
    expect(newChatFallbackAgent([authored, alias])).toBe(alias);
  });
});
