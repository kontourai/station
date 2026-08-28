/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AgentEditorForm } from '../views/AgentEditorForm';
import type { AgentFormData } from '../views/agent-editor/types';

let agentConnections: any[] = [];
const modelConnections: any[] = [];

vi.mock('@kontourai/station-sdk', () => ({
  useAgentConnectionsQuery: () => ({ data: agentConnections }),
  useModelConnectionsQuery: () => ({ data: modelConnections }),
  useProjectsQuery: () => ({ data: [] }),
  useCredentialRecoveryQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock('../components/icons/AgentIcon', () => ({
  AgentIcon: () => <div>icon</div>,
}));

vi.mock('../components/ModelSelector', () => ({
  ModelSelector: () => <div>model-selector</div>,
}));

function createForm(overrides: Partial<AgentFormData> = {}): AgentFormData {
  return {
    slug: 'agent-one',
    name: 'Agent One',
    description: '',
    prompt: '',
    modelId: '',
    region: '',
    guardrails: null,
    maxSteps: '',
    tools: { mcpServers: [], available: [], autoApprove: [] },
    execution: {
      agentConnectionId: 'bedrock-runtime',
      modelConnectionId: '',
      runtimeOptions: {},
    },
    icon: '',
    skills: [],
    project: '',
    ...overrides,
  };
}

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    form: createForm(),
    setForm: vi.fn(),
    isCreating: false,
    locked: false,
    isPlugin: false,
    isLocked: false,
    validationErrors: {},
    availableTools: [],
    availableSkills: [],
    integrationTools: {},
    appConfig: {},
    enrich: vi.fn(),
    isEnriching: false,
    onNavigate: vi.fn(),
    onOpenAddModal: vi.fn(),
    agentConnections,
    // §3.2's engine answer is a prop now; a test that does not care about the
    // engine branch states the one its fixture's binding implies.
    engineKind: 'cli' as const,
    onEngineKindChange: vi.fn(),
    stationConnectionId: '',
    promptIsRequired: false,
    ...overrides,
  };
}

function tabButton(name: string) {
  return screen.getByRole('heading', { name });
}

describe('AgentEditorForm', () => {
  test('renders an existing slug inline with Name without a separate slug row', () => {
    render(<AgentEditorForm {...baseProps()} />);

    expect(screen.getByText('· agent-one')).toBeTruthy();
    expect(screen.queryByText('slug: agent-one')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Slug' })).toBeNull();
  });

  test('codex-bound agent with authored skills shows the Skills tab in a read-only validation state naming the engine', () => {
    agentConnections = [
      {
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex',
        name: 'Codex',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { executionClass: 'connected' },
        status: 'ready',
      },
    ];
    const form = createForm({
      execution: {
        agentConnectionId: 'codex-runtime',
        modelConnectionId: '',
        runtimeOptions: {},
      },
      skills: ['writing'],
    });

    render(<AgentEditorForm {...baseProps({ form, agentConnections })} />);

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain(
      "Codex can't receive skills from Station",
    );
  });

  test('codex-bound agent with nothing authored hides Prompt/Skills/Commands tabs, but shows Tools (station#1195: toolServers is now deliverable)', () => {
    agentConnections = [
      {
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex',
        name: 'Codex',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { executionClass: 'connected' },
        status: 'ready',
      },
    ];
    const form = createForm({
      execution: {
        agentConnectionId: 'codex-runtime',
        modelConnectionId: '',
        runtimeOptions: {},
      },
    });

    render(<AgentEditorForm {...baseProps({ form, agentConnections })} />);

    expect(screen.queryByRole('button', { name: 'Prompt' })).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Skills and tools' }),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Commands' })).toBeNull();
    expect(tabButton('Basics')).toBeTruthy();
    expect(tabButton('Engine')).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Engine connection' }),
    ).toBeNull();
    // archive#1195: codex's toolServers cell flipped from unsupported to
    // session/wire, so the Tools tab is always shown for a codex-bound
    // agent now (deliverable, per deriveAgentEditorTabs's rule), even with
    // nothing authored yet — the same rule that already keeps Claude's
    // Tools tab always visible.
    expect(tabButton('Skills and tools')).toBeTruthy();
  });

  test('codex-bound agent exposes authored undeliverable commands read-only with catalog guidance', () => {
    agentConnections = [
      {
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex',
        name: 'Codex',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { executionClass: 'connected' },
        status: 'ready',
      },
    ];
    const form = createForm({
      execution: {
        agentConnectionId: 'codex-runtime',
        modelConnectionId: '',
        runtimeOptions: {},
      },
    });
    const onNavigate = vi.fn();

    render(
      <AgentEditorForm
        {...baseProps({
          form,
          agentConnections,
          onNavigate,
          authoredCommands: {
            review: {
              name: 'release-review',
              description: 'Review a release',
              prompt: 'Inspect the release evidence.',
            },
          },
        })}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      "Codex can't run Station-defined slash commands",
    );
    expect(screen.getByText('/release-review')).toBeTruthy();
    expect(screen.getByText('Inspect the release evidence.')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Browse command catalog' }),
    );
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'guidance',
      tab: 'commands',
    });
  });

  test('station-deliverable commands remain catalog-owned with no editor tab', () => {
    agentConnections = [];
    render(
      <AgentEditorForm
        {...baseProps({
          form: createForm({
            execution: {
              agentConnectionId: '',
              modelConnectionId: '',
              runtimeOptions: {},
            },
          }),
          authoredCommands: {
            review: { name: 'review', prompt: 'Review it.' },
          },
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Commands' })).toBeNull();
  });

  test('Basic renders denials for an external engine separately from the Agent-configured ones', () => {
    agentConnections = [
      {
        id: 'codex-runtime',
        kind: 'agent',
        type: 'codex',
        name: 'Codex',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { executionClass: 'connected' },
        status: 'ready',
      },
    ];
    render(
      <AgentEditorForm
        {...baseProps({
          form: createForm({
            delegation: { blockedTools: ['filesystem_delete_*'] },
            execution: {
              agentConnectionId: 'codex-runtime',
              modelConnectionId: '',
              runtimeOptions: {},
            },
          }),
          agentConnections,
        })}
      />,
    );

    expect(screen.getByText('Built-in denials')).toBeTruthy();
    expect(screen.getByText('Operator-configured denials')).toBeTruthy();
    expect(screen.getByText('station-control_send_message')).toBeTruthy();
    expect(screen.getByText('filesystem_delete_*')).toBeTruthy();
    expect(
      screen.getByText(
        /Refuses a delegated child from sending messages through Station control\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Refuses a delegated child from using tools matching 'filesystem_delete_\*'/,
      ),
    ).toBeTruthy();
  });

  test('claude-bound agent keeps Skills editable and shows the engine-default hint when the connection provides skills', () => {
    agentConnections = [
      {
        id: 'claude-runtime',
        kind: 'agent',
        type: 'claude',
        name: 'Claude',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { executionClass: 'connected', provideSkills: ['a', 'b'] },
        status: 'ready',
      },
    ];
    const form = createForm({
      execution: {
        agentConnectionId: 'claude-runtime',
        modelConnectionId: '',
        runtimeOptions: {},
      },
    });

    render(<AgentEditorForm {...baseProps({ form, agentConnections })} />);

    expect(screen.queryByRole('status')).toBeNull();
    expect(
      screen.getByText(
        "This engine connection's default provides 2 skill(s) when the agent doesn't set its own.",
      ),
    ).toBeTruthy();
  });

  // DESIGN.md §3.2 Y2 — nothing on a CLI agent's page may contradict the
  // engine it runs on. The shipped defect was a "Station needs a ready Model
  // connection" banner rendered above a card reading "Claude Code — Ready",
  // and it was reachable because the banner's condition asked about STATION's
  // readiness on every agent's form. §3.3 is now the only place a model
  // connection is named at all, and it renders for one engine.
  test('a CLI-engine agent’s page never mentions a model connection', () => {
    agentConnections = [
      {
        id: 'claude-runtime',
        kind: 'agent',
        type: 'claude',
        name: 'Claude Code',
        enabled: true,
        capabilities: ['agent-runtime'],
        config: { executionClass: 'connected' },
        status: 'ready',
      },
    ];
    const { container } = render(
      <AgentEditorForm
        {...baseProps({
          form: createForm({
            execution: {
              agentConnectionId: 'claude-runtime',
              modelConnectionId: '',
              runtimeOptions: {},
            },
          }),
          agentConnections,
          engineKind: 'cli' as const,
        })}
      />,
    );
    expect(screen.queryByRole('heading', { name: 'Model' })).toBeNull();
    expect(container.querySelector('#ae-model-connection')).toBeNull();
    // The engine cards name the two CHOICES; no other text on the page may
    // assert anything about a model connection for this agent.
    const assertions = Array.from(
      container.querySelectorAll('.agent-editor__capability-banner'),
    ).map((node) => node.textContent ?? '');
    expect(assertions.join(' ')).not.toMatch(/model connection/i);
  });

  // The positive control for the pin above: the notice is not deleted, it is
  // scoped. An engine that genuinely needs a model connection still says so.
  test('a Station-engine agent with no ready model connection says so', () => {
    agentConnections = [];
    render(
      <AgentEditorForm
        {...baseProps({
          form: createForm({
            execution: {
              agentConnectionId: '',
              modelConnectionId: '',
              runtimeOptions: {},
            },
          }),
          agentConnections,
          engineKind: 'model' as const,
        })}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Model' })).toBeTruthy();
    expect(
      screen.getByText(/Station needs a ready model connection/i),
    ).toBeTruthy();
  });
});
