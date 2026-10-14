import type { Page } from '@playwright/test';
import type { LongSessionEvent } from '../fixtures/long-session';
import { foregroundMessageReceiptEnvelope } from './execution-receipt';
import { seedActiveChats } from './orchestration';
import { mockRuntimeConversation } from './runtime-conversation-fixture';

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

/**
 * A persisted Station-agent conversation whose transcript is a long
 * cursor-paged event window, seeded as the tab's open chat. Shared by the
 * mobile virtualization journey (`mobile-chat-composer.spec.ts`) and the
 * transcript load-stability journey (`transcript-load-stability.spec.ts`).
 *
 * The legacy per-agent messages read is routed to an abort: the transcript
 * must come from the event window, and `messagesRequested()` reports whether
 * anything still asked for it.
 */
export async function mockLongTranscriptConversation(
  page: Page,
  input: {
    threadId: string;
    title: string;
    turns: () => LongSessionEvent[][];
    onWindow?: (url: string) => void;
  },
): Promise<{ messagesRequested: () => boolean }> {
  const { threadId, title } = input;
  let messagesRequested = false;
  await mockRuntimeConversation(page, {
    id: threadId,
    agentSlug: 'station',
    title,
    provider: 'bedrock',
    model: 'model-selected',
    projectSlug: 'default',
    canContinue: true,
    turns: input.turns,
    onWindow: input.onWindow,
  });
  await page.route('**/api/orchestration/chat', (route) =>
    route.fulfill(
      json(
        foregroundMessageReceiptEnvelope({
          conversationId: threadId,
          agent: 'agent:station',
        }),
      ),
    ),
  );
  await page.route(
    `**/agents/station/conversations/${threadId}/messages`,
    (route) => {
      messagesRequested = true;
      return route.abort();
    },
  );
  await page.route(/\/agents\/station\/conversations(?:\?.*)?$/, (route) =>
    route.fulfill(
      json({
        success: true,
        data: [
          {
            id: threadId,
            title,
            agentSlug: 'station',
            updatedAt: '2026-07-19T10:00:00Z',
          },
        ],
      }),
    ),
  );
  await seedActiveChats(page, [
    {
      sessionId: threadId,
      conversationId: threadId,
      agentSlug: 'station',
      projectSlug: 'default',
      projectName: 'Default',
      model: 'model-selected',
      title,
      provider: 'bedrock',
      orchestrationSessionStarted: true,
    },
  ]);
  return { messagesRequested: () => messagesRequested };
}
