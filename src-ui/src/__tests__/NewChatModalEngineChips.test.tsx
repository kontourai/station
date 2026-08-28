// @vitest-environment jsdom

import {
  agentId,
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { NewChatModal } from '../components/modals/NewChatModal';
import { GLOBAL_CONTEXT } from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';
import { navigationStore } from '../contexts/navigation-store';

// NewChatModal's Enable posts to `/agents/materialize-engine` through this
// SDK mutation; a minimal mock keeps react-query's provider requirement out
// of this render tree.
vi.mock('@kontourai/station-sdk', () => ({
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: vi.fn() }),
  authenticatedFetch: vi.fn(async () => ({ ok: false })),
}));

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));

// The two engine connections a single external engine can produce
// (docs/design/agent-engine-unification.md §8.1): a native runtime
// connection and an ACP connection, both surfaced under the same display
// name "OpenCode" — disambiguated by the ACP row's model suffix.
const NATIVE_OPENCODE: AgentData = {
  slug: agentId('opencode'),
  name: 'OpenCode',
  source: 'local',
  model: 'shared-model',
  modelOptions: [
    {
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      originalId: 'gpt-5.6-terra',
      capabilities: {
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
      },
    },
  ],
};
const ACP_OPENCODE: AgentData = {
  slug: agentId('opencode-conn-2'),
  name: 'OpenCode',
  source: 'acp',
  engineConnectionType: 'acp',
  connectionName: 'OpenCode',
  model: 'GLM-4.7',
};
const STATION_AGENT: AgentData = {
  slug: agentId('code-reviewer'),
  name: 'Code Reviewer',
};
// Engine-managed runtime connection (Bedrock/Ollama) — Station-side
// execution is disambiguated by explicit engine identity.
const MANAGED_BEDROCK: AgentData = {
  slug: agentId('station'),
  name: 'Amazon Bedrock',
  source: 'local',
  engineId: engineId('station'),
  engineDefault: true,
  execution: {
    agentConnectionId: engineConnectionId('station'),
    runtimeOptions: { providerId: 'bedrock prod/primary' },
  },
  available: false,
  unavailableReason: 'Amazon Bedrock credentials are not configured.',
  unavailableFix: { kind: 'model-connection' },
};
const CUSTOM_CONFIG_AGENT: AgentData = {
  slug: agentId('custom-config-agent'),
  name: 'Custom configuration',
  source: 'local',
  available: false,
  unavailableReason: 'This Agent configuration needs attention.',
  unavailableFix: { kind: 'agent-configuration' },
};
const UNKNOWN_UNAVAILABLE_AGENT: AgentData = {
  slug: agentId('unknown-unavailable-agent'),
  name: 'Unknown unavailable state',
  source: 'local',
  available: false,
  unavailableReason: 'An external policy currently prevents launch.',
  unavailableFix: { kind: 'unknown' },
};

vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: () => {
    const [modelPickerAgent, setModelPickerAgent] = useState<AgentData | null>(
      null,
    );
    const [modelChoices, setModelChoices] = useState<
      Record<
        string,
        { modelId?: string; providerOptions: Record<string, unknown> }
      >
    >({});
    return {
      viewModel: {
        isGlobal: true,
        selectedProject: undefined,
        contextOptions: [
          { value: GLOBAL_CONTEXT, label: 'No workspace', glyph: 'globe' },
        ],
        filteredContextOptions: [
          { value: GLOBAL_CONTEXT, label: 'No workspace', glyph: 'globe' },
        ],
        currentContextOption: {
          value: GLOBAL_CONTEXT,
          label: 'No workspace',
          glyph: 'globe',
        },
        // Native and ACP entries with the same engine name converge into one
        // group (§8.3, new-chat-modal-utils.test.ts covers the grouping logic
        // itself) — this mock reflects that converged shape.
        groups: [
          {
            label: 'OpenCode',
            glyph: 'engine',
            agents: [NATIVE_OPENCODE, ACP_OPENCODE],
          },
          {
            label: 'Global',
            glyph: 'globe',
            agents: [
              STATION_AGENT,
              MANAGED_BEDROCK,
              CUSTOM_CONFIG_AGENT,
              UNKNOWN_UNAVAILABLE_AGENT,
            ],
          },
        ],
        flatList: [
          NATIVE_OPENCODE,
          ACP_OPENCODE,
          STATION_AGENT,
          MANAGED_BEDROCK,
          CUSTOM_CONFIG_AGENT,
          UNKNOWN_UNAVAILABLE_AGENT,
        ],
        compatibilityMessage: undefined,
      },
      agentConnections: [],
      modelConnections: [
        {
          id: 'bedrock prod/primary',
          kind: 'model',
          type: 'bedrock',
          name: 'Amazon Bedrock',
          enabled: true,
          capabilities: ['llm'],
          config: {},
          status: 'error',
          prerequisites: [],
        },
      ],
      runtimeLoading: false,
      modelsLoading: false,
      modelPickerAgent,
      setModelPickerAgent,
      modelChoices,
      setModelChoices,
      modelsForAgent: (agent: AgentData) =>
        agent.slug === NATIVE_OPENCODE.slug
          ? [
              {
                id: 'shared-model',
                name: 'Shared model · Provider one',
                providerId: 'provider-one',
                providerName: 'Provider one',
                providerType: 'bedrock',
                capabilities: {
                  supportsEffort: true,
                  supportedEffortLevels: ['low', 'high'],
                },
              },
              {
                id: 'shared-model',
                name: 'Shared model · Provider two',
                providerId: 'provider-two',
                providerName: 'Provider two',
                providerType: 'ollama',
              },
            ]
          : (agent.modelOptions ?? []),
      modelChoiceKey: (agent: AgentData) => agent.slug,
      defaultEffectiveModelForAgent: (agent: AgentData) => ({
        id: agent.model,
        label: agent.model ?? 'Model not reported',
        source: 'agent default',
        // Provider two is the bound default despite Provider one arriving
        // first in the catalog. The picker must not infer from inventory order.
        providerId: 'provider-two',
      }),
    };
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe('NewChatModal engine chips', () => {
  test('opens the shared rich model picker and preserves its exact provider choice for launch', async () => {
    const onSelect = vi.fn();
    render(
      <NewChatModal
        agents={[NATIVE_OPENCODE]}
        projects={[]}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /Model: shared-model/ }),
    );

    expect(
      await screen.findByRole('dialog', { name: 'Choose model' }),
    ).toBeTruthy();
    expect(await screen.findByPlaceholderText('Search models…')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Provider two' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.queryByRole('combobox', { name: 'Thinking effort' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Provider one' }));
    fireEvent.click(
      screen.getByRole('option', { name: /Shared model · Provider one/ }),
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Thinking effort' }),
      {
        target: { value: 'high' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Provider two' }));
    fireEvent.click(
      screen.getByRole('option', { name: /Shared model · Provider two/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close model picker' }));
    fireEvent.click(
      document.querySelector(
        '[data-agent-slug="opencode"]',
      ) as HTMLButtonElement,
    );

    expect(onSelect.mock.calls[0]?.[9]).toBe('provider-two');
    expect(onSelect.mock.calls[0]?.[10]).toBe('ollama');
    expect(onSelect.mock.calls[0]?.[8]).not.toHaveProperty('effort');
  });

  test('disambiguates the two identically-named OpenCode entries with engine chips', () => {
    render(
      <NewChatModal
        agents={[
          NATIVE_OPENCODE,
          ACP_OPENCODE,
          STATION_AGENT,
          MANAGED_BEDROCK,
          CUSTOM_CONFIG_AGENT,
          UNKNOWN_UNAVAILABLE_AGENT,
        ]}
        projects={[]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const rows = screen
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('data-agent-slug'));
    const nativeRow = rows.find(
      (row) => row.getAttribute('data-agent-slug') === NATIVE_OPENCODE.slug,
    );
    const acpRow = rows.find(
      (row) => row.getAttribute('data-agent-slug') === ACP_OPENCODE.slug,
    );
    const stationRow = rows.find(
      (row) => row.getAttribute('data-agent-slug') === STATION_AGENT.slug,
    );
    const managedRow = rows.find(
      (row) => row.getAttribute('data-agent-slug') === MANAGED_BEDROCK.slug,
    );

    // Both rows say "OpenCode"; only the ACP-connected row adds the
    // disambiguating model suffix.
    expect(nativeRow?.textContent).toContain('OpenCode');
    expect(nativeRow?.textContent).not.toContain('GLM-4.7');
    expect(acpRow?.textContent).toContain('OpenCode · GLM-4.7');

    // Station agents and engine-managed connections now render a "Station"
    // chip — the pre-#894 quiet default case is gone.
    expect(stationRow?.textContent).toContain('Station');
    expect(managedRow?.textContent).toContain('Station');
    expect(managedRow?.hasAttribute('disabled')).toBe(true);
    expect(managedRow?.textContent).toContain(
      'Amazon Bedrock credentials are not configured.',
    );
    expect(managedRow?.textContent).not.toContain(
      'Configure the engine connection to continue.',
    );

    // No row anywhere says "External" or "ACP" — permanent regression
    // guard.
    for (const row of rows) {
      expect(row.textContent).not.toContain('External');
      expect(row.textContent).not.toContain('ACP');
    }
  });

  test('keeps an unavailable Agent non-selectable with its one server-selected repair', () => {
    const onSelect = vi.fn();
    const order: string[] = [];
    const onClose = vi.fn(() => order.push('close'));
    const navigate = vi
      .spyOn(navigationStore, 'navigate')
      .mockImplementation(() => {
        order.push('navigate');
      });

    render(
      <NewChatModal
        agents={[
          NATIVE_OPENCODE,
          ACP_OPENCODE,
          STATION_AGENT,
          MANAGED_BEDROCK,
          CUSTOM_CONFIG_AGENT,
          UNKNOWN_UNAVAILABLE_AGENT,
        ]}
        projects={[]}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    const unavailableRow = screen
      .getAllByRole('button')
      .find((button) => button.dataset.agentSlug === MANAGED_BEDROCK.slug);
    expect(unavailableRow?.hasAttribute('disabled')).toBe(true);

    // The server's `model-connection` kind is the one repair; the picker
    // never re-derives a provider-specific destination from local inventory.
    fireEvent.click(
      screen.getByRole('button', { name: 'Connect Amazon Bedrock' }),
    );

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/connections/models');
    expect(order).toEqual(['close', 'navigate']);
  });

  test('leaves agent configuration and unknown unavailable states with an editor action, not a guessed fix', () => {
    const onClose = vi.fn();
    const navigate = vi
      .spyOn(navigationStore, 'navigate')
      .mockImplementation(() => undefined);

    render(
      <NewChatModal
        agents={[
          NATIVE_OPENCODE,
          ACP_OPENCODE,
          STATION_AGENT,
          MANAGED_BEDROCK,
          CUSTOM_CONFIG_AGENT,
          UNKNOWN_UNAVAILABLE_AGENT,
        ]}
        projects={[]}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );

    for (const agent of [CUSTOM_CONFIG_AGENT, UNKNOWN_UNAVAILABLE_AGENT]) {
      const edit = screen.getByRole('button', {
        name: `Edit agent ${agent.name}`,
      });
      expect(edit).toBeTruthy();
      expect(
        edit
          .closest('.new-chat-modal__agent-row')
          ?.querySelector('[data-agent-action="remedy"]'),
      ).toBeNull();
    }

    fireEvent.click(
      screen.getByRole('button', { name: 'Edit agent Custom configuration' }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/agents/custom-config-agent');
  });
});

// archive#3027(d). The owner's report: "throughout this app.. the important
// text is not well separated and just all ends up being white text on dark
// background hard to visually separate things". In this picker every line of
// a row — name, engine chip, description, reason — sat at one size and one
// weight, so nothing in a row was its subject. These tests pin the STRUCTURE
// that carries the hierarchy (which element is which, and where it lives),
// not the pixel values, which belong to `src-ui/src/index.css`.
describe('NewChatModal row hierarchy', () => {
  function renderPicker() {
    render(
      <NewChatModal
        agents={[
          NATIVE_OPENCODE,
          ACP_OPENCODE,
          STATION_AGENT,
          MANAGED_BEDROCK,
          CUSTOM_CONFIG_AGENT,
          UNKNOWN_UNAVAILABLE_AGENT,
        ]}
        projects={[]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
  }

  function row(slug: string) {
    const button = document.querySelector(
      `button[data-agent-slug="${slug}"]`,
    ) as HTMLButtonElement;
    expect(button).toBeTruthy();
    return button;
  }

  test('the name and the meta line are separate elements, name first', () => {
    renderPicker();
    const select = row(STATION_AGENT.slug);

    const name = select.querySelector(
      '.new-chat-modal__agent-name',
    ) as HTMLElement;
    const meta = select.querySelector(
      '.new-chat-modal__agent-meta',
    ) as HTMLElement;
    expect(name).toBeTruthy();
    expect(meta).toBeTruthy();
    expect(name.textContent).toBe('Code Reviewer');
    // Distinct nodes: the name is not inside the quiet line and the quiet
    // line is not inside the name. A single element cannot carry two rungs.
    expect(meta.contains(name)).toBe(false);
    expect(name.contains(meta)).toBe(false);
    expect(
      name.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('the engine chip moved off the name line into the meta line', () => {
    renderPicker();
    const select = row(ACP_OPENCODE.slug);

    const header = select.querySelector('.new-chat-modal__agent-header');
    const meta = select.querySelector('.new-chat-modal__agent-meta');
    // The chip is what the row IS, so it reads under the name rather than
    // competing with it for the first line.
    expect(header?.querySelector('.engine-chip')).toBeNull();
    expect(meta?.querySelector('.engine-chip')?.textContent).toBe(
      'OpenCode · GLM-4.7',
    );
  });

  test('a row that cannot start dims its name; a startable row does not', () => {
    renderPicker();

    const dimmed = 'new-chat-modal__agent-name--dimmed';
    // MANAGED_BEDROCK is `available: false` — it cannot start a chat.
    expect(
      row(MANAGED_BEDROCK.slug)
        .querySelector('.new-chat-modal__agent-name')
        ?.className.includes(dimmed),
    ).toBe(true);
    // NATIVE_OPENCODE can. Absence must read as absence, so presence must
    // not: without this half the class would be inert to prove.
    expect(
      row(NATIVE_OPENCODE.slug)
        .querySelector('.new-chat-modal__agent-name')
        ?.className.includes(dimmed),
    ).toBe(false);
  });

  test('state and actions sit in the row action area, never inside the select button', () => {
    renderPicker();

    const select = row(MANAGED_BEDROCK.slug);
    const container = select.closest(
      '.new-chat-modal__agent-row',
    ) as HTMLElement;
    const side = container.querySelector('.new-chat-modal__agent-side');
    expect(side).toBeTruthy();

    const remedy = container.querySelector('[data-agent-action="remedy"]');
    expect(side?.contains(remedy as Node)).toBe(true);
    // A control nested inside the row's own <button> would be an invalid,
    // unclickable nesting; the previous layout kept them as bare siblings
    // with nowhere to sit, which is why they wrapped below every row.
    expect(select.contains(remedy as Node)).toBe(false);
  });

  test('each group renders exactly one header, and only later ones carry the rule', () => {
    renderPicker();

    const labels = Array.from(
      document.querySelectorAll('.new-chat-modal__group-label'),
    );
    expect(labels.map((label) => label.textContent?.trim())).toEqual([
      'OpenCode',
      'Global',
    ]);
    const divided = 'new-chat-modal__group-label--divided';
    // The hairline separates groups, so the first header must not draw one.
    expect(labels[0]?.className.includes(divided)).toBe(false);
    expect(labels[1]?.className.includes(divided)).toBe(true);
  });
});
