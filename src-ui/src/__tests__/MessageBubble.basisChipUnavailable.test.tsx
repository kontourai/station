/**
 * @vitest-environment jsdom
 *
 * The Basis chip loads in its own chunk. A chunk that fails to load (a tab
 * left open across a deploy requests a filename that no longer exists) used
 * to drop the answer's Basis entry without a trace. It now leaves a visible
 * chip that retries the load.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../types';

const chunk = vi.hoisted(() => ({ failures: 1 }));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children?: string }) => <div>{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => null }));
vi.mock('../components/chat/message-bubble/MessageRating', () => ({
  MessageRating: () => null,
}));
vi.mock('../components/icons/UserIcon', () => ({ UserIcon: () => null }));
vi.mock('../components/chat/ConnectedAnswerBasisAffordance', () => {
  if (chunk.failures > 0) {
    chunk.failures -= 1;
    throw new Error('Failed to fetch dynamically imported module');
  }
  // Shaped like the real chip: visible "Basis", per-answer accessible name.
  return {
    ConnectedAnswerBasisAffordance: ({ label }: { label: string }) => (
      <button type="button" className="answer-basis-chip" aria-label={label}>
        Basis
      </button>
    ),
  };
});

const { MessageBubble } = await import('../components/chat/MessageBubble');

const SESSION = 'agent:1792425046978';
const CHIP = 'Basis for the answer “Here is the answer.”';

describe('MessageBubble Basis chip when its chunk fails to load', () => {
  it('stays visible as a retry, and retrying restores the chip', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MessageBubble
          msg={
            {
              role: 'assistant',
              content: 'Here is the answer.',
              sessionId: SESSION,
              turnId: 'turn-7',
              answerEligible: true,
              provenance: {
                envelopeVersion: 1,
                sessionId: SESSION,
                turnId: 'turn-7',
                outcome: 'completed',
                observedAt: '2026-08-01T00:00:00.000Z',
                engine: {
                  state: 'observed',
                  value: { provider: 'codex' },
                  observedFrom: [{ eventId: 'e1', method: 'turn.completed' }],
                },
                requestedModel: {
                  state: 'unavailable',
                  reason: 'not-reported-by-engine',
                },
                reportedModel: {
                  state: 'unavailable',
                  reason: 'not-reported-by-engine',
                },
                tools: {
                  state: 'unavailable',
                  reason: 'not-reported-by-engine',
                },
                usage: {
                  state: 'unavailable',
                  reason: 'not-reported-by-engine',
                },
                routingReceipt: {
                  state: 'unavailable',
                  reason: 'not-captured-by-station',
                },
                sources: {
                  state: 'unavailable',
                  reason: 'not-captured-by-station',
                },
                trustReport: {
                  state: 'unavailable',
                  reason: 'not-captured-by-station',
                },
              },
            } as ChatMessage
          }
          idx={0}
          activeSession={{ id: SESSION, agentSlug: 'agent', messageCount: 1 }}
          agents={[]}
          chatFontSize={14}
          showReasoning={false}
          showToolDetails={false}
          onCopy={() => {}}
        />
      </QueryClientProvider>,
    );

    const retry = await screen.findByRole('button', {
      name: 'Basis didn’t load · Retry for the answer “Here is the answer.”',
    });
    expect(retry.textContent).toBe('Basis didn’t load · Retry');
    expect(retry.closest('.turn-footer__bar')).not.toBeNull();
    expect(retry.closest('.turn-footer__actions')).toBeNull();
    expect(screen.queryByRole('button', { name: CHIP })).toBeNull();

    fireEvent.click(retry);
    expect(await screen.findByRole('button', { name: CHIP })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /^Basis didn’t load/ }),
    ).toBeNull();
  });
});
