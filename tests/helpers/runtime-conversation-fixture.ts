import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import type { ProviderDurabilityProfile } from '@kontourai/station-contracts/provider';
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
    durability?: ProviderDurabilityProfile;
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
      execution: {
        ...(input.durability ? { durability: input.durability } : {}),
        sessionId: input.id,
        agentId: agentId(input.agentSlug),
        provider: input.provider,
        ...(input.provider === 'station-agent'
          ? {}
          : { engineConnectionId: input.provider }),
        model: input.model,
      },
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
  // This transcript fixture has no queued turns or producer assessment.
  await page.route(
    `**/api/orchestration/conversations/${id}/inbox`,
    async (route) => {
      if (route.request().method() !== 'GET')
        return rejectUnexpectedFixtureRequest(route);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { entries: [] } }),
      });
    },
  );
  await page.route(
    `**/api/orchestration/sessions/${id}/turns/*/basis`,
    async (route) => {
      if (route.request().method() !== 'GET')
        return rejectUnexpectedFixtureRequest(route);
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: 'Answer Basis unavailable',
        }),
      });
    },
  );
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
  // This execution's latest-turn activity read (`useOrchestrationSession
  // ActivityQuery`): since #4864 and #4873 a Session row on Home or in
  // Activity reads its plan progress from it, so any page listing this
  // session makes it. Only that exact read is modelled here; any other
  // session-keyed window falls back to a route the spec itself declared, or
  // to the fixture audit.
  const latestTurn = createLongSessionEventWindowHandler({
    threadId: input.id,
    provider: input.provider,
    availableTurns: input.turns,
  });
  await page.route(
    `**/api/orchestration/sessions/${id}/event-window**`,
    (route) => {
      const query = new URL(route.request().url()).searchParams;
      return route.request().method() === 'GET' &&
        query.get('direction') === 'newest' &&
        query.get('turnLimit') === '1' &&
        !query.has('cursor')
        ? latestTurn(route)
        : route.fallback();
    },
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
