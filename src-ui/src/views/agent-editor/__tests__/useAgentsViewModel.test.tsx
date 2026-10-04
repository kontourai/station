/**
 * @vitest-environment jsdom
 *
 * and for the Agents view model.
 *
 * after Create, the list must already contain the new Agent and it must
 * be the selected one, with no reload; and "Loading agent…" must be BOUNDED.
 * A detail read that never resolves used to leave that line on screen forever
 * with nothing to press.
 *
 * `engineDefault` is no longer a lock. It used to be, and a fresh
 * install's only four agents therefore opened as a six-tab editor with every
 * field disabled, a dead Delete, and a Save styled as an active primary that
 * could never save. The Skills tab's `+ Add` keys off the same `locked`, which
 * is why no skill could be attached to anything on a fresh home.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentData } from '../../../contexts/AgentsContext';

const state = {
  agents: [] as AgentData[],
  selectedId: null as string | null,
  detail: undefined as unknown,
  detailDataUpdatedAt: 0,
  detailFetchedAfterMount: false,
  detailLoading: false,
  detailFetching: false,
  detailError: undefined as unknown,
  toolsFailed: false,
  toolsPending: false,
  toolsError: undefined as unknown,
  toolsFailureReason: undefined as unknown,
  catalogReconciling: false,
  /** The `dirty` the unsaved guard was last rendered with. */
  guardDirty: false,
};

const createAgent = vi.fn();
const updateAgent = vi.fn();
const materializeEngineAgent = vi.fn();
const deleteAgent = vi.fn();
const select = vi.fn((slug: string) => {
  state.selectedId = slug;
});
const navigate = vi.fn();

// Resolved queries retain their data identity across renders. Pending tools
// also exercise the real query's undefined data state below.
const CONNECTIONS = [
  {
    id: 'claude',
    kind: 'agent',
    type: 'claude',
    status: 'ready',
    enabled: true,
    capabilities: ['agent-runtime'],
    config: {},
  },
];
/** §4's Create gate asks whether Station's engine has a model to answer on. */
const MODEL_CONNECTIONS = [
  {
    id: 'stub-compat',
    kind: 'model',
    type: 'openai-compat',
    name: 'Stub compat',
    enabled: true,
    status: 'ready',
    capabilities: ['llm'],
    config: {},
  },
];
const EMPTY: never[] = [];
const refetchAgent = vi.fn();
const refetchAgentTools = vi.fn();
const useAgentToolsQuery = vi.fn();

vi.mock('../../../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'ui-scope-test-authority',
    isCurrent: () => true,
  }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useEngineConnectionsQuery: () => ({ data: CONNECTIONS }),
  useModelConnectionsQuery: () => ({ data: MODEL_CONNECTIONS }),
  useAgentQuery: () => ({
    data: state.detail,
    dataUpdatedAt: state.detailDataUpdatedAt,
    isError: state.detailError !== undefined,
    isFetchedAfterMount: state.detailFetchedAfterMount,
    isPending: state.detailLoading,
    isSuccess: state.detail !== undefined && state.detailError === undefined,
    isLoading: state.detailLoading,
    isFetching: state.detailFetching,
    error: state.detailError,
    refetch: refetchAgent,
  }),
  isAgentToolsActivatingError: (error: unknown) =>
    (error as { activating?: boolean } | undefined)?.activating === true,
  useAgentTemplatesQuery: () => ({ data: EMPTY }),
  useAgentToolsQuery: (...args: unknown[]) => {
    useAgentToolsQuery(...args);
    return {
      data: state.toolsPending ? undefined : EMPTY,
      isError: state.toolsFailed,
      error: state.toolsError,
      failureReason: state.toolsFailureReason,
      refetch: refetchAgentTools,
    };
  },
  useIntegrationsQuery: () => ({ data: EMPTY }),
  useProjectsQuery: () => ({ data: EMPTY }),
  useSkillsQuery: () => ({ data: EMPTY }),
  useMaterializeEngineAgentMutation: () => ({
    mutateAsync: materializeEngineAgent,
    isPending: false,
  }),
}));
vi.mock('../../../contexts/AgentsContext', () => ({
  useAgentCatalogReconciling: () => state.catalogReconciling,
  useAgents: () => state.agents,
  useAgentActions: () => ({
    createAgent,
    updateAgent,
    deleteAgent,
  }),
}));
vi.mock('../../../contexts/ConfigContext', () => ({ useConfig: () => ({}) }));
vi.mock('../../../contexts/navigation-store', () => ({
  navigationStore: { navigate },
}));
vi.mock('../../../hooks/useAIEnrich', () => ({
  useAIEnrich: () => ({ enrich: vi.fn(), isEnriching: false }),
}));
vi.mock('../../../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));
vi.mock('../../../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: (dirty: boolean) => {
    state.guardDirty = dirty;
    return {
      guard: (cb: () => void) => cb(),
      DiscardModal: () => null,
    };
  },
}));
vi.mock('../../../hooks/useUrlSelection', () => ({
  useUrlSelection: () => ({
    selectedId: state.selectedId,
    select,
    deselect: vi.fn(() => {
      state.selectedId = null;
    }),
  }),
}));

const { resolveAuthoritativeLoadedAgent, useAgentsViewModel } = await import(
  '../useAgentsViewModel'
);

