/**
 * @vitest-environment jsdom
 *
 * archive#3013 — selecting an agent must never be a silent no-op.
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

import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { agentId, engineId } from '@kontourai/station-contracts/agent-identity';
import type {
  InstalledSkillExperienceV1,
  SkillExperienceDefinitionV1,
  SkillExperienceInventoryV1,
} from '@kontourai/station-contracts/skill-experience';
import type { ExternalEngineReadinessProjection } from '@kontourai/station-contracts/system-status';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentData } from '../contexts/AgentsContext';
import type { ProjectMetadata } from '../contexts/ProjectsContext';
import { resetStartChoicesForTests } from '../hooks/useStartSelection';

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

// archive#3027: an engine-default alias row carrying the machine-readable
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
  models: [] as Array<{ id: string; providerId?: string }>,
  isGlobal: true as boolean,
  selectedProject: undefined as
    | { slug: string; name: string; workingDirectory?: string }
    | undefined,
  agents: [AGENT] as AgentData[],
  // Enable's FIND scope (archive#3027). `null` mirrors the default: the scoped
  // set equals the rendered agents.
  scopedAgents: null as AgentData[] | null,
  agentConnections: [] as unknown[],
  recommendedAgent: AGENT as AgentData | undefined,
  loading: false,
  refreshSetup: undefined as (() => Promise<void>) | undefined,
};

vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));

// Enable's CREATE half is `POST /agents/materialize-engine` — the one
// find-or-create path the server owns. Mocking the SDK mutation keeps
// react-query (and its provider requirement) out of this render tree.
const { materializeMock, connectMock, detectedEngines } = vi.hoisted(() => ({
  materializeMock: vi.fn(),
  connectMock: vi.fn(),
  detectedEngines: [] as ExternalEngineReadinessProjection[],
}));
vi.mock('../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({
    data: { externalEngines: detectedEngines },
    isLoading: false,
    isFetching: false,
  }),
}));
const experienceInventory = vi.hoisted(() => ({
  current: { experiences: [], diagnostics: [] } as SkillExperienceInventoryV1,
}));
vi.mock('../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({
    namespace: 'authority-1',
    status: 'verified',
  }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useSkillExperienceInventoryQuery: () => ({
    data: experienceInventory.current,
    refetch: vi.fn(),
  }),
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: materializeMock }),
  useConnectAndMaterializeEngineMutation: () => ({ mutateAsync: connectMock }),
}));

vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: () => ({
    viewModel: {
      isGlobal: selectionModelState.isGlobal,
      selectedProject: selectionModelState.selectedProject,
      contextOptions: [],
      filteredContextOptions: [],
      // As the real view model: no option for a project the list lacks.
      currentContextOption:
        selectionModelState.isGlobal || selectionModelState.selectedProject
          ? {
              value: selectionModelState.selectedProject?.slug ?? '__global__',
              label:
                selectionModelState.selectedProject?.name ?? 'No workspace',
              glyph: 'folder',
            }
          : undefined,
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
    defaultSelection: { agent: selectionModelState.recommendedAgent },
    runtimeLoading: selectionModelState.loading,
    modelsLoading: selectionModelState.loading,
    refreshSetup: selectionModelState.refreshSetup,
    modelPickerAgent: null,
    setModelPickerAgent: vi.fn(),
    modelChoices: {},
    setModelChoices: vi.fn(),
    modelsForAgent: () => selectionModelState.models,
    modelChoiceKey: (agent: AgentData) => agent.slug,
    defaultEffectiveModelForAgent: () => ({
      id: undefined,
      label: 'Model not reported',
      source: 'agent default' as const,
    }),
  }),
}));

const { NewChatModal } = await import('../components/modals/NewChatModal');
const { getContextAgent } = await import('../hooks/useRecentAgents');
const { buildCodingChatInitialMessage } = await import(
  '../components/coding-layout/chatContextDraft'
);
const { composerDraftContext } = await import(
  '../components/chat-dock/ChatDockModalStack'
);
const { pluginAuthoringComposerDraft } = await import(
  '../views/plugin-management/plugin-authoring-primer'
);

afterEach(() => {
  cleanup();
  resetStartChoicesForTests();
  // Chip choices are remembered in storage; no test may inherit another's.
  localStorage.clear();
  experienceInventory.current = { experiences: [], diagnostics: [] };
  selectionModelState.isGlobal = true;
  selectionModelState.selectedProject = undefined;
  selectionModelState.agents = [AGENT];
  selectionModelState.scopedAgents = null;
  selectionModelState.agentConnections = [];
  selectionModelState.recommendedAgent = AGENT;
  selectionModelState.loading = false;
  materializeMock.mockReset();
  connectMock.mockReset();
  detectedEngines.length = 0;
  selectionModelState.refreshSetup = undefined;
  selectionModelState.models = [];
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
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
          'Engine cursor, tool state, and approval state do not carry.',
        ...mode,
      }}
    />,
  );
  return onSelect;
}

test('late project context preserves the preferred fork Agent', () => {
  selectionModelState.agents = [
    { ...AGENT, slug: agentId('other'), name: 'Other' },
    AGENT,
  ];
  const props = {
    agents: selectionModelState.agents,
    activeProjectSlug: 'dev',
    onSelect: vi.fn(),
    onClose: vi.fn(),
    mode: {
      kind: 'fork' as const,
      preferredAgentSlug: 'assistant',
      sourceModel: 'historical-source-model',
      disclosure: 'Fork independently',
    },
  };
  const view = render(<NewChatModal {...props} projects={[]} />);
  const source = () =>
    document.querySelector('button[data-agent-slug="assistant"]')!;
  expect(source().className).toContain('new-chat-modal__agent--selected');
  view.rerender(
    <NewChatModal
      {...props}
      projects={[
        {
          id: 'dev',
          slug: 'dev',
          name: 'Dev',
          description: '',
          workingDirectory: '/workspace/dev',
          hasWorkingDirectory: true,
          layoutCount: 0,
          hasKnowledge: false,
        },
      ]}
    />,
  );
  expect(source().className).toContain('new-chat-modal__agent--selected');
});

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
      /new independent conversation.*engine cursor.*tool state.*approval state do not carry/i,
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

  test('a requested composer draft is offered and handed over verbatim for the composer, not sent (#2323 S2)', () => {
    // The New plugin flow asks the dock for a primed chat. The dock turns
    // the request into this picker's draft item; picking an Agent hands the
    // exact text to `onSelect` as the initial message, which the dock places
    // in the composer input (`openChatForAgent`'s `updateChat({ input })`).
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = {
      slug: 'pulse',
      name: 'Pulse',
      workingDirectory: '/tmp/pulse',
    };
    const draft = pluginAuthoringComposerDraft({
      name: 'pulse',
      displayName: 'Pulse',
      template: 'pane',
    });
    const onSelect = vi.fn();
    render(
      <NewChatModal
        agents={selectionModelState.agents}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        draftContext={composerDraftContext(draft)}
      />,
    );

    expect(screen.getByText('Plugin authoring')).toBeTruthy();
    clickAgent('assistant');

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][1]).toBe('pulse');
    // Verbatim: no "Coding context for this chat" framing around it.
    expect(onSelect.mock.calls[0][3]).toBe(draft.message);
  });

  test('a deselected composer draft hands over nothing', () => {
    const draft = pluginAuthoringComposerDraft({
      name: 'pulse',
      displayName: 'Pulse',
      template: 'pane',
    });
    const onSelect = vi.fn();
    render(
      <NewChatModal
        agents={selectionModelState.agents}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        draftContext={composerDraftContext(draft)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Opening message/ }));
    clickAgent('assistant');
    expect(onSelect.mock.calls[0][3]).toBeUndefined();
  });

  test('non-global context with an unresolved project must not be silent', () => {
    // The live archive#3013 state: context names a project the projects list cannot
    // resolve. Dispatching would target a workspace the server cannot
    // resolve either — so no dispatch — but the user must be TOLD, not
    // ignored.
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = undefined;
    const onSelect = renderModal();
    clickAgent('assistant');
    expect(onSelect).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/needs a project/i);
  });

  test('Enter on an unavailable agent speaks instead of silently returning', () => {
    // The keyboard path reaches handleSelect with no availability filter; the
    // pointer path cannot (the row button is disabled). Review.
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
    // One visible statement of the refusal (the shared readiness chip, in
    // the same compact words the Agents list row uses) and one accessible
    // description carrying the server's sentence.
    expect(screen.getByText('Not set up')).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('the model trigger is disabled while the engine reports no catalog', () => {
    // modelsForAgent is [] for every agent in this harness, so the trigger
    // must not offer a picker that would open empty; the accessible name
    // still says what the control is and the tooltip names why.
    selectionModelState.agents = [AGENT];
    renderModal();
    const trigger = document.querySelector(
      '.new-chat-modal__model-trigger',
    ) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.getAttribute('aria-label')).toBe(
      'Model: Model not reported',
    );
    expect(trigger.getAttribute('title')).toBe(
      'This Agent has not reported a model catalog',
    );
    fireEvent.click(trigger);
    expect(
      document.querySelector('.new-chat-modal__model-picker-backdrop'),
    ).toBeNull();
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

  // archive#3027(c). The owner's report: "text in new chat modal is way way
  // too long.. and doesn't really indicate an issue to me". Each engine
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
    // the Agents list uses — and the Agents list row renders the COMPACT
    // badge (agentsViewHelpers `part="status" compact`), so the picker now
    // does too. The full server sentence used to BE the badge label here; a
    // paragraph for a chip that squeezed the row's own name to one letter
    // while the sentence stayed in the accessibility tree either way. The
    // visible state is short vocabulary; the sentence remains the row's
    // accessible description.
    test('a row with no enable signal states its need compactly and keeps the sentence for a11y', () => {
      selectionModelState.agents = [UNAVAILABLE_AGENT];
      renderModal();

      expect(screen.queryByText('Needs: connection offline')).toBeNull();
      expect(screen.getByText('Not set up')).toBeTruthy();
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
    // The live archive#3013 defect: claiming true here made every caller return on
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

describe('start with working defaults', () => {
  test('opens the recommended ready agent without making a choice among other ready agents', async () => {
    const other = { ...AGENT, slug: agentId('other'), name: 'Other' };
    selectionModelState.agents = [other, AGENT];
    const onSelect = vi.fn();
    const view = render(
      <NewChatModal
        agents={selectionModelState.agents}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        startWithDefault
      />,
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
    expect(onSelect.mock.calls[0]?.[0]).toBe(AGENT);
    view.rerender(
      <NewChatModal
        agents={selectionModelState.agents}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        startWithDefault
      />,
    );
    expect(onSelect).toHaveBeenCalledOnce();
  });

  test('waits for the catalog before selecting a default', async () => {
    selectionModelState.loading = true;
    const onSelect = vi.fn();
    const view = render(
      <NewChatModal
        agents={[AGENT]}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        startWithDefault
      />,
    );
    expect(onSelect).not.toHaveBeenCalled();
    selectionModelState.loading = false;
    view.rerender(
      <NewChatModal
        agents={[AGENT]}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        startWithDefault
      />,
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
  });

  test('prepares an already-ready engine through the existing idempotent materialization owner', async () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS];
    selectionModelState.recommendedAgent = undefined;
    materializeMock.mockResolvedValue({ data: AUTHORED_CODEX });
    const onSelect = vi.fn();
    render(
      <NewChatModal
        agents={[ENABLEABLE_ALIAS]}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        startWithDefault
      />,
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
    expect(materializeMock).toHaveBeenCalledExactlyOnceWith('codex');
    expect(onSelect.mock.calls[0]?.[0]).toBe(AUTHORED_CODEX);
  });
});

describe('intent-first preparation', () => {
  test.each([false, true])(
    'waits for installed-app preparation and catalog refresh before dispatch (warned=%s)',
    async (warned) => {
      selectionModelState.agents = [];
      selectionModelState.recommendedAgent = undefined;
      detectedEngines.push({
        engineId: engineId('codex'),
        name: 'Codex',
        detected: true,
        ready: false,
        source: 'registry',
        reason: 'not_connected',
        registryEntryId: 'codex',
      });
      const warning = 'Sign in to Codex before starting.';
      connectMock.mockResolvedValue({
        data: AGENT,
        created: true,
        warnings: warned ? [warning] : [],
      });
      let settleRefresh!: () => void;
      const refreshing = new Promise<void>((resolve) => {
        settleRefresh = resolve;
      });
      const onSelect = vi.fn();
      let view!: ReturnType<typeof render>;
      const modal = () => (
        <NewChatModal
          agents={selectionModelState.agents}
          projects={[]}
          onSelect={onSelect}
          onClose={vi.fn()}
          startWithDefault
          initialPrompt="Keep this goal"
        />
      );
      const refresh = vi.fn(async () => {
        selectionModelState.loading = true;
        view.rerender(modal());
        selectionModelState.agents = [AGENT];
        selectionModelState.recommendedAgent = AGENT;
        selectionModelState.loading = false;
        view.rerender(modal());
        await refreshing;
      });
      selectionModelState.refreshSetup = refresh;
      view = render(modal());
      try {
        await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
        expect(onSelect).not.toHaveBeenCalled();
        await act(async () => settleRefresh());
        if (warned) {
          await waitFor(() => expect(screen.getByText(warning)).toBeTruthy());
          expect(onSelect).not.toHaveBeenCalled();
        } else {
          await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
          expect(onSelect.mock.calls[0]?.[3]).toBe('Keep this goal');
        }
      } finally {
        await act(async () => settleRefresh());
      }
    },
  );

  test('passes the original goal directly to the conversation without a model or agent choice', async () => {
    const onSelect = vi.fn();
    const prompt = 'Reply exactly GOAL READY.\nUse no tools.';
    render(
      <NewChatModal
        agents={[AGENT]}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        startWithDefault
        initialPrompt={prompt}
      />,
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledOnce());
    expect(onSelect.mock.calls[0]?.[3]).toBe(prompt);
    expect(screen.queryByPlaceholderText('Search agents…')).toBeNull();
  });

  test('closing preparation prevents a late materialization from starting the goal', async () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS];
    selectionModelState.recommendedAgent = undefined;
    let complete: ((value: { data: AgentData }) => void) | undefined;
    materializeMock.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <NewChatModal
        agents={[ENABLEABLE_ALIAS]}
        projects={[]}
        onSelect={onSelect}
        onClose={onClose}
        startWithDefault
        initialPrompt="Keep this goal"
      />,
    );
    await waitFor(() => expect(materializeMock).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Close new chat' }));
    await act(async () => complete?.({ data: AUTHORED_CODEX }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('a warned preparation cannot start the goal or claim success', async () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS];
    selectionModelState.recommendedAgent = undefined;
    materializeMock.mockResolvedValue({
      data: AUTHORED_CODEX,
      warnings: ['Sign in to Codex before starting.'],
    });
    const onSelect = vi.fn();
    render(
      <NewChatModal
        agents={[ENABLEABLE_ALIAS]}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        startWithDefault
        initialPrompt="Keep this goal"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText('Sign in to Codex before starting.'),
      ).toBeTruthy(),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('visual skill selection through the New Chat picker', () => {
  function installedExperience(): InstalledSkillExperienceV1 {
    const definition: SkillExperienceDefinitionV1 = JSON.parse(
      readFileSync(
        new NodeURL(
          '../../../examples/visual-skill-experience/io.kontourai.station/experiences/stress-test-idea.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    return {
      definition,
      identity: {
        pluginId: 'example',
        pluginVersion: '1.0.0',
        experienceId: definition.id,
        incarnation: 'installation-1',
        materialization: 'materialization-1',
        contentDigest: 'digest-1',
        definitionDigest: 'definition-1',
      },
    };
  }
  const authority = {
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
    isCurrent: () => true,
  };
  test('prepares edited source-bound intent without dispatching until an Agent is chosen', () => {
    const experience = installedExperience();
    experienceInventory.current = {
      executionContract: '1.0',
      experiences: [experience],
      diagnostics: [],
    } as SkillExperienceInventoryV1;
    const onSelect = vi.fn();
    render(
      <NewChatModal
        agents={[AGENT]}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        requestAuthority={authority}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: new RegExp(experience.definition.title),
      }),
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: /What would you like to build/ }),
      { target: { value: 'My edited proposal' } },
    );
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Assistant Ready/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0].at(-1)).toMatchObject({
      namespace: 'authority-1',
      apiBase: authority.apiBase,
      start: {
        identity: experience.identity,
        inputs: { idea: 'My edited proposal' },
      },
    });
  });
  test('inventory-only hosts retain the inputs and visibly refuse preparing a start', () => {
    const experience = installedExperience();
    experienceInventory.current = {
      experiences: [experience],
      diagnostics: [],
    };
    const onSelect = vi.fn();
    render(
      <NewChatModal
        agents={[AGENT]}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        requestAuthority={authority}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: new RegExp(experience.definition.title),
      }),
    );
    fireEvent.change(
      screen.getByRole('textbox', { name: /What would you like to build/ }),
      { target: { value: 'Retain this' } },
    );
    fireEvent.click(screen.getByRole('button', { name: /Assistant Ready/ }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot start on this Station/)).toBeTruthy();
    expect(
      screen.getByRole('textbox', { name: /What would you like to build/ }),
    ).toHaveProperty('value', 'Retain this');
  });
});

describe('the start composer in the dock', () => {
  function start(
    onSelect = vi.fn(),
    props: Partial<ComponentProps<typeof NewChatModal>> = {},
  ) {
    render(
      <NewChatModal
        startSurface
        agents={selectionModelState.agents}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
        {...props}
      />,
    );
    return onSelect;
  }
  const message = () =>
    screen.getByRole('textbox', {
      name: 'What would you like done?',
    }) as HTMLTextAreaElement;
  const startButton = () =>
    screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
  async function chooseInMenu(chip: string, slug: string) {
    fireEvent.click(screen.getByRole('button', { name: chip }));
    await screen.findByRole('dialog', { name: 'Choose agent' });
    clickAgent(slug);
  }

  test('typing and choosing another Agent do not open a chat; Start starts the chosen Agent once with the message', async () => {
    selectionModelState.agents = [AGENT, AUTHORED_CODEX];
    const onSelect = start();
    fireEvent.change(message(), { target: { value: 'Review this change' } });
    expect(onSelect).not.toHaveBeenCalled();
    await chooseInMenu('Agent: Assistant', 'codex-agent');
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Choose agent' })).toBeNull();
    expect(message().value).toBe('Review this change');
    expect(
      screen.getByRole('button', { name: 'Agent: Codex Agent' }),
    ).toBeTruthy();
    fireEvent.click(startButton());
    fireEvent.submit(screen.getByRole('form', { name: 'Start work' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].slug).toBe('codex-agent');
    expect(onSelect.mock.calls[0][3]).toBe('Review this change');
    expect(onSelect.mock.calls[0][12]).toBe(true);
  });

  // Owner decision: a chip choice is remembered as the default for that
  // context, in the memory the next start (on either surface) reads.
  test('choosing an Agent remembers it for this context before anything starts', async () => {
    localStorage.clear();
    selectionModelState.agents = [AGENT, AUTHORED_CODEX];
    const onSelect = start();
    await chooseInMenu('Agent: Assistant', 'codex-agent');
    expect(onSelect).not.toHaveBeenCalled();
    expect(getContextAgent('authority-1', '__global__')).toBe('codex-agent');
  });

  test('an unavailable remembered Agent shows setup and retains the message without dispatching', async () => {
    selectionModelState.agents = [UNAVAILABLE_AGENT, AGENT];
    selectionModelState.recommendedAgent = UNAVAILABLE_AGENT;
    const onSelect = start();
    fireEvent.change(message(), { target: { value: 'Keep this draft' } });
    expect(
      (await screen.findByRole('region', { name: 'Set up an AI connection' }))
        .textContent,
    ).toContain('connection offline');
    expect(startButton().disabled).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    await chooseInMenu('Agent: Downed, needs setup', 'assistant');
    expect(message().value).toBe('Keep this draft');
    expect(startButton().disabled).toBe(false);
  });

  test('a failed start retains the message and allows a retry', async () => {
    const onSelect = start(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(undefined),
    );
    fireEvent.change(message(), { target: { value: 'Do this later' } });
    fireEvent.click(startButton());
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Could not start',
      ),
    );
    expect(message().value).toBe('Do this later');
    fireEvent.click(startButton());
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  test('Enable prepares an Agent and returns to the draft without opening a conversation', async () => {
    selectionModelState.agents = [ENABLEABLE_ALIAS, AUTHORED_CODEX];
    selectionModelState.recommendedAgent = ENABLEABLE_ALIAS;
    const onSelect = start();
    fireEvent.change(message(), { target: { value: 'Wait until I send' } });
    fireEvent.click(await screen.findByRole('button', { name: /Enable/ }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Agent: Codex Agent' }),
      ).toBeTruthy(),
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(materializeMock).not.toHaveBeenCalled();
    expect(message().value).toBe('Wait until I send');
  });

  // Owner decision 2: a requested draft folds into the composer as a
  // removable context chip. With no message, the start hands over exactly
  // the old Agent-row start's message (placed in the composer, not sent);
  // with a message, the message comes first, then that same context, sent.
  describe('context handed to the draft', () => {
    const draft = {
      title: 'Prepared request',
      description: 'From the plugin primer',
      framing: 'verbatim' as const,
      items: [
        {
          id: 'composer-draft',
          label: 'Request',
          detail: 'Build a plugin',
          messageLine: 'Build a plugin that lists my tasks.',
        },
      ],
    };
    const legacy = buildCodingChatInitialMessage(draft.items, 'verbatim');

    test('with no message the start is byte-identical to the Agent-row start, and is not sent', () => {
      const onSelect = start(vi.fn(), { draftContext: draft });
      expect(
        screen.getByRole('button', { name: 'Request: Build a plugin' }),
      ).toBeTruthy();
      expect(
        screen.getByText(/With no message, Start puts this context/),
      ).toBeTruthy();
      fireEvent.click(startButton());
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect.mock.calls[0][3]).toBe(legacy);
      expect(onSelect.mock.calls[0][3]).toBe(
        'Build a plugin that lists my tasks.',
      );
      expect(onSelect.mock.calls[0][12]).not.toBe(true);
    });

    test('with a message it is the message, a blank line, then the context, and it is sent', () => {
      const onSelect = start(vi.fn(), { draftContext: draft });
      fireEvent.change(message(), { target: { value: '  Make it small  ' } });
      fireEvent.click(startButton());
      // Leading indentation stays; only the trailing spaces go.
      expect(onSelect.mock.calls[0][3]).toBe(`  Make it small\n\n${legacy}`);
      expect(onSelect.mock.calls[0][12]).toBe(true);
    });

    test('removing the context leaves nothing to start until a message is typed', () => {
      const onSelect = start(vi.fn(), { draftContext: draft });
      fireEvent.click(
        screen.getByRole('button', { name: 'Request: Build a plugin' }),
      );
      expect(startButton().disabled).toBe(true);
      fireEvent.change(message(), { target: { value: 'Just this' } });
      fireEvent.click(startButton());
      expect(onSelect.mock.calls[0][3]).toBe('Just this');
    });
  });

  // Home's composer sends what its chips show; the dock starts exactly that
  // and never substitutes its own default.
  describe("a start carrying Home's selection", () => {
    test('starts the chosen Agent with the chosen Model and runtime options', async () => {
      selectionModelState.agents = [AGENT, AUTHORED_CODEX];
      selectionModelState.recommendedAgent = AGENT;
      // The chosen Model is still in the catalog.
      selectionModelState.models = [{ id: 'gpt-5.4', providerId: 'codex' }];
      const onSelect = start(vi.fn(), {
        startWithDefault: true,
        initialPrompt: 'From Home',
        startSelection: {
          context: '__global__',
          agentSlug: 'codex-agent',
          model: {
            modelId: 'gpt-5.4',
            providerId: 'codex',
            providerOptions: { reasoningEffort: 'high' },
          },
        },
      });
      await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
      const call = onSelect.mock.calls[0];
      expect(call[0].slug).toBe('codex-agent');
      expect(call[3]).toBe('From Home');
      expect(call[4]).toBe('gpt-5.4');
      expect(call[8]).toEqual({ reasoningEffort: 'high' });
      expect(call[9]).toBe('codex');
    });

    test('an Agent the dock cannot start is refused out loud, with the message kept', async () => {
      selectionModelState.agents = [UNAVAILABLE_AGENT, AGENT];
      selectionModelState.recommendedAgent = AGENT;
      const onSelect = start(vi.fn(), {
        startWithDefault: true,
        initialPrompt: 'From Home',
        startSelection: { context: '__global__', agentSlug: 'downed' },
      });
      expect(
        (await screen.findByRole('form', { name: 'Start work' })) &&
          message().value,
      ).toBe('From Home');
      expect(
        screen.getByText(/The Agent you chose is not ready here/),
      ).toBeTruthy();
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  // #3350 item 1: the dock names a project the list has not loaded. The
  // start waits instead of running global with the global Model.
  test('a bound project whose list is still loading holds the chips and the start', async () => {
    const onSelect = start(vi.fn(), {
      activeProjectSlug: 'station',
      projectsLoaded: false,
    });
    fireEvent.change(message(), { target: { value: 'Wait for it' } });
    expect(
      screen.getByRole('status', {
        name: 'Checking which project the chat starts in',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Agent:/ })).toBeNull();
    expect(startButton().disabled).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('a bound project whose list is still loading holds the automatic start too', async () => {
    const onSelect = start(vi.fn(), {
      activeProjectSlug: 'station',
      projectsLoaded: false,
      startWithDefault: true,
      initialPrompt: 'From Home',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('once the list arrives the held automatic start runs in the bound project', async () => {
    const station = {
      id: 'p1',
      slug: 'station',
      name: 'Station',
      workingDirectory: '/w/station',
    } as unknown as ProjectMetadata;
    const onSelect = vi.fn();
    const props = {
      startSurface: true,
      agents: selectionModelState.agents,
      onSelect,
      onClose: vi.fn(),
      activeProjectSlug: 'station',
      startWithDefault: true,
      initialPrompt: 'From Home',
    };
    const view = render(
      <NewChatModal {...props} projects={[]} projectsLoaded={false} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSelect).not.toHaveBeenCalled();
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = station;
    view.rerender(
      <NewChatModal {...props} projects={[station]} projectsLoaded />,
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][1]).toBe('station');
    expect(onSelect.mock.calls[0][3]).toBe('From Home');
  });

  // Review finding: Home's chosen project must never be swapped for a
  // default when the dock's list no longer has it.
  test('a start whose chosen project is gone is refused out loud, keeping the message and the project', async () => {
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = undefined;
    const onSelect = start(vi.fn(), {
      startWithDefault: true,
      initialPrompt: 'From Home',
      startSelection: { context: 'gone', agentSlug: 'assistant' },
    });
    expect(
      (await screen.findByText(/project you chose is no longer available/))
        .textContent,
    ).toBeTruthy();
    expect(message().value).toBe('From Home');
    expect(screen.getByRole('button', { name: 'Project: gone' })).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // Delta review: Home's start that lands while the dock's own project list
  // is still loading waits for it; it is not refused as a missing project.
  test("a start for Home's project waits for the dock's list, then runs there", async () => {
    const station = {
      id: 'p1',
      slug: 'station',
      name: 'Station',
      workingDirectory: '/w/station',
    } as unknown as ProjectMetadata;
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = undefined;
    const onSelect = vi.fn();
    const props = {
      startSurface: true,
      agents: selectionModelState.agents,
      onSelect,
      onClose: vi.fn(),
      startWithDefault: true,
      initialPrompt: 'From Home',
      startSelection: { context: 'station', agentSlug: 'assistant' },
    };
    const view = render(
      <NewChatModal {...props} projects={[]} projectsLoaded={false} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByText(/no longer available/)).toBeNull();
    selectionModelState.selectedProject = station;
    view.rerender(
      <NewChatModal {...props} projects={[station]} projectsLoaded />,
    );
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][1]).toBe('station');
  });

  // Delta review: Enter on an Agent that cannot start does what its row
  // offers; it does not choose it.
  test('Enter on an Agent that cannot start does not choose it', async () => {
    selectionModelState.agents = [AGENT, UNAVAILABLE_AGENT];
    start();
    fireEvent.click(screen.getByRole('button', { name: 'Agent: Assistant' }));
    const menu = await screen.findByRole('dialog', { name: 'Choose agent' });
    const search = within(menu).getByRole('textbox', { name: 'Search agents' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Choose agent' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Agent: Assistant' }),
    ).toBeTruthy();
    expect(getContextAgent('authority-1', '__global__')).toBeUndefined();
  });

  // Review FI-2: a skills hand-off from Home opens the skills picker here.
  test("a skills hand-off opens the visual skills list with Home's message", () => {
    start(vi.fn(), {
      initialPrompt: 'From Home',
      handoff: { kind: 'skills' },
    });
    expect(screen.getByRole('region', { name: 'Visual skills' })).toBeTruthy();
    expect(message().value).toBe('From Home');
  });

  // Review MED-2: an unreadable selection is said; the message is kept and
  // nothing starts.
  test('an unreadable selection opens the composer with the message and says so', async () => {
    const onSelect = start(vi.fn(), {
      initialPrompt: 'From Home',
      selectionInvalid: true,
    });
    expect(message().value).toBe('From Home');
    expect(
      screen.getByText(/choices sent with this chat could not be read/),
    ).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onSelect).not.toHaveBeenCalled();
  });

  // Review MED-2: a Model Home chose that the dock no longer lists is not
  // started on; the composer asks for another, message kept.
  test("a start on Home's Model that is gone is refused, not started", async () => {
    const onSelect = start(vi.fn(), {
      startWithDefault: true,
      initialPrompt: 'From Home',
      startSelection: {
        context: '__global__',
        agentSlug: 'assistant',
        model: { modelId: 'gone-model', providerOptions: {} },
      },
    });
    expect(
      await screen.findByText(/Model you selected is no longer available/),
    ).toBeTruthy();
    expect(message().value).toBe('From Home');
    expect(onSelect).not.toHaveBeenCalled();
  });

  // Review finding: the dock builds a new draft object every render; a chip
  // the user removed must stay removed and stay out of the message.
  test('a removed context chip stays removed when the dock re-renders', () => {
    const draft = () => ({
      title: 'Prepared request',
      description: 'From the plugin primer',
      framing: 'verbatim' as const,
      items: [
        {
          id: 'composer-draft',
          label: 'Request',
          detail: 'Build a plugin',
          messageLine: 'CTX LINE',
        },
      ],
    });
    const onSelect = vi.fn();
    const props = {
      startSurface: true,
      agents: selectionModelState.agents,
      projects: [],
      onSelect,
      onClose: vi.fn(),
    };
    const view = render(<NewChatModal {...props} draftContext={draft()} />);
    const chip = () =>
      screen.getByRole('button', { name: 'Request: Build a plugin' });
    fireEvent.click(chip());
    expect(chip().getAttribute('aria-pressed')).toBe('false');
    view.rerender(<NewChatModal {...props} draftContext={draft()} />);
    expect(chip().getAttribute('aria-pressed')).toBe('false');
    fireEvent.change(message(), { target: { value: 'Just this' } });
    fireEvent.click(startButton());
    expect(onSelect.mock.calls[0][3]).toBe('Just this');
  });
});
