import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  OrchestrationConversationEventWindow,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { expect } from '@playwright/test';
import { EventStore } from '../src-server/services/orchestration/event-store';
import { seedMobileTaskSwitcher } from './helpers/chat-shell-fixture';
import { test } from './helpers/fixture-audit';
import { dismissSetupLauncher, seedActiveChats } from './helpers/orchestration';

// The shell is a browser fixture; history data comes from the real SQLite
// window implementation. No live reply buffer can rescue this cold read.
test('cold mobile history shows the complete reply before paging through a noisy turn', async ({
  page,
}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'station-cold-chat-'));
  const store = new EventStore(join(directory, 'events.sqlite'));
  try {
    const id = 'conv-running';
    const fields = {
      provider: 'codex' as const,
      threadId: id,
      turnId: 'cold-turn',
      itemId: 'cold-item',
      createdAt: '2026-09-12T00:00:00Z',
    };
    store.appendEvent({
      ...fields,
      eventId: 'cold-start',
      method: 'turn.started',
      prompt: 'Restore this answer after reopening.',
    });
    for (let i = 0; i < 2000; i++)
      store.appendEvent({
        ...fields,
        eventId: `cold-progress-${i}`,
        method: 'tool.progress',
        toolCallId: 'inspect',
        message: 'Inspecting files',
      });
    const reply = `Beginning of the archived answer. ${'Every part of this answer survives a cold read. '.repeat(110)}END-OF-COMPLETE-REPLY`;
    for (let i = 0; i < reply.length; i += 20)
      store.appendEvent({
        ...fields,
        eventId: `cold-text-${i}`,
        method: 'content.text-delta',
        delta: reply.slice(i, i + 20),
      });
    store.appendEvent({
      ...fields,
      eventId: 'cold-completed',
      method: 'turn.completed',
      outputText: reply,
      finishReason: 'stop',
    });
    const summary: OrchestrationSessionSummary = {
      threadId: id,
      provider: 'codex',
      status: 'closed',
      controlMode: 'station-owned',
      answerability: { answerable: true },
      isLoaded: false,
      isPersisted: true,
      eventCount: store.countEventsByThread(id),
      createdAt: fields.createdAt,
      updatedAt: fields.createdAt,
      model: 'model-selected',
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await seedMobileTaskSwitcher(page);
    await seedActiveChats(page, [
      {
        sessionId: 'chat-running',
        conversationId: id,
        agentSlug: 'station',
        title: 'Cold history',
        provider: 'codex',
        model: 'model-selected',
        projectSlug: 'default',
        projectName: 'Default',
        orchestrationSessionStarted: true,
        orchestrationStatus: 'closed',
        orchestrationTurnOpen: false,
        messages: [],
        ephemeralMessages: [],
      },
    ]);
    await page.route('**/api/orchestration/sessions/read-model', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [summary] }),
      }),
    );
    const requests: Array<{ cursor: string | null; bytes: number }> = [];
    await page.route(
      /\/api\/orchestration\/conversations\/conv-running\/event-window(?:\?.*)?$/,
      (route) => {
        const url = new URL(route.request().url());
        const window = store.listConversationEventWindowByTurn([id], {
          turnLimit: Number(url.searchParams.get('turnLimit') ?? 10),
          cursor: url.searchParams.get('cursor') ?? undefined,
          direction:
            url.searchParams.get('direction') === 'newest'
              ? 'newest'
              : undefined,
        });
        const data: OrchestrationConversationEventWindow = {
          protocolVersion: 1,
          conversationId: id,
          currentSessionId: id,
          session: summary,
          events: window.events.map((item) => ({
            sequence: item.globalSequence,
            event: item.payload,
            ...(item.elided ? { elided: item.elided } : {}),
          })),
          hasMore: window.hasMore,
          nextCursor: window.nextCursor,
          watermark: window.watermark,
          sessionLineage: [{ sessionId: id, agentSlug: agentId('station') }],
          handoffs: [],
          contextBoundaries: [],
        };
        const body = JSON.stringify({ success: true, data });
        requests.push({
          cursor: url.searchParams.get('cursor'),
          bytes: Buffer.byteLength(body),
        });
        return route.fulfill({ contentType: 'application/json', body });
      },
    );
    await page.goto('/?dock=open&maximize=true&chat=conv-running');
    await dismissSetupLauncher(page);
    const transcript = page.getByRole('log', {
      name: 'Conversation transcript',
    });
    await expect(transcript).toContainText(reply);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.cursor === null)).toBe(true);
    expect(requests.every((request) => request.bytes < 64_000)).toBe(true);
    await expect(
      transcript.locator('[data-chat-role="assistant"]'),
    ).toHaveCount(1);
    await transcript.getByRole('button', { name: 'Earlier messages' }).click();
    await expect
      .poll(() => requests.some((request) => request.cursor !== null))
      .toBe(true);
    await expect(transcript).toContainText(reply);
    await expect(
      transcript.locator('[data-chat-role="assistant"]'),
    ).toHaveCount(1);
    await page.screenshot({
      path: testInfo.outputPath('cold-history-restored.png'),
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