function agent(overrides: Record<string, unknown>): AgentData {
  return { slug: 'a', name: 'A', ...overrides } as unknown as AgentData;
}

beforeEach(() => {
  state.agents = [];
  state.selectedId = null;
  state.detail = undefined;
  state.detailDataUpdatedAt = 0;
  state.detailFetchedAfterMount = false;
  state.detailLoading = false;
  state.detailFetching = false;
  state.detailError = undefined;
  state.toolsFailed = false;
  state.toolsPending = false;
  state.toolsError = undefined;
  state.toolsFailureReason = undefined;
  state.catalogReconciling = false;
  createAgent.mockReset().mockResolvedValue({ data: { slug: 'writer' } });
  updateAgent.mockReset().mockResolvedValue({ data: {} });
  deleteAgent.mockReset().mockResolvedValue(undefined);
  materializeEngineAgent
    .mockReset()
    .mockResolvedValue({ data: { slug: 'claude-code' }, created: true });
  select.mockClear();
  navigate.mockClear();
  useAgentToolsQuery.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  MODEL_CONNECTIONS.splice(1);
});

function render() {
  const freshDetail =
    state.detail !== undefined &&
    state.detailError === undefined &&
    !state.detailLoading &&
    state.detailDataUpdatedAt === 0;
  const pendingDetail = state.detail;
  if (freshDetail) state.detail = undefined;
  const rendered = renderHook(() =>
    useAgentsViewModel({ agents: state.agents, onNavigate: vi.fn() }),
  );
  if (freshDetail) {
    act(() => {
      state.detail = pendingDetail;
      state.detailDataUpdatedAt = 1;
      state.detailFetchedAfterMount = true;
      rendered.rerender();
    });
  }
  return rendered;
}

test('a pending tools query does not prevent fresh agent detail from becoming editable', () => {
  state.selectedId = 'writer';
  state.detail = agent({ slug: 'writer', name: 'Writer' });
  state.toolsPending = true;
  let renders = 0;
  // Bound the old render loop so this regression fails without exhausting the
  // worker. A real pending or disabled query supplies undefined, not [].
  useAgentToolsQuery.mockImplementation(() => {
    if (++renders > 40) throw new Error('Agent editor render loop');
  });

  const { result, rerender } = render();
  expect(result.current.form.name).toBe('Writer');
  expect(result.current.isLoading).toBe(false);
  expect(result.current.integrationTools).toEqual({});
  rerender();
  expect(result.current.form.name).toBe('Writer');
});

describe('AC5 — a created Agent is in the list and selected, with no reload', () => {
  test('shows the authored-agent empty state beneath engine-only rows', () => {
    state.agents = [
      agent({ slug: 'codex', name: 'Codex', engineDefault: true }),
    ];
    const { result } = render();
    expect(renderToStaticMarkup(result.current.emptyContent)).toContain(
      'No agents of your own yet',
    );
    expect(result.current.listItems).toHaveLength(1);
  });

  test('an explicitly broken model connection blocks Create and keyboard save', async () => {
    MODEL_CONNECTIONS.push({
      id: 'broken-model',
      kind: 'model',
      type: 'openai-compat',
      name: 'Broken model',
      enabled: true,
      status: 'error',
      capabilities: ['llm'],
      config: {},
    });
    const { result } = render();
    act(() => {
      result.current.handleNew();
      result.current.handleStartWithModel();
      result.current.setForm((form) => ({
        ...form,
        slug: 'writer',
        name: 'Writer',
        prompt: 'Write.',
        execution: {
          ...form.execution,
          modelConnectionId: 'broken-model',
        },
      }));
    });

    expect(result.current.createBlocked).toBe(true);
    await act(async () => {
      await result.current.handleSave();
    });
    expect(createAgent).not.toHaveBeenCalled();
  });

  test('the created slug comes from the response, not the typed form', async () => {
    // The server owns slug assignment; keying selection off the form would
    // select a slug that may not be the one persisted.
    createAgent.mockResolvedValue({ data: { slug: 'writer-2' } });
    const { result } = render();
    act(() => {
      result.current.handleNew();
    });
    act(() => {
      result.current.setForm((form) => ({
        ...form,
        slug: 'writer',
        name: 'Writer',
        prompt: 'Write.',
        // A ready engine binding: `validate` refuses to save without one.
        execution: { ...form.execution, agentConnectionId: 'claude' },
      }));
    });
    // The navigation is DEFERRED past the unsaved-changes guard on purpose
    // (see `handleSave`): inside the save handler the form still reads dirty,
    // `navigationStore.navigate` hands the navigation to the discard prompt,
    // and the app sits on `/agents/new` with the create form already torn
    // down. Asserting only that it eventually happens would not catch a
    // revert to the synchronous call, so this pins BOTH: nothing during the
    // save, then the created slug once the form is clean.
    await act(async () => {
      await result.current.handleSave();
      expect(navigate).not.toHaveBeenCalled();
    });
    expect(createAgent).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(navigate).toHaveBeenLastCalledWith('/agents/writer-2', {
        created: '1',
      }),
    );
  });

  test('the refreshed catalog renders the new row without a reload', async () => {
    const { result, rerender } = render();
    expect(result.current.listItems).toHaveLength(0);
    // What the create mutation's `['agents']` invalidation delivers.
    state.agents = [
      agent({ slug: 'writer', name: 'Writer', engineId: 'station' }),
    ];
    rerender();
    await waitFor(() =>
      expect(result.current.listItems.map((item) => item.id)).toEqual([
        'writer',
      ]),
    );
  });
});

