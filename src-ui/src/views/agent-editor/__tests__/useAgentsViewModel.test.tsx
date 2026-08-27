/**
 * @vitest-environment jsdom
 *
 * AC5 and AC7 for the Agents view model.
 *
 * AC5 — after Create, the list must already contain the new Agent and it must
 * be the selected one, with no reload; and "Loading agent…" must be BOUNDED.
 * A detail read that never resolves used to leave that line on screen forever
 * with nothing to press.
 *
 * AC7 — `engineDefault` is no longer a lock. It used to be, and a fresh
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
  detailLoading: false,
  detailFetching: false,
  detailError: undefined as unknown,
  toolsFailed: false,
  toolsError: undefined as unknown,
  toolsFailureReason: undefined as unknown,
};

const createAgent = vi.fn();
const updateAgent = vi.fn();
const materializeEngineAgent = vi.fn();
const select = vi.fn((slug: string) => {
  state.selectedId = slug;
});
const navigate = vi.fn();

// Every query result is a STABLE reference. A fresh array per render feeds
// `useEffect([agentTools])` a new identity every pass, which sets state, which
// re-renders — the hook loops until the worker runs out of memory.
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

vi.mock('@kontourai/station-sdk', () => ({
  useAgentConnectionsQuery: () => ({ data: CONNECTIONS }),
  useModelConnectionsQuery: () => ({ data: MODEL_CONNECTIONS }),
  useAgentQuery: () => ({
    data: state.detail,
    isLoading: state.detailLoading,
    isFetching: state.detailFetching,
    error: state.detailError,
    refetch: refetchAgent,
  }),
  isAgentToolsActivatingError: (error: unknown) =>
    (error as { activating?: boolean } | undefined)?.activating === true,
  useAgentTemplatesQuery: () => ({ data: EMPTY }),
  useAgentToolsQuery: () => ({
    data: EMPTY,
    isError: state.toolsFailed,
    error: state.toolsError,
    failureReason: state.toolsFailureReason,
    refetch: refetchAgentTools,
  }),
  useIntegrationsQuery: () => ({ data: EMPTY }),
  useProjectsQuery: () => ({ data: EMPTY }),
  useSkillsQuery: () => ({ data: EMPTY }),
  useMaterializeEngineAgentMutation: () => ({
    mutateAsync: materializeEngineAgent,
    isPending: false,
  }),
}));
vi.mock('../../../contexts/AgentsContext', () => ({
  useAgentCatalogReconciling: () => false,
  useAgents: () => state.agents,
  useAgentActions: () => ({
    createAgent,
    updateAgent,
    deleteAgent: vi.fn(),
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
  useUnsavedGuard: () => ({
    guard: (cb: () => void) => cb(),
    DiscardModal: () => null,
  }),
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

const { useAgentsViewModel } = await import('../useAgentsViewModel');

function agent(overrides: Record<string, unknown>): AgentData {
  return { slug: 'a', name: 'A', ...overrides } as unknown as AgentData;
}

beforeEach(() => {
  state.agents = [];
  state.selectedId = null;
  state.detail = undefined;
  state.detailLoading = false;
  state.detailFetching = false;
  state.detailError = undefined;
  state.toolsFailed = false;
  state.toolsError = undefined;
  state.toolsFailureReason = undefined;
  createAgent.mockReset().mockResolvedValue({ data: { slug: 'writer' } });
  updateAgent.mockReset().mockResolvedValue({ data: {} });
  materializeEngineAgent
    .mockReset()
    .mockResolvedValue({ data: { slug: 'claude-code' }, created: true });
  select.mockClear();
  navigate.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  MODEL_CONNECTIONS.splice(1);
});

function render() {
  return renderHook(() =>
    useAgentsViewModel({ agents: state.agents, onNavigate: vi.fn() }),
  );
}

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
        // A ready engine binding: `validate()` refuses to save without one.
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
    state.agents = [agent({ slug: 'writer', name: 'Writer' })];
    rerender();
    await waitFor(() =>
      expect(result.current.listItems.map((item) => item.id)).toEqual([
        'writer',
      ]),
    );
  });
});

describe('AC5 — a tools read that lands mid-activation is a wait, not an error', () => {
  // A create now returns as soon as its write is durable, so opening the new
  // Agent immediately can outrun its activation and the tools read answers
  // 503. Showing an empty tool list would read as "this Agent has no tools",
  // and an error would name a failure that has not happened.
  const activating = { activating: true };

  test('while the retry is in flight the pane reports activating, not failure', () => {
    state.agents = [agent({ slug: 'writer', name: 'Writer' })];
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
    state.agents = [agent({ slug: 'writer', name: 'Writer' })];
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
    state.agents = [agent({ slug: 'writer', name: 'Writer' })];
    state.selectedId = 'writer';
    state.detail = { slug: 'writer', name: 'Writer' };
    const { result } = render();
    expect(result.current.activationFailure).toBeUndefined();
  });

  test('a non-activating tools failure claims neither state', () => {
    // A 409 is a real answer about a genuinely inactive Agent; retrying it or
    // calling it "activating" would both be wrong.
    state.agents = [agent({ slug: 'writer', name: 'Writer' })];
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
    rerender();
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

/**
 * station#4521 item 2: does the editor actually let the user SET the
 * agent's model/provider binding — read from a loaded agent, and written
 * back through the real agent-update contract on Save, mocked at the route
 * seam (`useAgentActions().updateAgent`, the same seam every other save
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
      // station#4521 LOW-2: the exact wire shape reported — `execution`
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
