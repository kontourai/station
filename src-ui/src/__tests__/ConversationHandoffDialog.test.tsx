// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationHandoffDialog } from '../components/chat-dock/ConversationHandoffDialog';

const handoffExecutionMessage = vi.fn();
const getConversationHandoffStatus = vi.fn();
const useNewChatSelectionModel = vi.fn();
const fenceConversationHandoff = vi.fn(
  async (_input: unknown, effect: () => Promise<unknown>) => ({
    status: 'completed',
    value: await effect(),
  }),
);

vi.mock('@kontourai/station-sdk/client', () => ({
  handoffExecutionMessage: (...args: unknown[]) =>
    handoffExecutionMessage(...args),
  getConversationHandoffStatus: (...args: unknown[]) =>
    getConversationHandoffStatus(...args),
}));
vi.mock('../lib/outboundQueue', () => ({
  outboundDispatch: {
    fenceConversationHandoff: (...args: unknown[]) =>
      fenceConversationHandoff(...(args as [unknown, () => Promise<unknown>])),
  },
}));
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
const unavailable = {
  slug: 'offline',
  name: 'Offline Agent',
  available: false,
  execution: { agentConnectionId: 'offline' },
};
const connections = ['claude', 'codex'].map((id) => ({
  id,
  kind: 'agent',
  enabled: true,
  status: 'ready',
  capabilities: ['agent-runtime'],
}));

function receipt(target = codex) {
  return {
    handoff: {
      predecessorSessionId: 'session-a',
      sessionId: 'session-b',
      currentSessionId: 'session-b',
      outcome: 'created',
      target: {
        agentId: target.slug,
        engine: { kind: 'connection', connectionId: target.slug },
        modelId: 'gpt-5',
      },
      carried: [
        'authorizedTranscript',
        'ownerTenantWorkspace',
        'targetAgentModel',
      ],
      reset: ['providerNativeCursor', 'toolState'],
    },
  };
}

function acceptedStatus() {
  const handoff = receipt().handoff;
  return {
    conversationId: 'conversation-a',
    currentSessionId: handoff.currentSessionId,
    status: 'accepted',
    marker: {
      predecessorSessionId: handoff.predecessorSessionId,
      sessionId: handoff.sessionId,
      idempotencyKey: 'handoff-key',
      targetAgentId: 'codex',
      targetConnectionId: 'codex',
      targetModelId: 'gpt-5',
      createdAt: '2026-08-24T00:00:00.000Z',
      carried: handoff.carried,
      reset: handoff.reset,
    },
  };
}

function renderDialog(
  currentAgentId = 'claude',
  apiBase = 'http://station.test',
  agents = [claude, codex, unavailable],
  conversationId = 'conversation-a',
) {
  const onAccepted = vi.fn();
  const onClose = vi.fn();
  const onDispatchStarted = vi.fn();
  const onDefiniteFailure = vi.fn();
  const view = render(
    <ConversationHandoffDialog
      apiBase={apiBase}
      conversationId={conversationId}
      sessionId="session-a"
      currentAgentId={currentAgentId}
      projectSlug="project-a"
      agents={agents as never}
      projects={[{ slug: 'project-a', name: 'Project A' }] as never}
      initialMessage="follow up"
      attachments={[]}
      onAccepted={onAccepted}
      onDispatchStarted={onDispatchStarted}
      onDefiniteFailure={onDefiniteFailure}
      onClose={onClose}
    />,
  );
  return {
    ...view,
    onAccepted,
    onClose,
    onDispatchStarted,
    onDefiniteFailure,
  };
}