/**
 * archive#3741: the required marker and the Create gate read one derivation
 * of "this engine needs an authored prompt", so a field can never be unmarked
 * and still refuse — nor marked and then accepted as empty.
 */
describe('the prompt requirement is one view-model derivation (archive#3741)', () => {
  test.each([
    ["Station's engine", 'model', 'helper', true],
    [
      "the reserved station Agent on Station's engine",
      'model',
      'station',
      false,
    ],
    ['an engine that delivers its own prompt (Claude)', 'cli', 'helper', false],
  ] as const)(
    '%s: the marker and the Create gate agree',
    (_label, start, slug, required) => {
      const { result } = render();
      act(() => {
        result.current.handleNew();
        if (start === 'model') result.current.handleStartWithModel();
        else result.current.handleStartWithCli();
        result.current.setForm((form) => ({
          ...form,
          slug,
          name: 'Helper',
          prompt: '',
          execution: {
            ...form.execution,
            ...(start === 'cli' ? { agentConnectionId: 'claude' } : {}),
          },
        }));
      });

      expect(result.current.promptIsRequired).toBe(required);
      expect(result.current.createBlocked).toBe(required);

      act(() => {
        result.current.setForm((form) => ({ ...form, prompt: 'Be helpful.' }));
      });
      expect(result.current.createBlocked).toBe(false);
    },
  );
});

describe('AC5 — a tools read that lands mid-activation is a wait, not an error', () => {
  // A create now returns as soon as its write is durable, so opening the new
  // Agent immediately can outrun its activation and the tools read answers
  // 503. Showing an empty tool list would read as "this Agent has no tools",
  // and an error would name a failure that has not happened.
  const activating = { activating: true };

  test.each([
    ['the catalog has no selected row', [], false],
    [
      'the selected row is from a reconciling catalog',
      [agent({ slug: 'writer', name: 'Writer', engineId: 'station' })],
      true,
    ],
  ])(
    '%s does not request runtime tools',
    (_case, agents, catalogReconciling) => {
      state.selectedId = 'writer';
      state.agents = agents;
      state.catalogReconciling = catalogReconciling;

      render();

      expect(useAgentToolsQuery).toHaveBeenLastCalledWith(
        'writer',
        expect.objectContaining({ enabled: false }),
      );
    },
  );

  test('a stable selected Station row requests its runtime tools', () => {
    state.selectedId = 'writer';
    state.agents = [
      agent({ slug: 'writer', name: 'Writer', engineId: 'station' }),
    ];

    render();

    expect(useAgentToolsQuery).toHaveBeenLastCalledWith(
      'writer',
      expect.objectContaining({ enabled: true }),
    );
  });

  test('while the retry is in flight the pane reports activating, not failure', () => {
    state.agents = [
      agent({ slug: 'writer', name: 'Writer', engineId: 'station' }),
    ];
    state.selectedId = 'writer';
    state.detail = { slug: 'writer', name: 'Writer' };
    // react-query keeps `error` null while it is still retrying; the last
    // attempt's reason is the only signal that says "still trying".
    state.toolsFailureReason = activating;
    const { result } = render();
    expect(result.current.toolsActivating).toBe(true);
    expect(result.current.toolsActivationTimedOut).toBe(false);
  });

  test('once the retries are spent it stops implying it might still arrive', () => {
    state.agents = [
      agent({ slug: 'writer', name: 'Writer', engineId: 'station' }),
    ];
    state.selectedId = 'writer';
    state.detail = { slug: 'writer', name: 'Writer' };
    state.toolsFailed = true;
    state.toolsError = activating;
    const { result } = render();
    expect(result.current.toolsActivating).toBe(false);
    expect(result.current.toolsActivationTimedOut).toBe(true);
  });

  test('an abandoned activation surfaces the reason and a retry', () => {
    // The catalog carries the runtime's own record. "Hasn't finished
    // activating" was true for a while and then became a lie; this is the
    // state that replaces it, and it has an action.
    state.agents = [
      agent({
        slug: 'writer',
        name: 'Writer',
        engineId: 'station',
        activationFailure: {
          reason: 'prompt template references a missing variable',
          at: '2026-08-20T00:00:00.000Z',
        },
      }),
    ];
    state.selectedId = 'writer';
    state.detail = { slug: 'writer', name: 'Writer' };
    const { result } = render();
    expect(result.current.activationFailure).toMatchObject({
      reason: 'prompt template references a missing variable',
    });
    expect(typeof result.current.onRetryActivation).toBe('function');
    act(() => {
      result.current.onRetryActivation();
    });
    expect(refetchAgent).toHaveBeenCalled();
  });

  test('a healthy agent carries no activation failure', () => {
    state.agents = [
      agent({ slug: 'writer', name: 'Writer', engineId: 'station' }),
    ];
    state.selectedId = 'writer';
    state.detail = { slug: 'writer', name: 'Writer' };
    const { result } = render();
    expect(result.current.activationFailure).toBeUndefined();
  });

  test('a non-activating tools failure claims neither state', () => {
    // A 409 is a real answer about a genuinely inactive Agent; retrying it or
    // calling it "activating" would both be wrong.
    state.agents = [
      agent({ slug: 'writer', name: 'Writer', engineId: 'station' }),
    ];
    state.selectedId = 'writer';
    state.detail = { slug: 'writer', name: 'Writer' };
    state.toolsFailed = true;
    state.toolsError = { activating: false };
    const { result } = render();
    expect(result.current.toolsActivating).toBe(false);
    expect(result.current.toolsActivationTimedOut).toBe(false);
  });
});

