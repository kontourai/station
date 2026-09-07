import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import type { Page } from '@playwright/test';
import {
  createLongSessionEventWindowHandler,
  type LongSessionEvent,
} from '../fixtures/long-session';
import { rejectUnexpectedFixtureRequest } from './fixture-audit';

/** A backend fixture distinct from sessionStorage seeds; callers declare writable authority. */
export async function mockRuntimeConversation(
  page: Page,
  input: {
    id: string;
    agentSlug: string;
    title: string;
    provider: string;
    model: string;
    projectSlug?: string;
    canContinue: boolean;
    turns: () => LongSessionEvent[][];
    onWindow?: (url: string) => void;
  },
): Promise<void> {
  const id = encodeURIComponent(input.id);
  await page.route(`**/api/conversations/${id}/open`, async (route) => {
    if (route.request().method() !== 'GET')
      return rejectUnexpectedFixtureRequest(route);
    const data: ConversationOpenResolution = {
      status: 'resolved',
      currentSessionId: input.id,
      conversation: {
        id: input.id,
        source: 'runtime',
        agentSlug: agentId(input.agentSlug),
        title: input.title,
        projectSlug: input.projectSlug,
        provider: input.provider,
        model: input.model,
        createdAt: '2026-07-19T10:00:00Z',
        updatedAt: '2026-07-19T10:05:00Z',
        messageCount: input.turns().length * 2,
        mutable: false,
        answerability: { answerable: true },
      },
      transcript: {
        available: true,
        owner: 'runtime',
        messageCount: input.turns().length * 2,
      },
      canContinue: input.canContinue,
      answerability: { answerable: true },
      recoveryActions: [],
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
  });
  await page.route(
    `**/api/orchestration/conversations/${id}/event-window**`,
    createLongSessionEventWindowHandler({
      threadId: input.id,
      conversationId: input.id,
      provider: input.provider,
      availableTurns: input.turns,
      onRequest: input.onWindow,
    }),
  );
  await page.route(
    new RegExp(`/api/orchestration/sessions/${id}/checkpoints(?:\\?.*)?$`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
  );
}