describe('ConversationHandoffDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    fenceConversationHandoff.mockImplementation(
      async (_input: unknown, effect: () => Promise<unknown>) => ({
        status: 'completed',
        value: await effect(),
      }),
    );
    useNewChatSelectionModel.mockReturnValue({
      agentConnections: connections,
      selectedProjectConfig: { agents: ['claude', 'codex', 'offline'] },
      modelsForAgent: () => [{ id: 'gpt-5', name: 'GPT-5' }],
      defaultEffectiveModelForAgent: () => ({
        id: 'gpt-5',
        source: 'agent default',
      }),
    });
  });

  test('announces equivalent Agent and engine identity once', () => {
    const equivalent = { ...claude, name: 'Claude Code' };
    renderDialog('codex', undefined, [codex, equivalent]);
    const radio = screen.getByRole('radio', { name: 'Claude Code' });
    expect(radio).toBeTruthy();
  });

  test('keeps a distinct Agent and engine identity in the radio name', () => {
    renderDialog('claude');
    expect(
      screen.getByRole('radio', { name: /Codex reviewer.*Codex/ }),
    ).toBeTruthy();
  });

  test('cancel is read-only and unavailable Agents are absent', () => {
    const { onClose } = renderDialog();
    expect(screen.queryByText('Offline Agent')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel Agent handoff' }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(handoffExecutionMessage).not.toHaveBeenCalled();
  });

  test.each([
    ['claude', 'Codex reviewer'],
    ['codex', 'Claude'],
  ])(
    'hands %s to the other ready Agent inside the immutable Environment',
    async (current, targetName) => {
      const target = current === 'claude' ? codex : claude;
      handoffExecutionMessage.mockResolvedValueOnce(receipt(target));
      const { onAccepted } = renderDialog(current);
      fireEvent.click(
        screen.getByRole('radio', { name: new RegExp(targetName) }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: `Continue with ${targetName}` }),
      );

      await waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
      const [, conversationId, input] = handoffExecutionMessage.mock.calls[0];
      expect(conversationId).toBe('conversation-a');
      expect(input.target).toMatchObject({
        environment: { kind: 'current' },
        workspace: { kind: 'project', projectSlug: 'project-a' },
        agent: target.slug,
        model: { override: 'gpt-5' },
      });
      expect(input.message).toBe('follow up');
    },
  );

  test('response loss stays indeterminate and retries with the same idempotency key', async () => {
    handoffExecutionMessage
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(receipt());
    const { onAccepted } = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('final response'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry safely' }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
    expect(handoffExecutionMessage.mock.calls[0][2].clientTurnId).toMatch(
      /^handoff:/,
    );
    expect(handoffExecutionMessage).toHaveBeenCalledTimes(2);
    expect(handoffExecutionMessage.mock.calls[0][2].idempotencyKey).toBe(
      handoffExecutionMessage.mock.calls[1][2].idempotencyKey,
    );
  });

  test('always targets current on a production-shaped Environment id', async () => {
    handoffExecutionMessage.mockResolvedValueOnce(receipt());
    renderDialog(
      'claude',
      'http://station.test',
      [claude, codex, unavailable],
      '019d2f07-7a81-7d8f-a8fd-d083b27f84f5',
    );
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );

    await waitFor(() => expect(handoffExecutionMessage).toHaveBeenCalledOnce());
    expect(handoffExecutionMessage.mock.calls[0][2].target.environment).toEqual(
      {
        kind: 'current',
      },
    );
  });

  test('reload restores the exact pending effect and observes only its current marker', async () => {
    handoffExecutionMessage.mockRejectedValueOnce(
      new TypeError('response lost'),
    );
    const first = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('final response'),
    );
    const key = handoffExecutionMessage.mock.calls[0][2].idempotencyKey;
    first.unmount();

    getConversationHandoffStatus.mockResolvedValueOnce(acceptedStatus());
    const restored = renderDialog();
    expect(
      (
        screen.getByRole('radio', {
          name: /Codex reviewer/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByLabelText(
          'First message to Codex reviewer',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe('follow up');
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await waitFor(() => expect(restored.onAccepted).toHaveBeenCalledOnce());
    expect(getConversationHandoffStatus.mock.calls[0][2]).toBe(key);
  });

  test('pending recovery is isolated by Station origin', async () => {
    handoffExecutionMessage.mockRejectedValueOnce(
      new TypeError('response lost'),
    );
    const first = renderDialog('claude', 'http://nightly.station.test');
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('final response'),
    );
    first.unmount();

    renderDialog('claude', 'http://stable.station.test');
    expect(
      (
        screen.getByRole('radio', {
          name: /Codex reviewer/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByRole('button', { name: 'Check status' })).toBeNull();
  });

  test('browser cleanup refusal cannot overturn an accepted server receipt', async () => {
    handoffExecutionMessage.mockResolvedValueOnce(receipt());
    const remove = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementationOnce(() => {
        throw new DOMException('denied');
      });
    const { onAccepted } = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );

    await waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
    remove.mockRestore();
  });

  test('a coded numeric 409 without a receipt stays indeterminate', async () => {
    handoffExecutionMessage.mockRejectedValueOnce(
      Object.assign(new Error('marker missing'), {
        status: 409,
        code: 'foreground_message_indeterminate',
        outcome: 'indeterminate',
      }),
    );
    const { onDefiniteFailure } = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('final response'),
    );
    expect(onDefiniteFailure).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Retry safely' })).toBeTruthy();
  });

  test('blocks before dispatch when the durable outbound authority owns a row', async () => {
    fenceConversationHandoff.mockImplementationOnce(
      async () => ({ status: 'blocked', count: 1 }) as never,
    );
    const { onDispatchStarted } = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'queued or offline messages',
      ),
    );
    expect(handoffExecutionMessage).not.toHaveBeenCalled();
    expect(onDispatchStarted).not.toHaveBeenCalled();
  });

  test('restored deleted target can be closed safely or observed by exact retry', async () => {
    handoffExecutionMessage.mockRejectedValueOnce(
      new TypeError('response lost'),
    );
    const first = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );
    await waitFor(() => screen.getByRole('button', { name: 'Check status' }));
    first.unmount();

    getConversationHandoffStatus.mockResolvedValueOnce(acceptedStatus());
    const restored = renderDialog('claude', 'http://station.test', [
      claude,
    ] as (typeof claude)[]);
    expect(
      (
        screen.getByRole('button', {
          name: 'Cancel Agent handoff',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      screen.getByLabelText(/First message to deleted Agent/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));

    await waitFor(() => expect(restored.onAccepted).toHaveBeenCalledOnce());
    expect(restored.onAccepted.mock.calls[0][0].target).toBeUndefined();
    expect(restored.onAccepted.mock.calls[0][0].targetId).toBe('codex');
  });

  test('a failed provider turn still applies the Agent switch once and clears pending retry', async () => {
    handoffExecutionMessage.mockRejectedValueOnce(
      new TypeError('response lost'),
    );
    const view = renderDialog();
    fireEvent.click(screen.getByRole('radio', { name: /Codex reviewer/ }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Codex reviewer' }),
    );
    await waitFor(() => screen.getByRole('button', { name: 'Check status' }));
    getConversationHandoffStatus.mockResolvedValueOnce({
      ...acceptedStatus(),
      status: 'failed',
      providerTurnId: 'failed-provider-turn',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Check status' }));
    await waitFor(() => expect(view.onAccepted).toHaveBeenCalledOnce());
    expect(view.onAccepted.mock.calls[0][0].receipt.currentSessionId).toBe(
      'session-b',
    );
    expect(
      sessionStorage.getItem(
        'station.conversation-handoff.pending.v1:http%3A%2F%2Fstation.test:conversation-a',
      ),
    ).toBeNull();
  });
});
