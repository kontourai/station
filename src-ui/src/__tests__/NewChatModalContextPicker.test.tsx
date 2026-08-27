/**
 * @vitest-environment jsdom
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ContextPickerOptions } from '../components/modals/NewChatModal';
import {
  GLOBAL_CONTEXT,
  type NewChatModalContextOption,
} from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';

// NewChatModal's Enable posts to `/agents/materialize-engine` through this
// SDK mutation; a minimal mock keeps react-query's provider requirement out
// of this render tree.
vi.mock('@kontourai/station-sdk', () => ({
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

const MODEL_AGENT: AgentData = {
  slug: agentId('claude'),
  name: 'Claude Code',
  model: 'claude-sonnet',
  modelOptions: [
    {
      id: 'claude-opus',
      name: 'Claude Opus',
      originalId: 'claude-opus',
      capabilities: {
        supportsEffort: true,
        supportedEffortLevels: ['high'],
      },
    },
    {
      id: 'claude-sonnet',
      name: 'Claude Sonnet',
      originalId: 'claude-sonnet',
      capabilities: {
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
      },
    },
  ],
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
        groups: [{ label: 'External', glyph: 'engine', agents: [MODEL_AGENT] }],
        flatList: [MODEL_AGENT],
        compatibilityMessage: undefined,
      },
      runtimeLoading: false,
      modelsLoading: false,
      modelPickerAgent,
      setModelPickerAgent,
      modelChoices,
      setModelChoices,
      modelsForAgent: (agent: AgentData) => agent.modelOptions ?? [],
      modelChoiceKey: (agent: AgentData) => agent.slug,
      defaultEffectiveModelForAgent: (agent: AgentData) => ({
        id: agent.model,
        source: 'agent default',
      }),
    };
  },
}));

afterEach(cleanup);
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

const OPTIONS: NewChatModalContextOption[] = [
  { value: GLOBAL_CONTEXT, label: 'No workspace', glyph: 'globe' },
  {
    value: 'station',
    label: 'Station',
    icon: '📁',
    workingDirectory: '/Users/brian/dev/station',
  },
  { value: 'no-cwd', label: 'No CWD Project', icon: '📁' },
];

describe('ContextPickerOptions', () => {
  test('renders the filter input and every option once, honoring autoFocusFilter', () => {
    // `autoFocus` is an initial-mount-only DOM behavior, so this compares two
    // independently mounted instances rather than rerendering one in place.
    const { unmount } = render(
      <ContextPickerOptions
        contextSearch=""
        onContextSearchChange={vi.fn()}
        autoFocusFilter={false}
        onEscape={vi.fn()}
        filteredContextOptions={OPTIONS}
        selectedContext={GLOBAL_CONTEXT}
        onSelectContext={vi.fn()}
      />,
    );
    const filter = screen.getByPlaceholderText('Filter...');
    expect(document.activeElement).not.toBe(filter);
    expect(
      screen.getAllByRole('button', { name: /Station|No workspace|No CWD/ }),
    ).toHaveLength(3);
    unmount();

    render(
      <ContextPickerOptions
        contextSearch=""
        onContextSearchChange={vi.fn()}
        autoFocusFilter
        onEscape={vi.fn()}
        filteredContextOptions={OPTIONS}
        selectedContext={GLOBAL_CONTEXT}
        onSelectContext={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByPlaceholderText('Filter...'),
    );
  });

  test('marks the selected option active and badges projects with no working directory', () => {
    render(
      <ContextPickerOptions
        contextSearch=""
        onContextSearchChange={vi.fn()}
        autoFocusFilter={false}
        onEscape={vi.fn()}
        filteredContextOptions={OPTIONS}
        selectedContext="station"
        onSelectContext={vi.fn()}
      />,
    );
    const stationButton = screen.getByRole('button', { name: /Station/ });
    expect(stationButton.className).toContain(
      'new-chat-modal__dropdown-item--active',
    );
    const noCwdButton = screen.getByRole('button', { name: /No CWD Project/ });
    expect(noCwdButton.querySelector('.new-chat-modal__no-cwd-badge')).not.toBe(
      null,
    );
    // The global sentinel never gets the "no cwd" badge even without a
    // working directory.
    const globalButton = screen.getByRole('button', { name: /No workspace/ });
    expect(globalButton.querySelector('.new-chat-modal__no-cwd-badge')).toBe(
      null,
    );
  });

  test('reports the selected value on click and closes on Escape without changing selection', () => {
    const onSelectContext = vi.fn();
    const onEscape = vi.fn();
    const onContextSearchChange = vi.fn();
    render(
      <ContextPickerOptions
        contextSearch="stat"
        onContextSearchChange={onContextSearchChange}
        autoFocusFilter={false}
        onEscape={onEscape}
        filteredContextOptions={[OPTIONS[1]]}
        selectedContext={GLOBAL_CONTEXT}
        onSelectContext={onSelectContext}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Station/ }));
    expect(onSelectContext).toHaveBeenCalledWith('station');

    const filter = screen.getByPlaceholderText('Filter...');
    fireEvent.change(filter, { target: { value: 'station' } });
    expect(onContextSearchChange).toHaveBeenCalledWith('station');

    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledOnce();
    expect(onSelectContext).toHaveBeenCalledOnce();
  });
});