describe('AC5 — "Loading agent…" is bounded', () => {
  test('a detail read that never resolves becomes an actionable failure state', async () => {
    vi.useFakeTimers();
    state.selectedId = 'writer';
    state.detailLoading = true;
    const { result, rerender } = render();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.loadError).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(9_000);
    });
    rerender();
    // The spinner stops claiming progress it is not making, and the pane
    // gets an error state with Retry / Back instead.
    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadError).toMatch(/longer than expected/i);
  });

  test('a read that answers inside the window never degrades', async () => {
    vi.useFakeTimers();
    state.selectedId = 'writer';
    state.detailLoading = true;
    const { result, rerender } = render();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    state.detailLoading = false;
    state.detail = { slug: 'writer', name: 'Writer' };
    state.detailDataUpdatedAt = 1;
    state.detailFetchedAfterMount = true;
    act(() => rerender());
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    rerender();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.loadError).toBeNull();
  });
});

describe('AC7 — engineDefault is not a lock', () => {
  test('a materialized engine agent is editable, deletable, and can add skills', async () => {
    // `locked` gates Save, Delete, and the Skills tab's `+ Add`.
    state.agents = [
      agent({
        slug: 'claude-code',
        name: 'Claude Code',
        execution: { agentConnectionId: 'claude' },
      }),
    ];
    state.selectedId = 'claude-code';
    const { result } = render();
    expect(result.current.locked).toBe(false);
    expect(result.current.selectedIsUnmaterializedEngine).toBe(false);
  });

  test('`locked` is blind to engineDefault — the same Agent locks the same either way', () => {
    // The property, stated so re-adding the flag to `locked` cannot pass:
    // ownership (plugin / ACP connection) decides, and nothing else.
    const base = {
      slug: 'claude-code',
      name: 'Claude Code',
      execution: { agentConnectionId: 'claude' },
    };
    state.agents = [agent(base)];
    state.selectedId = 'claude-code';
    const plain = render();
    const withoutFlag = plain.result.current.locked;

    state.agents = [agent({ ...base, engineDefault: true })];
    const flagged = render();
    expect(flagged.result.current.locked).toBe(withoutFlag);
    expect(withoutFlag).toBe(false);
  });

  test('an engine identity with no file gets a Not-set-up pane, not a dead editor', () => {
    state.agents = [
      agent({
        slug: 'claude',
        name: 'Claude Code',
        engineDefault: true,
        execution: { agentConnectionId: 'claude' },
        available: false,
        unavailableReason: "Agent 'claude' has no authored Agent definition.",
        enable: { engineConnectionId: 'claude' },
      }),
    ];
    state.selectedId = 'claude';
    // The detail read 404s for an identity with no file; that must not read
    // as "Agent not found".
    state.detailError = new Error('Agent not found');
    const { result } = render();
    expect(result.current.selectedIsUnmaterializedEngine).toBe(true);
    expect(result.current.notFound).toBe(false);
    expect(result.current.selectedRunnability).toMatchObject({
      runnable: false,
      reason: "Agent 'claude' has no authored Agent definition.",
      enable: { engineConnectionId: 'claude' },
    });
  });

  test('its Enable materializes the engine and selects the resulting Agent', async () => {
    state.agents = [
      agent({
        slug: 'claude',
        name: 'Claude Code',
        engineDefault: true,
        execution: { agentConnectionId: 'claude' },
        available: false,
        unavailableReason: 'no definition',
        enable: { engineConnectionId: 'claude' },
      }),
    ];
    state.selectedId = 'claude';
    const { result } = render();
    await act(async () => {
      result.current.handleEnableSelected();
    });
    await waitFor(() =>
      expect(materializeEngineAgent).toHaveBeenCalledWith('claude'),
    );
    expect(select).toHaveBeenLastCalledWith('claude-code');
    // The picker's Enable posts the same thing — see NewChatModal's suite.
    expect(createAgent).not.toHaveBeenCalled();
  });

  // #2708 A-3a: an Enable refused by the validation middleware, as the REAL
  // agent fetcher throws it, reads as the server's reason.
  test('a refused Enable shows the reason from the real agent fetcher', async () => {
    const { materializeEngineAgent: realMaterialize } = await import(
      '@kontourai/station-sdk/client'
    );
    const refusal = await realValidationRefusal(
      () => realMaterialize('http://station.test', 'claude'),
      'Choose a detected engine.',
      'engineId',
    );
    materializeEngineAgent.mockRejectedValueOnce(refusal);
    state.agents = [
      agent({
        slug: 'claude',
        name: 'Claude Code',
        engineDefault: true,
        execution: { agentConnectionId: 'claude' },
        available: false,
        unavailableReason: 'no definition',
        enable: { engineConnectionId: 'claude' },
      }),
    ];
    state.selectedId = 'claude';
    const { result } = render();
    await act(async () => {
      await result.current.handleEnableSelected();
    });

    expect(result.current.enableError).toBe('Choose a detected engine.');
  });

  test('a read-only ACP agent keeps its lock and gets a Connections action', () => {
    state.agents = [
      agent({
        slug: 'opencode',
        name: 'OpenCode',
        engineConnectionType: 'acp',
        execution: { agentConnectionId: 'oc' },
      }),
    ];
    state.selectedId = 'opencode';
    const { result } = render();
    expect(result.current.locked).toBe(true);
    act(() => {
      result.current.handleConfigureConnection();
    });
    expect(navigate).toHaveBeenCalledWith('/connections/engines/oc');
  });
});

