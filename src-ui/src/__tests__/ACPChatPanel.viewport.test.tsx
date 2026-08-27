// @vitest-environment jsdom

import { render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: { id: 'test', name: 'Test' } }),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useAgentConnectionsQuery: () => ({ data: [] }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => [{ slug: 'codex', name: 'Codex' }],
}));
// station#1424: ACPChatPanel now reads the local operator identity for the
// "Managed by …" row chip — not under test here (ChatMessageList itself is
// mocked below), so a fixed resolved user.
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { alias: 'operator' } }),
}));
const acpFixture = {
  id: 'acp-session',
  agentSlug: 'codex',
  agentName: 'Codex',
  title: 'Engine fixture',
  messages: [],
  input: '',
  attachments: [],
  queuedMessages: [],
  inputHistory: [],
  status: 'idle',
};

vi.mock('../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({ updateChat: vi.fn() }),
  useActiveChatState: () => acpFixture,
  useActiveChatSelector: (
    _sessionId: string,
    selector: (state: typeof acpFixture | null) => unknown,
  ) => selector(acpFixture),
}));
vi.mock('../hooks/useActiveChatSessions', () => ({
  useCreateChatSession: () => () => 'acp-session',
}));
vi.mock('../hooks/useChatInput', () => ({
  useChatInput: () => ({}),
}));
vi.mock('../components/chat/ChatInputArea', () => ({
  ChatInputArea: () => <div data-testid="acp-composer" />,
}));
vi.mock('../components/chat/ChatMessageList', () => ({
  ChatMessageList: () => <div data-testid="acp-messages" />,
}));

import { ACPChatPanel } from '../components/acp-connections/ACPChatPanel';

describe('ACP chat viewport boundary', () => {
  test('rendered coding boundary consumes shared height and leaves top to its ancestor', async () => {
    class FakeViewport extends EventTarget {
      height = 700;
      offsetTop = 0;
    }
    const viewport = new FakeViewport();
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
    const { container, getByTestId } = render(
      <div
        data-testid="coding-ancestor"
        style={{ position: 'relative', top: 24 }}
      >
        <ACPChatPanel projectSlug="station" agentSlug="codex" tabId="tab-1" />
      </div>,
    );
    viewport.height = 493;
    viewport.offsetTop = 17;
    viewport.dispatchEvent(new Event('resize'));
    viewport.dispatchEvent(new Event('scroll'));

    const boundary = container.querySelector<HTMLElement>('.acp-chat-panel')!;
    await waitFor(() => {
      expect(
        boundary.style.getPropertyValue('--chat-visual-viewport-height'),
      ).toBe('493px');
      expect(
        boundary.style.getPropertyValue('--chat-visual-viewport-top'),
      ).toBe('17px');
      expect(
        boundary.style.getPropertyValue('--chat-visual-viewport-bottom'),
      ).toBe(`${window.innerHeight - 510}px`);
    });
    expect(boundary.style.maxHeight).toBe('var(--chat-visual-viewport-height)');
    expect(boundary.style.top).toBe('');
    expect(
      getByTestId('coding-ancestor').contains(getByTestId('acp-composer')),
    ).toBe(true);
    expect(
      getByTestId('coding-ancestor').contains(getByTestId('acp-messages')),
    ).toBe(true);
  });
});
