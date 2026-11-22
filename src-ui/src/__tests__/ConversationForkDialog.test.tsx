// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationForkDialog } from '../components/chat-dock/ConversationForkDialog';
import type { AgentData } from '../contexts/AgentsContext';

const useNewChatSelectionModel = vi.fn();
vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: (...args: unknown[]) =>
    useNewChatSelectionModel(...args),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

const claude = {
  slug: 'claude',
  name: 'Claude',
  available: true,
  engineDisplayName: 'Claude Code',
  engineId: 'claude',
  execution: { agentConnectionId: 'claude' },
};
const codex = {
  slug: 'codex',
  name: 'Codex reviewer',
  available: true,
  engineDisplayName: 'Codex',
  engineId: 'codex',
  execution: { agentConnectionId: 'codex' },
};
const offline = {
  slug: 'offline',
  name: 'Offline Agent',
  available: false,
  execution: { agentConnectionId: 'offline' },
};
const MODELS: Record<string, { id: string; name: string; providerId?: string }[]> = {
  claude: [
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'opus', name: 'Opus' },
  ],
  codex: [
    { id: 'gpt-5', name: 'GPT-5', providerId: 'openai' },
    { id: 'gpt-6', name: 'GPT-6', providerId: 'openai' },
  ],
};

beforeEach(() => {
  useNewChatSelectionModel.mockReturnValue({
    agentConnections: ['claude', 'codex'].map((id) => ({
      id,
      kind: 'agent',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
    })),
    selectedProjectConfig: { agents: ['claude', 'codex', 'offline'] },
    modelsForAgent: (agent: AgentData) => MODELS[agent.slug] ?? [],
    defaultEffectiveModelForAgent: (agent: AgentData) => ({
      id: MODELS[agent.slug]?.[0]?.id,
      source: 'agent default',
    }),
    modelsLoading: false,
    modelConnections: [],
  });
});

function renderFork(
  props: Partial<React.ComponentProps<typeof ConversationForkDialog>> = {},
) {
  const onFork = vi.fn();
  const onClose = vi.fn();
  render(
    <ConversationForkDialog
      title="Fork from here"
      sourceAgentId="codex"
      sourceModel="gpt-6"
      projectSlug="project-a"
      agents={[claude, codex, offline] as unknown as AgentData[]}
      projects={[{ slug: 'project-a', name: 'Project A' }] as never}
      pending={false}
      error={null}
      onFork={onFork}
      onClose={onClose}
      {...props}
    />,
  );
  return { onFork, onClose };
}

const radio = (name: string) =>
  screen.getByRole('radio', { name: new RegExp(name) }) as HTMLInputElement;

describe('ConversationForkDialog', () => {
  test('lists only chat-ready Agents, source first and preselected on its turn model', () => {
    const { onFork } = renderFork();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((input) => input.value)).toEqual(['codex', 'claude']);
    expect(radio('Codex reviewer').checked).toBe(true);
    expect(
      screen.getByRole('button', { name: /^Model GPT-6$/ }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Fork with Codex reviewer' }),
    );
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(onFork.mock.calls[0][0].slug).toBe('codex');
    expect(onFork.mock.calls[0][1]).toEqual({
      modelOverride: 'gpt-6',
      providerId: 'openai',
      providerType: undefined,
    });
  });

  test('forks to another Agent on that Agent’s default model', () => {
    const { onFork } = renderFork();
    fireEvent.click(radio('Claude'));
    expect(screen.getByRole('button', { name: /^Model Sonnet$/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fork with Claude' }));
    expect(onFork.mock.calls[0][0].slug).toBe('claude');
    expect(onFork.mock.calls[0][1].modelOverride).toBe('sonnet');
  });

  test('a source model the Agent no longer offers settles on its default', () => {
    renderFork({ sourceModel: 'retired-model' });
    expect(screen.getByRole('button', { name: /^Model GPT-5$/ })).toBeTruthy();
  });

  test('pending blocks a second fork but Cancel stays available to abort it', () => {
    const { onFork, onClose } = renderFork({ pending: true });
    const submit = screen.getByRole('button', {
      name: 'Forking…',
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onFork).not.toHaveBeenCalled();
    const cancel = screen.getByRole('button', {
      name: 'Cancel fork',
    }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(false);
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a failure stays visible and the same choice can retry', () => {
    const { onFork } = renderFork({ error: 'This chat is too long to fork.' });
    expect(screen.getByRole('alert').textContent).toBe(
      'This chat is too long to fork.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Fork with Codex reviewer' }),
    );
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  test('says what a fork is in one line, the rest behind Details', () => {
    renderFork();
    expect(
      screen.getByText('Opens a new chat from here. This chat stays as it is.'),
    ).toBeTruthy();
    expect(screen.queryByText(/Messages up to this point/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(screen.getByText(/Messages up to this point/)).toBeTruthy();
  });
});
