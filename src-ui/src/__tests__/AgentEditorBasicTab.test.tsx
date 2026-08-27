/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AgentEditorBasicTab } from '../views/agent-editor/AgentEditorBasicTab';
import type { AgentFormData } from '../views/agent-editor/types';

let projects: any[] = [];

vi.mock('@kontourai/station-sdk', () => ({
  useProjectsQuery: () => ({
    data: projects,
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
    prompt: 'You are helpful.',
    modelId: '',
    region: '',
    guardrails: null,
    maxSteps: '',
    tools: { mcpServers: [], available: [], autoApprove: [] },
    execution: {
      agentConnectionId: 'bedrock-runtime',
      modelConnectionId: 'bedrock-default',
      runtimeOptions: { legacy: true },
    },
    icon: '',
    skills: [],
    project: '',
    ...overrides,
  };
}

const noop = () => {};

function baseProps(
  overrides: Partial<Parameters<typeof AgentEditorBasicTab>[0]> = {},
) {
  return {
    form: createForm(),
    setForm: vi.fn(),
    isCreating: true,
    locked: false,
    validationErrors: {},
    appConfig: {},
    enrich: vi.fn(),
    isEnriching: false,
    onSwitchTab: noop,
    ...overrides,
  };
}

describe('AgentEditorBasicTab', () => {
  /**
   * station#3721 moved the engine question out of this tab: it renders
   * identity fields and project ownership only, and the Engine `<select>`
   * these tests drove was replaced by AgentEditorEngineSelection's radio
   * cards. Seven tests went on asserting `<option>` markup that no longer
   * exists (a pre-existing main red). Their intent now lives with the
   * affordance that replaced it, none of it dropped:
   * - the engine list, its non-ready entry and that entry's status sentence,
   *   the engine switch preserving authored prompt/skills/tools, and a
   *   vanished binding never being remapped onto Station →
   *   `agent-editor-engine-selection.test.tsx`, "the CLI list carries the
   *   retired engine picker's outstanding properties (#3721)".
   * - "Station is not selected while its managed connection needs setup"
   *   became a property of `defaultSelectableManagedRuntimeConnection`
   *   (`utils/execution.ts`) and is asserted by
   *   `agent-create-readiness-gate.test.tsx`.
   * - the Station model-connection notice, both polarities →
   *   `AgentEditorForm.test.tsx` ("a CLI-engine agent's page never mentions
   *   a model connection" / "a Station-engine agent with no ready model
   *   connection says so").
   */
  describe('project ownership (station#1004, unification slice 7)', () => {
    test('renders the Project select with a global default', () => {
      projects = [
        { slug: 'demo-project', name: 'Demo Project' },
        { slug: 'other-project', name: 'Other Project' },
      ];

      render(<AgentEditorBasicTab {...baseProps({ form: createForm() })} />);

      const select = screen.getByRole('combobox', {
        name: 'Project',
      }) as HTMLSelectElement;
      expect(select.value).toBe('');
      const options = Array.from(
        select.querySelectorAll('option'),
      ) as HTMLOptionElement[];
      expect(options.map((option) => option.value)).toEqual([
        '',
        'demo-project',
        'other-project',
      ]);
      expect(options[0].textContent).toBe(
        'Global (available to every project)',
      );
      expect(screen.queryByText(/no longer exists/)).toBeNull();
    });

    test('shows the missing-project state for an orphaned owner and keeps the value selectable', () => {
      projects = [{ slug: 'demo-project', name: 'Demo Project' }];

      const form = createForm({ project: 'ghost-project' });
      render(<AgentEditorBasicTab {...baseProps({ form })} />);

      const select = screen.getByRole('combobox', {
        name: 'Project',
      }) as HTMLSelectElement;
      expect(select.value).toBe('ghost-project');
      const options = Array.from(
        select.querySelectorAll('option'),
      ) as HTMLOptionElement[];
      expect(options.map((option) => option.value)).toEqual([
        '',
        'demo-project',
        'ghost-project',
      ]);
      expect(
        options.find((option) => option.value === 'ghost-project')?.textContent,
      ).toContain('missing');

      // Authored content stays visible and the banner names the missing
      // project verbatim — the same message the API/list surfaces use.
      expect(
        screen.getByText(
          "This agent's owning project 'ghost-project' no longer exists. Assign it to an existing project or make it global.",
        ),
      ).toBeTruthy();
    });
  });
});
