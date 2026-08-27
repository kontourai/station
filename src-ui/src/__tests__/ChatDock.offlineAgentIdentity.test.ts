/**
 * @vitest-environment jsdom
 */

import { agentId } from '@kontourai/station-contracts/agent-identity';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, test, vi } from 'vitest';

const { discard } = vi.hoisted(() => ({
  discard: vi.fn(),
}));
vi.mock('../lib/outboundQueue', () => ({ outboundDispatch: { discard } }));

import { OutboundQueuedMessages } from '../components/chat/OutboundQueuedMessages';
import {
  agentIdentityFromSession,
  startNewChatWithMessage,
} from '../components/chat-dock/ChatDock';

describe('ChatDock offline queued-turn identity (station#2600)', () => {
  test('uses only the active session identity when the server-loaded agent list is empty', () => {
    expect(
      agentIdentityFromSession({
        agentSlug: agentId('codex'),
        agentName: 'Codex',
      }),
    ).toEqual({ slug: agentId('codex'), name: 'Codex' });
  });

  test('a real failed queue-row tap creates, seeds, and discards from its own offline session identity', async () => {
    const openChatForAgent = vi.fn();
    render(
      createElement(OutboundQueuedMessages, {
        sessionId: 'offline-session',
        turns: [
          {
            clientTurnId: 'queued-turn',
            content: 'continue offline work',
            status: 'failed',
            lastError: 'Workspace refusal: Station is unreachable',
          },
        ],
        onError: vi.fn(),
        onRetry: vi.fn(),
        onStartNewChat: (message, attachments, migratedTurnId) =>
          startNewChatWithMessage({
            initialMessage: message,
            attachments,
            migratedTurnId,
            agents: [],
            activeSession: {
              agentSlug: agentId('codex'),
              agentName: 'Codex',
              projectSlug: 'offline-project',
            } as any,
            openChatForAgent,
          }),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));

    await waitFor(() =>
      expect(openChatForAgent).toHaveBeenCalledWith(
        { slug: agentId('codex'), name: 'Codex' },
        'offline-project',
        undefined,
        'continue offline work',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined, // providerId: offline recovery does not override the binding
        undefined, // providerType
      ),
    );
    await waitFor(() => expect(discard).toHaveBeenCalledWith('queued-turn'));
  });

  test('fails closed when the persisted session itself has no agent identity', () => {
    expect(
      agentIdentityFromSession({
        agentSlug: undefined as any,
        agentName: undefined as any,
      }),
    ).toBeNull();
  });
});
