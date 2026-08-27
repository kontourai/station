/**
 * @vitest-environment jsdom
 *
 * station#3013 — selecting an agent must never be a silent no-op.
 *
 * Confirmed live: a click in the agent picker produced no chat, no error, and
 * no network request. `handleSelect` dispatched only for `isGlobal` or a
 * resolved `selectedProject`; a non-global context whose slug did not resolve
 * fell through the final `else if` and swallowed the click entirely.
 *
 * This suite enumerates handleSelect's reachable states and pins the
 * invariant: every state either dispatches `onSelect` or renders visible
 * feedback telling the user what is missing. It also pins that a THROW from
 * the parent's onSelect handler surfaces instead of vanishing — from the
 * user's seat that failure is identical to the silent fall-through.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentData } from '../contexts/AgentsContext';

const AGENT: AgentData = {
  slug: 'assistant',
  name: 'Assistant',
} as AgentData;

const UNAVAILABLE_AGENT: AgentData = {
  slug: 'downed',
  name: 'Downed',
  available: false,
  unavailableReason: 'connection offline',
  unavailableFix: { kind: 'unknown' },
} as AgentData;

// station#3027: an engine-default alias row carrying the machine-readable
// enable signal.
const ENABLEABLE_ALIAS: AgentData = {
  slug: 'codex',
  name: 'codex',
  engineDefault: true,
  engineDisplayName: 'Codex',
  execution: { agentConnectionId: 'codex' },
  available: false,
  unavailableReason: "Agent 'codex' has no authored Agent definition.",
  unavailableFix: { kind: 'engine-disabled' },
  enable: { engineConnectionId: 'codex' },
} as unknown as AgentData;

const AUTHORED_CODEX: AgentData = {
  slug: 'codex-agent',
  name: 'Codex Agent',
  execution: { agentConnectionId: 'codex' },
} as unknown as AgentData;

const selectionModelState = {
  isGlobal: true as boolean,
  selectedProject: undefined as
    | { slug: string; name: string; workingDirectory?: string }
    | undefined,
  agents: [AGENT] as AgentData[],
  // Enable's FIND scope (#3027 M2). `null` mirrors the default: the scoped
  // set equals the rendered agents.
  scopedAgents: null as AgentData[] | null,
  agentConnections: [] as unknown[],
};

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));

// Enable's CREATE half is `POST /agents/materialize-engine` — the one
// find-or-create path the server owns. Mocking the SDK mutation keeps
// react-query (and its provider requirement) out of this render tree.
const { materializeMock } = vi.hoisted(() => ({ materializeMock: vi.fn() }));
vi.mock('@kontourai/station-sdk', () => ({
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: materializeMock }),
}));

vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: () => ({
    viewModel: {
      isGlobal: selectionModelState.isGlobal,
      selectedProject: selectionModelState.selectedProject,
      contextOptions: [],
      filteredContextOptions: [],
      currentContextOption: {
        value: selectionModelState.selectedProject?.slug ?? '__global__',
        label: selectionModelState.selectedProject?.name ?? 'No workspace',
        glyph: 'folder',
      },
      groups: [
        {
          label: 'Station',
          glyph: 'engine',
          agents: selectionModelState.agents,
        },
      ],
      flatList: selectionModelState.agents,
      scopedAgents:
        selectionModelState.scopedAgents ?? selectionModelState.agents,
      compatibilityMessage: undefined,
    },
    acpConnections: [],
    agentConnections: selectionModelState.agentConnections,
    modelConnections: [],
    runtimeLoading: false,
    modelsLoading: false,
    modelPickerAgent: null,
    setModelPickerAgent: vi.fn(),
    modelChoices: {},
    setModelChoices: vi.fn(),
    modelsForAgent: () => [],
    modelChoiceKey: (agent: AgentData) => agent.slug,
    defaultEffectiveModelForAgent: () => ({
      id: undefined,
      source: 'agent default' as const,
    }),
  }),
}));

const { NewChatModal } = await import('../components/modals/NewChatModal');

afterEach(() => {
  cleanup();
  selectionModelState.isGlobal = true;
  selectionModelState.selectedProject = undefined;
  selectionModelState.agents = [AGENT];
  selectionModelState.scopedAgents = null;
  selectionModelState.agentConnections = [];
  materializeMock.mockReset();
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

function renderModal(onSelect = vi.fn()) {
  render(
    <NewChatModal
      agents={selectionModelState.agents}
      projects={[]}
      onSelect={onSelect}
      onClose={vi.fn()}
    />,
  );
  return onSelect;
}

function renderForkModal(
  onSelect = vi.fn(),
  mode: {
    pending?: boolean;
    error?: string | null;
  } = {},
) {
  render(
    <NewChatModal
      agents={selectionModelState.agents}
      projects={[]}
      onSelect={onSelect}
      onClose={vi.fn()}
      mode={{
        kind: 'fork',
        preferredAgentSlug: 'assistant',
        sourceModel: 'historical-source-model',
        disclosure:
          'Provider cursor, tool state, and approval state do not carry.',
        ...mode,
      }}
    />,
  );
  return onSelect;
}

function clickAgent(slug: string) {
  // Two buttons carry the agent's accessible name (the row and its model
  // configurator); target the row by its slug attribute.
  const row = document.querySelector(
    `button[data-agent-slug="${slug}"]`,
  ) as HTMLButtonElement;
  expect(row).toBeTruthy();
  fireEvent.click(row);
  return row;
}

describe('NewChatModal select dispatch invariant (#3013)', () => {
  test('fork mode defaults to the source Agent and explicitly discloses replay-only state', async () => {
    selectionModelState.agents = [AUTHORED_CODEX, AGENT];
    renderForkModal();

    expect(screen.getByRole('dialog', { name: 'Fork from here' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(
      /new independent conversation.*provider cursor.*tool state.*approval state do not carry/i,
    );
    await waitFor(() => {
      const preferred = document.querySelector(
        'button[data-agent-slug="assistant"]',
      ) as HTMLButtonElement;
      expect(preferred.className).toContain('new-chat-modal__agent--selected');
    });
  });

  test('fork pending state blocks duplicate selection and keeps cancel available', () => {
    const onSelect = renderForkModal(vi.fn(), { pending: true });
    const row = document.querySelector(
      'button[data-agent-slug="assistant"]',
    ) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(
      (screen.getByRole('button', { name: 'Cancel fork' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test('fork failure remains visible so the same selection can retry', () => {
    const onSelect = renderForkModal(vi.fn(), {
      error: 'Temporary fork failure',
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'Temporary fork failure',
    );
    clickAgent('assistant');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][4]).toBe('historical-source-model');
  });

  test('global context dispatches', () => {
    selectionModelState.isGlobal = true;
    const onSelect = renderModal();
    clickAgent('assistant');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][1]).toBeUndefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('resolved project dispatches with the project slug', () => {
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = {
      slug: 'kontour',
      name: 'Kontour',
      workingDirectory: '/tmp/kontour',
    };
    const onSelect = renderModal();
    clickAgent('assistant');
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][1]).toBe('kontour');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('non-global context with an unresolved project must not be silent', () => {
    // The live #3013 state: context names a project the projects list cannot
    // resolve. Dispatching would target a workspace the server cannot
    // resolve either — so no dispatch — but the user must be TOLD, not
    // ignored.
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = undefined;
    const onSelect = renderModal();
    clickAgent('assistant');
    expect(onSelect).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/workspace/i);
  });

  test('Enter on an unavailable agent speaks instead of silently returning', () => {
    // The keyboard path reaches handleSelect with no availability filter; the
    // pointer path cannot (the row button is disabled). Review finding 1.
    selectionModelState.agents = [UNAVAILABLE_AGENT];
    const onSelect = renderModal();
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), {
      key: 'Enter',
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(
      /connection offline/i,
    );
  });

  test('an unavailable agent renders disabled with its reason', () => {
    selectionModelState.agents = [UNAVAILABLE_AGENT];
    const onSelect = renderModal();
    const row = clickAgent('downed');
    expect(row).toHaveProperty('disabled', true);
    // One visible statement of the refusal (the shared readiness chip) and
    // one accessible description carrying the server's sentence.
    expect(screen.getByText('Needs: connection offline')).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('Enable materializes the engine Agent, announces progress, and selects off the response (#3027)', async () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS];
    let resolveCreate: (value: unknown) => void = () => {};
    materializeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const onSelect = renderModal();

    fireEvent.click(
      document.querySelector(
        'button[data-agent-action="enable"]',
      ) as HTMLButtonElement,
    );

    // Never-silent invariant: progress is announced before the write lands.
    expect(screen.getByRole('alert').textContent).toMatch(/setting up codex/i);
    // Only the engine binding crosses the wire: the modal no longer invents
    // a "<engine> Agent" name, which is what produced a duplicate row.
    expect(materializeMock).toHaveBeenCalledWith('codex');
    expect(onSelect).not.toHaveBeenCalled();

    // Selection keys off the CREATE RESPONSE — the agents list may lag
    // minutes behind (deferred activation + last-stable catalog).
    await act(async () => {
      resolveCreate({ data: AUTHORED_CODEX });
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].slug).toBe('codex-agent');
  });

  test('a project-owned result is announced, not smuggled into this context (#3027 M2)', async () => {
    // The server's find-or-create is scope-blind by design. If what it
    // returns belongs to a DIFFERENT project than this context, selecting it
    // would do exactly what the scoped FIND exists to prevent.
    selectionModelState.agents = [ENABLEABLE_ALIAS];
    materializeMock.mockResolvedValueOnce({
      data: { ...AUTHORED_CODEX, project: 'elsewhere' },
      created: false,
    });
    const onSelect = renderModal();

    fireEvent.click(
      document.querySelector(
        'button[data-agent-action="enable"]',
      ) as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(
        /owned by project .elsewhere./i,
      );
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('a second Enable activation while the create is in flight is ignored (#3027 L2)', async () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS];
    let resolveCreate: (value: unknown) => void = () => {};
    materializeMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const onSelect = renderModal();

    const enableButton = document.querySelector(
      'button[data-agent-action="enable"]',
    ) as HTMLButtonElement;
    fireEvent.click(enableButton);
    fireEvent.click(enableButton);
    // The keyboard path is guarded by the same ref.
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), {
      key: 'Enter',
    });

    expect(materializeMock).toHaveBeenCalledTimes(1);
    // The visible affordance is disabled while in flight.
    expect(enableButton.disabled).toBe(true);

    await act(async () => {
      resolveCreate({ data: AUTHORED_CODEX });
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test('an out-of-scope authored Agent is not silently selected — Enable creates instead (#3027 M2)', async () => {
    // The bound authored Agent exists in the raw catalog but NOT in the
    // scoped set (owned by another project / excluded by the project's
    // agents filter): FIND must not reach it.
    selectionModelState.agents = [ENABLEABLE_ALIAS, AUTHORED_CODEX];
    selectionModelState.scopedAgents = [ENABLEABLE_ALIAS];
    materializeMock.mockResolvedValueOnce({ data: AUTHORED_CODEX });
    const onSelect = renderModal();

    fireEvent.click(
      document.querySelector(
        'button[data-agent-action="enable"]',
      ) as HTMLButtonElement,
    );

    expect(materializeMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
  });

  test('a connection remedy suppresses Enable — fix the connection first (#3027 M1)', () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS];
    // The server, which observed the broken binding, changes the repair kind.
    // Enable over a dead connection would overclaim.
    selectionModelState.agents = [
      {
        ...ENABLEABLE_ALIAS,
        unavailableFix: { kind: 'connection-broken' },
      } as AgentData,
    ];
    const onSelect = renderModal();

    expect(
      document.querySelector('button[data-agent-action="enable"]'),
    ).toBeNull();
    expect(
      document.querySelector('button[data-agent-action="remedy"]'),
    ).toBeTruthy();

    // Enter speaks the reason instead of enabling.
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), {
      key: 'Enter',
    });
    expect(materializeMock).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(
      /no authored Agent definition/i,
    );
  });

  test('Enable selects an already-loaded authored Agent instead of creating a duplicate', () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS, AUTHORED_CODEX];
    const onSelect = renderModal();

    fireEvent.click(
      document.querySelector(
        'button[data-agent-action="enable"]',
      ) as HTMLButtonElement,
    );

    expect(materializeMock).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].slug).toBe('codex-agent');
  });

  test('a failed Enable surfaces the server message instead of failing silently', async () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS];
    materializeMock.mockRejectedValueOnce(new Error('registry write refused'));
    const onSelect = renderModal();

    fireEvent.click(
      document.querySelector(
        'button[data-agent-action="enable"]',
      ) as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(
        /could not enable codex.*registry write refused/i,
      );
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('Enter on an enableable alias row triggers Enable, not the reason speech', async () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS];
    materializeMock.mockResolvedValueOnce({ data: AUTHORED_CODEX });
    const onSelect = renderModal();

    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), {
      key: 'Enter',
    });

    expect(materializeMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][0].slug).toBe('codex-agent');
  });

  // station#3027(c). The owner's report: "text in new chat modal is way way
  // too long .. and doesn't really indicate an issue to me". Each engine
  // default without an authored Agent printed the whole server sentence
  // inline; five engines made the picker a wall of amber prose that read as
  // an explanation rather than a state.
  describe('unavailable rows read as a state, not a paragraph', () => {
    const SERVER_REASON =
      "Agent 'codex' has no authored Agent definition, so Station cannot start new sessions or continue existing conversations with it. Enable this engine by creating an Agent for it — new chats will run as that Agent; existing conversations stay readable.";

    const LONG_ALIAS = {
      ...ENABLEABLE_ALIAS,
      unavailableReason: SERVER_REASON,
    } as AgentData;

    function reasonNode(slug: string) {
      return document.getElementById(`agent-${slug}-unavailable`);
    }

    test('the enableable row shows a "Not set up" chip and never paints the sentence', () => {
      selectionModelState.agents = [LONG_ALIAS];
      renderModal();

      expect(screen.getByText('Not set up')).toBeTruthy();
      // The sentence is not a visible node: its only occurrence carries the
      // screen-reader-only class.
      const reason = reasonNode('codex');
      expect(reason?.textContent).toBe(SERVER_REASON);
      expect(reason?.className).toContain(
        'new-chat-modal__agent-reason--assistive',
      );
      // Every node in the picker that carries the sentence is the muted one —
      // no group header, selection feedback, or second copy prints it.
      const carriers = Array.from(document.querySelectorAll('*')).filter(
        (element) => element.textContent === SERVER_REASON,
      );
      expect(carriers).toHaveLength(1);
      expect(carriers[0]).toBe(reason);
    });

    test('the row still describes itself with the full sentence (a11y parity)', () => {
      selectionModelState.agents = [LONG_ALIAS];
      renderModal();

      const row = document.querySelector(
        'button[data-agent-slug="codex"]',
      ) as HTMLButtonElement;
      const describedBy = row.getAttribute('aria-describedby');
      expect(describedBy).toBe('agent-codex-unavailable');
      expect(document.getElementById(describedBy as string)?.textContent).toBe(
        SERVER_REASON,
      );
      // Sighted parity: the hover title on the row carries it too (the row
      // button is disabled, so a title there would never surface).
      expect(
        row.closest('.new-chat-modal__agent-row')?.getAttribute('title'),
      ).toBe(SERVER_REASON);
    });

    test('Enter on the enableable row still announces something meaningful', async () => {
      selectionModelState.agents = [LONG_ALIAS];
      materializeMock.mockResolvedValueOnce({ data: AUTHORED_CODEX });
      renderModal();

      fireEvent.keyDown(screen.getByPlaceholderText(/search/i), {
        key: 'Enter',
      });

      // Never-silent invariant survives the copy change.
      expect(screen.getByRole('alert').textContent).toMatch(
        /setting up codex/i,
      );
      await waitFor(() => expect(materializeMock).toHaveBeenCalledTimes(1));
    });

    test('the chip is inline with the name and Enable remains the row action', () => {
      selectionModelState.agents = [LONG_ALIAS];
      renderModal();

      const select = document.querySelector(
        'button[data-agent-slug="codex"]',
      ) as HTMLButtonElement;
      const container = select.closest(
        '.new-chat-modal__agent-row',
      ) as HTMLElement;
      const side = container.querySelector('.new-chat-modal__agent-side');
      const name = container.querySelector('.new-chat-modal__agent-name');
      const chip = container.querySelector('.status');
      const enable = container.querySelector('[data-agent-action="enable"]');

      expect(chip?.textContent).toContain('Not set up');
      // Inline with the name means the same row, immediately after the name
      // element — not inside it (the name element carries only the name) and
      // not in the quiet meta line below.
      expect(name?.nextElementSibling).toBe(chip);
      expect(side?.contains(enable as Node)).toBe(true);
      expect(select.contains(chip as Node)).toBe(true);
    });

    // DESIGN.md §5: EVERY non-ready row carries a state, in the same words
    // the Agents list uses — the row that "kept its reason and got no chip"
    // was the one case the picker and the list described differently. The
    // sentence is now always the row's accessible description, and the chip
    // is always the visible statement.
    test('a row with no enable signal states its need and keeps the sentence for a11y', () => {
      selectionModelState.agents = [UNAVAILABLE_AGENT];
      renderModal();

      expect(screen.queryByText('Not set up')).toBeNull();
      expect(screen.getByText('Needs: connection offline')).toBeTruthy();
      const reason = reasonNode('downed');
      expect(reason?.textContent).toBe('connection offline');
      expect(reason?.className).toContain(
        'new-chat-modal__agent-reason--assistive',
      );
    });
  });

  test('a throw from the parent onSelect handler surfaces as feedback', () => {
    selectionModelState.isGlobal = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderModal(
      vi.fn(() => {
        throw new Error('lazy chunk failed');
      }),
    );
    clickAgent('assistant');
    expect(screen.getByRole('alert').textContent).toMatch(/could not start/i);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

import { shouldRouteScopedChatProject } from '../components/chat-dock/chat-dock-utils';

describe('shouldRouteScopedChatProject (#3013 routing seam)', () => {
  const base = {
    hasImmutableProjectScope: true,
    targetProjectSlug: 'other',
    currentProjectSlug: 'here',
    layoutSlug: 'coding',
  };

  test('routes only when every precondition holds', () => {
    expect(shouldRouteScopedChatProject(base)).toBe(true);
  });

  test('a missing layout slug must NOT claim the route', () => {
    // The live #3013 defect: claiming true here made every caller return on
    // a navigation that never happened — no chat, no modal close, no error.
    expect(
      shouldRouteScopedChatProject({ ...base, layoutSlug: undefined }),
    ).toBe(false);
  });

  test('unscoped, same-project, and missing-target requests are handled in place', () => {
    expect(
      shouldRouteScopedChatProject({
        ...base,
        hasImmutableProjectScope: false,
      }),
    ).toBe(false);
    expect(
      shouldRouteScopedChatProject({ ...base, targetProjectSlug: 'here' }),
    ).toBe(false);
    expect(
      shouldRouteScopedChatProject({ ...base, targetProjectSlug: undefined }),
    ).toBe(false);
  });
});