describe('persisted detail remains authoritative while the collection reconciles', () => {
  test('a successful mismatch suppresses established authority before effect cleanup', () => {
    const established = agent({ slug: 'writer', name: 'Writer' });
    expect(
      resolveAuthoritativeLoadedAgent(
        { generation: 3, agent: established },
        3,
        'writer',
        true,
      ),
    ).toBeUndefined();
    expect(
      resolveAuthoritativeLoadedAgent(
        { generation: 3, agent: established },
        3,
        'writer',
        false,
      ),
    ).toBe(established);
  });

  test('a cached exact detail cannot authorize the editor before a mount refresh', async () => {
    state.selectedId = 'writer';
    state.agents = [];
    state.detail = agent({
      slug: 'writer',
      name: 'Stale Writer',
      description: 'Before the saved update',
    });
    state.detailDataUpdatedAt = 1;
    state.detailFetchedAfterMount = false;
    state.detailFetching = true;

    const { result } = render();

    expect(result.current.selectedAgent).toBeUndefined();
    expect(result.current.form.name).toBe('');
    expect(result.current.isLoading).toBe(true);
    await act(async () => {
      await result.current.handleSave();
    });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  test('a completed data update can establish authority when fetched-after-mount resets', () => {
    state.selectedId = 'writer';
    state.detail = agent({ slug: 'writer', name: 'Cached Writer' });
    state.detailDataUpdatedAt = 1;
    state.detailFetchedAfterMount = false;
    state.detailFetching = true;
    const { result, rerender } = render();
    expect(result.current.selectedAgent).toBeUndefined();

    act(() => {
      state.detail = agent({ slug: 'writer', name: 'Fresh Writer' });
      state.detailDataUpdatedAt = 2;
      state.detailFetching = false;
      // Query observer remounts can reset this flag after the response; the
      // advanced data timestamp remains the positive completion signal.
      state.detailFetchedAfterMount = false;
      rerender();
    });
    expect(result.current.selectedAgent?.name).toBe('Fresh Writer');
  });

  test('a newer exact detail establishes authority during a later background fetch', () => {
    state.selectedId = 'writer';
    state.detail = agent({ slug: 'writer', name: 'Cached Writer' });
    state.detailDataUpdatedAt = 1;
    state.detailFetchedAfterMount = false;
    state.detailFetching = true;
    const { result, rerender } = render();
    expect(result.current.selectedAgent).toBeUndefined();

    act(() => {
      state.detail = agent({ slug: 'writer', name: 'Fresh Writer' });
      state.detailDataUpdatedAt = 2;
      // Catalog reconciliation can invalidate this query immediately after a
      // successful response. The newer exact data remains valid authority
      // while that subsequent fetch is active.
      state.detailFetching = true;
      rerender();
    });

    expect(result.current.selectedAgent?.name).toBe('Fresh Writer');
    expect(result.current.isLoading).toBe(false);
  });

  test('a cancelled fetch cannot promote unchanged cached detail', () => {
    state.selectedId = 'writer';
    state.detail = agent({ slug: 'writer', name: 'Cached Writer' });
    state.detailDataUpdatedAt = 1;
    state.detailFetchedAfterMount = false;
    state.detailFetching = true;
    const { result, rerender } = render();
    expect(result.current.selectedAgent).toBeUndefined();

    act(() => {
      state.detailFetching = false;
      // Cancellation restores the prior successful query state without a
      // data update or an error. Request start alone must not authorize it.
      state.detailFetchedAfterMount = false;
      rerender();
    });
    expect(result.current.selectedAgent).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  test('a failed first mount refresh cannot promote cached detail into write authority', async () => {
    state.selectedId = 'writer';
    state.agents = [];
    state.detail = agent({
      slug: 'writer',
      name: 'Stale Writer',
      description: 'Before the saved update',
    });
    // TanStack reports fetched-after-mount for this error update even though
    // the only data is still the pre-mount cache entry.
    state.detailDataUpdatedAt = 1;
    state.detailFetchedAfterMount = true;
    state.detailError = new Error('Refresh failed');

    const { result } = render();

    expect(result.current.selectedAgent).toBeUndefined();
    expect(result.current.form.name).toBe('');
    expect(result.current.loadError).toBe('Refresh failed');
    await act(async () => {
      await result.current.handleSave();
    });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  test('A to pending B to cached A requires a new A response', () => {
    state.selectedId = 'agent-a';
    state.detail = agent({ slug: 'agent-a', name: 'Agent A' });
    const { result, rerender } = render();
    expect(result.current.selectedAgent?.slug).toBe('agent-a');

    act(() => {
      state.selectedId = 'agent-b';
      state.detail = undefined;
      state.detailDataUpdatedAt = 0;
      state.detailFetchedAfterMount = false;
      state.detailLoading = true;
      rerender();
    });
    expect(result.current.selectedAgent).toBeUndefined();

    act(() => {
      state.selectedId = 'agent-a';
      state.detail = agent({ slug: 'agent-a', name: 'Cached Agent A' });
      state.detailDataUpdatedAt = 1;
      state.detailFetchedAfterMount = false;
      state.detailLoading = false;
      state.detailFetching = true;
      rerender();
    });
    expect(result.current.selectedAgent).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  test('leaving a record by URL drops its unsaved edit and its errors', () => {
    // #2992: Agents keeps one surface across its routes, so this hook now
    // outlives a selection. Back/Forward does not pass the discard guard, and
    // an edit left dirty kept the guard armed for a form nobody could see.
    state.selectedId = 'agent-a';
    state.detail = agent({ slug: 'agent-a', name: 'Agent A' });
    const { result, rerender } = render();
    act(() => {
      result.current.setIsLocked(false);
      result.current.setForm((current) => ({ ...current, name: 'Edited' }));
    });
    expect(result.current.dirty).toBe(true);

    act(() => {
      state.selectedId = null;
      state.detail = undefined;
      rerender();
    });
    expect(result.current.dirty).toBe(false);
    expect(result.current.form.name).toBe('');
    expect(result.current.isLocked).toBe(true);
    expect(result.current.validationErrors).toEqual({});
  });

  test('coming back to a cached Agent asks for the response its authority needs', () => {
    // Found live: A -> B -> A ended on "Couldn't load agent" once the surface
    // stopped remounting, because a fresh cache entry is not refetched on a
    // key change and nothing else asked.
    state.selectedId = 'agent-a';
    state.detail = agent({ slug: 'agent-a', name: 'Agent A' });
    refetchAgent.mockClear();
    const { rerender } = render();
    // The mount itself is `refetchOnMount`'s job, not this request's.
    expect(refetchAgent).not.toHaveBeenCalled();

    act(() => {
      state.selectedId = 'agent-b';
      state.detail = undefined;
      state.detailLoading = true;
      rerender();
    });
    expect(refetchAgent).toHaveBeenCalledTimes(1);

    act(() => {
      state.selectedId = 'agent-a';
      state.detail = agent({ slug: 'agent-a', name: 'Cached Agent A' });
      state.detailFetchedAfterMount = false;
      state.detailLoading = false;
      rerender();
    });
    expect(refetchAgent).toHaveBeenCalledTimes(2);
    expect(refetchAgent).toHaveBeenLastCalledWith({ cancelRefetch: false });
    // A rerender of the same selection does not ask again.
    rerender();
    expect(refetchAgent).toHaveBeenCalledTimes(2);
  });

  test('selecting away from an unsaved edit asks through the route guard only', () => {
    // The route change is what the unsaved guard arbitrates. When the hook
    // also held the navigation behind its own prompt, one decision took two
    // "Discard?" dialogs: its own, then the route guard's.
    state.selectedId = 'agent-a';
    state.detail = agent({ slug: 'agent-a', name: 'Agent A' });
    const { result } = render();
    act(() => {
      result.current.setForm((current) => ({ ...current, name: 'Edited' }));
    });
    expect(result.current.dirty).toBe(true);
    select.mockClear();

    act(() => result.current.handleSelect('agent-b'));
    expect(select).toHaveBeenCalledExactlyOnceWith('agent-b');
    act(() => result.current.handleNew());
    expect(select).toHaveBeenLastCalledWith('new');
    // Still the loaded record until the navigation is admitted.
    expect(result.current.isCreating).toBe(false);
  });

  test('a save that settles after the reader moved on leaves the new record clean', async () => {
    // The hook outlives a selection (#2992), so the awaited half of a save
    // can land on a different record: its snapshot made that record read
    // dirty against a form it never had.
    state.selectedId = 'agent-a';
    state.detail = agent({
      slug: 'agent-a',
      name: 'Agent A',
      prompt: 'Answer.',
    });
    let settle: (value: { data: object }) => void = () => {};
    updateAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const { result, rerender } = render();
    act(() => {
      result.current.setForm((current) => ({ ...current, name: 'Edited A' }));
    });
    act(() => {
      void result.current.handleSave();
    });
    expect(updateAgent).toHaveBeenCalledTimes(1);

    act(() => {
      state.selectedId = 'agent-b';
      state.detail = undefined;
      state.detailLoading = true;
      rerender();
    });
    act(() => {
      state.detail = agent({
        slug: 'agent-b',
        name: 'Agent B',
        prompt: 'Answer.',
      });
      state.detailDataUpdatedAt = 10;
      state.detailLoading = false;
      rerender();
    });
    expect(result.current.form.name).toBe('Agent B');
    expect(result.current.dirty).toBe(false);

    await act(async () => {
      settle({ data: {} });
    });
    expect(result.current.form.name).toBe('Agent B');
    expect(result.current.dirty).toBe(false);
    expect(result.current.isSaving).toBe(false);
  });

  test('Duplicate from an unsaved edit navigates only once the copy reads clean', () => {
    // The real guard registers with the route store while the form is dirty,
    // so a navigation made in that state is intercepted and asks "Discard?"
    // again — after the reader had already answered the hook's own prompt
    // (the guard here stands in for an answered one). The seam is the state
    // the guard was rendered with when the navigation happened.
    state.selectedId = 'agent-a';
    state.detail = agent({
      slug: 'agent-a',
      name: 'Agent A',
      prompt: 'Answer.',
    });
    const { result } = render();
    act(() => {
      result.current.setForm((current) => ({ ...current, name: 'Edited' }));
    });
    expect(result.current.dirty).toBe(true);
    const guardDirtyAtNavigation: boolean[] = [];
    select.mockImplementation((slug: string) => {
      guardDirtyAtNavigation.push(state.guardDirty);
      state.selectedId = slug;
    });

    act(() =>
      result.current.handleDuplicate(
        agent({ slug: 'agent-a', name: 'Agent A', prompt: 'Answer.' }),
      ),
    );
    expect(select).toHaveBeenCalledExactlyOnceWith('new');
    expect(guardDirtyAtNavigation).toEqual([false]);
    expect(result.current.form.name).toBe('Agent A copy');
    expect(result.current.isCreating).toBe(true);
    select.mockImplementation((slug: string) => {
      state.selectedId = slug;
    });
  });

  test('a successful mismatched detail revokes established authority', () => {
    state.selectedId = 'writer';
    state.detail = agent({ slug: 'writer', name: 'Writer' });
    const { result, rerender } = render();
    expect(result.current.selectedAgent?.slug).toBe('writer');

    act(() => {
      state.detail = agent({ slug: 'someone-else', name: 'Someone else' });
      state.detailDataUpdatedAt = 2;
      rerender();
    });
    expect(result.current.selectedAgent).toBeUndefined();
    expect(result.current.loadError).toMatch(/did not match/i);
  });

  test('a later refresh error retains already-established exact authority', () => {
    state.selectedId = 'writer';
    state.detail = agent({ slug: 'writer', name: 'Writer' });
    const { result, rerender } = render();
    expect(result.current.selectedAgent?.slug).toBe('writer');

    act(() => {
      state.detailError = new Error('Later refresh failed');
      rerender();
    });
    expect(result.current.selectedAgent?.slug).toBe('writer');
    expect(result.current.error).toBe('Later refresh failed');
  });

  test('an exact loaded custom Agent restores its actions without a collection row', () => {
    state.selectedId = 'writer';
    state.agents = [];
    state.detail = agent({
      slug: 'writer',
      name: 'Writer',
      engineId: 'station',
    });

    const { result } = render();

    expect(result.current.selectedAgent).toBe(state.detail);
    expect(result.current.isAcp).toBe(false);
    expect(result.current.isPlugin).toBe(false);
    expect(result.current.locked).toBe(false);
  });

  test('an exact loaded ACP Agent remains read-only without a collection row', () => {
    state.selectedId = 'opencode';
    state.agents = [];
    state.detail = agent({
      slug: 'opencode',
      name: 'OpenCode',
      engineConnectionType: 'acp',
      execution: { agentConnectionId: 'oc' },
    });

    const { result } = render();

    expect(result.current.selectedAgent).toBe(state.detail);
    expect(result.current.isAcp).toBe(true);
    expect(result.current.locked).toBe(true);
  });

  test('an exact loaded plugin Agent keeps its ownership lock without a collection row', () => {
    state.selectedId = 'plugin-agent';
    state.agents = [];
    state.detail = agent({
      slug: 'plugin-agent',
      name: 'Plugin Agent',
      plugin: 'example-plugin',
    });

    const { result } = render();

    expect(result.current.selectedAgent).toBe(state.detail);
    expect(result.current.isPlugin).toBe(true);
    expect(result.current.locked).toBe(true);
  });

  test('a mismatched detail cannot hydrate or write the selected route', async () => {
    state.selectedId = 'writer';
    state.agents = [];
    state.detail = agent({ slug: 'someone-else', name: 'Someone else' });

    const { result } = render();

    expect(result.current.selectedAgent).toBeUndefined();
    expect(result.current.form.name).toBe('');
    expect(result.current.loadError).toMatch(/did not match/i);

    act(() => {
      result.current.setForm((form) => ({
        ...form,
        slug: 'writer',
        name: 'Injected Writer',
        prompt: 'This must not be written.',
      }));
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(updateAgent).not.toHaveBeenCalled();
  });
});

// archive#3662: an ABSENT engine binding is Station's own engine, not "no
// engine", so the editor must offer the Model-connection choice for it. The
// old predicate answered the other way and the one Agent shape that always
// needs a Model connection was the shape never offered one.
describe('an Agent with no engine binding edits as a Station-engine Agent (archive#3662)', () => {
  test('an absent binding selects the Model-connection engine kind', () => {
    state.selectedId = 'writer';
    state.detail = agent({
      slug: 'writer',
      name: 'Writer',
      execution: { agentConnectionId: '' },
    });
    const { result } = render();
    expect(result.current.form.name).toBe('Writer');
    expect(result.current.engineKind).toBe('model');
  });

  test('a binding to an external engine selects the CLI engine kind', () => {
    state.selectedId = 'writer';
    state.detail = agent({
      slug: 'writer',
      name: 'Writer',
      execution: { agentConnectionId: 'claude' },
    });
    const { result } = render();
    expect(result.current.form.name).toBe('Writer');
    expect(result.current.engineKind).toBe('cli');
  });
});

/**
 * archive#4521: does the editor actually let the user SET the
 * agent's model/provider binding — read from a loaded agent, and written
 * back through the real agent-update contract on Save, mocked at the route
 * seam (`useAgentActions.updateAgent`, the same seam every other save
 * assertion in this file uses).
 */
describe('the Model connection binding round-trips through Save (station#4521 item 2)', () => {
  test('reads the persisted binding into the form on load', () => {
    state.selectedId = 'station';
    state.detail = {
      slug: 'station',
      name: 'Station',
      execution: { agentConnectionId: '', modelConnectionId: 'stub-compat' },
    };
    const { result } = render();
    expect(result.current.form.execution.modelConnectionId).toBe('stub-compat');
  });

  test('a chosen connection is written back through the agent-update contract on Save', async () => {
    state.selectedId = 'station';
    state.detail = {
      slug: 'station',
      name: 'Station',
      // archive#4521: the exact wire shape reported — `execution`
      // OMITTED entirely, not an object with empty strings. A Station agent
      // that has never had its execution configured has no `spec.execution`
      // at all; `formFromAgent` already reads it with optional chaining, so
      // this omission is what actually exercises that path.
      available: false,
      unavailableReason: 'No enabled LLM provider connection is configured.',
      unavailableFix: { kind: 'model-connection' },
    };
    const { result } = render();
    expect(result.current.form.execution.modelConnectionId).toBe('');

    act(() => {
      result.current.setForm((form) => ({
        ...form,
        execution: { ...form.execution, modelConnectionId: 'stub-compat' },
      }));
    });
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      await result.current.handleSave();
    });

    expect(updateAgent).toHaveBeenCalledTimes(1);
    const [savedSlug, payload] = updateAgent.mock.calls[0] as [
      string,
      { execution?: { modelConnectionId?: string } },
    ];
    expect(savedSlug).toBe('station');
    expect(payload.execution?.modelConnectionId).toBe('stub-compat');
  });
});

describe('the built-in Station Agent saves its fields, not its resolved engine (station#923)', () => {
  test('an unrelated edit succeeds without submitting the projected binding', async () => {
    state.selectedId = 'station';
    state.agents = [
      agent({ slug: 'station', name: 'Station', engineId: 'station' }),
    ];
    state.detail = {
      slug: 'station',
      name: 'Station',
      execution: { agentConnectionId: 'codex' },
    };
    const { result } = render();

    act(() => {
      result.current.setForm((form) => ({
        ...form,
        description: 'Owner-authored description',
      }));
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(updateAgent).toHaveBeenCalledWith(
      'station',
      expect.objectContaining({ description: 'Owner-authored description' }),
    );
    expect(JSON.stringify(updateAgent.mock.calls[0]?.[1])).not.toContain(
      'agentConnectionId',
    );
    expect(result.current.error).toBeNull();
  });

  test('the structured refusal renders the short Settings action', async () => {
    state.selectedId = 'station';
    state.detail = { slug: 'station', name: 'Station' };
    updateAgent.mockRejectedValue({
      code: 'STATION_ENGINE_IS_APP_SETTING',
      message: 'server implementation detail must not render',
    });
    const { result } = render();

    act(() => {
      result.current.setForm((form) => ({
        ...form,
        description: 'Trigger save',
      }));
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.error).toBe(
      'Change the built-in Agent engine in Settings, then save your changes again.',
    );
  });

  // #2708 A-3a: a save refused by the validation middleware, as the REAL
  // agent fetcher throws it, reads as the server's reason, not the schema key.
  test('a validation refusal from the real agent fetcher shows its reason', async () => {
    const { updateAgentRaw } = await import('@kontourai/station-sdk/client');
    const refusal = await realValidationRefusal(
      () => updateAgentRaw('http://station.test', 'station', {}),
      'Name must not be empty.',
      'name',
    );
    state.selectedId = 'station';
    state.detail = { slug: 'station', name: 'Station' };
    updateAgent.mockRejectedValue(refusal);
    const { result } = render();

    act(() => {
      result.current.setForm((form) => ({
        ...form,
        description: 'Trigger save',
      }));
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.error).toBe('Name must not be empty.');
  });

  test('a refused delete shows the reason from the real agent fetcher', async () => {
    const { deleteAgentRaw } = await import('@kontourai/station-sdk/client');
    const refusal = await realValidationRefusal(
      () => deleteAgentRaw('http://station.test', 'station'),
      'The built-in Agent cannot be deleted.',
      'slug',
    );
    state.selectedId = 'station';
    state.detail = { slug: 'station', name: 'Station' };
    deleteAgent.mockRejectedValueOnce(refusal);
    const { result } = render();

    await act(async () => {
      await result.current.handleDelete();
    });

    expect(result.current.error).toBe('The built-in Agent cannot be deleted.');
  });
});

/** The refusal the REAL SDK fetcher throws for a validation 400 (#2708). */
async function realValidationRefusal(
  call: () => Promise<unknown>,
  reason: string,
  field: string,
): Promise<unknown> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: false,
        error: 'Validation failed',
        details: { formErrors: [], fieldErrors: { [field]: [reason] } },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  try {
    return await call().catch((caught: unknown) => caught);
  } finally {
    globalThis.fetch = previous;
  }
}
