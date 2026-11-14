import { agentId, engineId } from '@kontourai/station-contracts/agent-identity';
import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { expect } from '@playwright/test';
import { buildLongSessionTurns } from './fixtures/long-session';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  dismissSetupLauncher,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  seedActiveChats,
  seedOrchestrationRoutes,
} from './helpers/orchestration';
import { mockRuntimeConversation } from './helpers/runtime-conversation-fixture';

const parent = 'conv-running';
const parentTitle =
  'Parent chat with a long title that must truncate without clipping navigation';
const child: ChildWorkItem = {
  producer: 'engine-subagent',
  reporterThreadId: parent,
  childId: 'child-review',
  status: 'completed',
  title: 'Review files',
  transcript: { kind: 'codex-thread', threadId: 'child-review' },
  result: { summary: 'Files reviewed', source: 'child-message' },
};
async function seed(page: import('@playwright/test').Page) {
  await seedOrchestrationRoutes(page);
  await seedActiveChats(page, [
    {
      sessionId: parent,
      conversationId: parent,
      title: parentTitle,
      agentSlug: 'dev-agent',
      provider: 'codex',
      model: 'model-selected',
      orchestrationSessionStarted: true,
      ephemeralMessages: [],
      inputHistory: [],
    },
  ]);
  await installMockOrchestrationSse(page);
  const turns = buildLongSessionTurns({
    threadId: parent,
    provider: 'codex',
    turnCount: 1,
    replyText: () => 'Parent answer with a child review.',
  });
  turns[0]!.splice(1, 0, {
    eventId: 'child-updated',
    provider: 'codex',
    threadId: parent,
    turnId: 'turn-0',
    createdAt: '2026-07-19T10:00:01Z',
    method: 'child-work.updated',
    delta: { kind: 'upsert', item: child },
  });
  await installMockOrchestrationEventWindow(page, 'codex', {
    [parent]: turns.flat(),
  });
  await mockRuntimeConversation(page, {
    id: parent,
    title: parentTitle,
    agentSlug: 'dev-agent',
    provider: 'codex',
    model: 'model-selected',
    canContinue: true,
    turns: () => turns,
  });
  const session: OrchestrationSessionSummary = {
    threadId: parent,
    conversationId: parent,
    provider: engineId('codex'),
    assignedAgentSlug: agentId('dev-agent'),
    displayTitle: parentTitle,
    controlMode: 'station-owned',
    answerability: { answerable: true },
    status: 'ready',
    lifecycleState: 'idle',
    createdAt: '2026-07-19T10:00:00Z',
    updatedAt: '2026-07-19T10:05:00Z',
    isLoaded: true,
    isPersisted: true,
    eventCount: 3,
  };
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill({ json: { success: true, data: [session] } }),
  );
  await page.route(`**/api/orchestration/sessions/${parent}`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: { success: true, data: { session, events: [] } },
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    `**/api/orchestration/sessions/${parent}/child-work/child-review/transcript**`,
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            json: {
              success: true,
              data: {
                entries: [
                  {
                    kind: 'text',
                    message: 0,
                    role: 'user',
                    text: 'Read the child files',
                  },
                  {
                    kind: 'text',
                    message: 1,
                    role: 'assistant',
                    text: '## Child review\n\nThe files are ready.',
                  },
                  {
                    kind: 'tool-result',
                    message: 2,
                    text: '',
                  },
                ],
              },
            },
          })
        : rejectUnexpectedFixtureRequest(route),
  );
  await page.route(
    `**/api/orchestration/sessions/${parent}/child-work/child-review/instructions**`,
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ json: { success: true, data: { entries: [] } } })
        : rejectUnexpectedFixtureRequest(route),
  );
}
for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 412, height: 915 },
  { width: 390, height: 844 },
]) {
  for (const theme of ['dark', 'light']) {
    test(`child chat and breadcrumb at ${viewport.width}px ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await seed(page);
      await page.addInitScript(
        (value) =>
          localStorage.setItem(
            'station-device-settings-v1',
            JSON.stringify({ version: 2, values: { theme: value } }),
          ),
        theme,
      );
      const childUrl = `/?dock=open&chat=${parent}&surface=chat&session=${parent}&child=child-review&childTitle=Review+files`;
      await page.goto(childUrl);
      await dismissSetupLauncher(page);
      const log = page.getByRole('log', { name: 'Conversation transcript' });
      const trail = page.getByRole('navigation', { name: 'Chat breadcrumb' });
      await expect(trail).toContainText('Review files');
      const childLog = page.getByRole('log', {
        name: 'Conversation transcript',
      });
      await expect(
        childLog.getByRole('heading', { name: 'Child review' }),
      ).toBeVisible();
      await expect(childLog).toContainText('Read the child files');
      await expect(childLog).toContainText('Text output unavailable.');
      await page.screenshot({
        path: testInfo.outputPath(`child-chat-${viewport.width}-${theme}.png`),
      });
      for (const name of ['Back to parent chat', parentTitle]) {
        const control = trail.getByRole('button', { name, exact: true });
        const box = (await control.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(
          await control.evaluate((button) => {
            const box = button.getBoundingClientRect();
            return button.contains(
              document.elementFromPoint(
                box.x + box.width / 2,
                box.y + box.height / 2,
              ),
            );
          }),
        ).toBe(true);
        await control.click();
        await expect(trail).toHaveCount(0);
        await expect(log).toContainText('Parent answer with a child review.');
        if (name === 'Back to parent chat') {
          await page.goto(childUrl);
          await expect(trail).toBeVisible();
        }
      }
    });
  }
}
test('legacy Activity session URL reads that exact session in Chat', async ({
  page,
}) => {
  await seed(page);
  await page.goto(`/?surface=activity&session=${parent}`);
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText('Parent answer with a child review.');
  await expect(page.locator('.imported-conversation-pane')).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Chat breadcrumb' }),
  ).toHaveCount(0);
  await expect(page.getByText('Activity', { exact: true })).toHaveCount(0);
});
