import { agentId, engineId } from '@kontourai/station-contracts/agent-identity';
import type {
  ChildWorkItem,
  ChildWorkTranscriptEntry,
} from '@kontourai/station-contracts/child-work';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { expect } from '@playwright/test';
import { buildLongSessionTurns } from './fixtures/long-session';
import { contrastRatio } from './helpers/color-contrast';
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

// The Claude reader's shape: the prompt, then one message per call and per
// result, keyed by the engine's call id; a legacy unkeyed empty result last.
const childEntries: ChildWorkTranscriptEntry[] = [
  { kind: 'text', message: 0, role: 'user', text: 'Read the child files' },
  {
    kind: 'tool-call',
    message: 1,
    toolCallId: 'toolu_01',
    name: 'Grep',
    input: JSON.stringify({
      pattern: 'projectRuntimeEvents',
      path: 'src-server',
    }),
  },
  {
    kind: 'tool-result',
    message: 2,
    toolCallId: 'toolu_01',
    text: 'src-server/runtime/events.ts',
  },
  {
    kind: 'tool-call',
    message: 3,
    toolCallId: 'toolu_02',
    name: 'Read',
    input: JSON.stringify({ file_path: 'src-server/runtime/events.ts' }),
  },
  {
    kind: 'tool-result',
    message: 4,
    toolCallId: 'toolu_02',
    text: 'export function readEvents() {}',
  },
  {
    kind: 'text',
    message: 5,
    role: 'assistant',
    text: '## Child review\n\nThe files are ready.',
  },
  { kind: 'tool-result', message: 6, text: '' },
];
/** An earlier session of the parent's conversation (before a restart). */
const earlier = 'conv-running-earlier';
async function seed(
  page: import('@playwright/test').Page,
  { includeTool = false } = {},
) {
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
  if (includeTool) {
    const tool = {
      provider: 'codex',
      threadId: parent,
      turnId: 'turn-0',
      itemId: 'read-parent',
      toolCallId: 'read-parent',
      toolName: 'Read',
    };
    turns[0]!.splice(
      1,
      0,
      {
        ...tool,
        eventId: 'read-parent-started',
        method: 'tool.started',
        createdAt: '2026-07-19T10:00:00.100Z',
        arguments: { file_path: 'guide.md' },
      },
      {
        ...tool,
        eventId: 'read-parent-completed',
        method: 'tool.completed',
        createdAt: '2026-07-19T10:00:00.200Z',
        status: 'success',
        output: 'The parent file is readable.',
      },
    );
  }
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
  const earlierSession: OrchestrationSessionSummary = {
    ...session,
    threadId: earlier,
    createdAt: '2026-07-19T09:00:00Z',
    updatedAt: '2026-07-19T09:30:00Z',
  };
  await page.route('**/api/orchestration/sessions/read-model', (route) =>
    route.fulfill({ json: { success: true, data: [session, earlierSession] } }),
  );
  await page.route(`**/api/orchestration/sessions/${parent}`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: { success: true, data: { session, events: [] } },
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  // The child's transcript as the server pages it: a tail read names where
  // its messages start and end, and a read from a cursor returns only what
  // follows (nothing, once the child has settled).
  for (const reporter of [parent, earlier])
    await page.route(
      `**/api/orchestration/sessions/${reporter}/child-work/child-review/transcript**`,
      (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        const query = new URL(route.request().url()).searchParams;
        const end = 7;
        const limit = Number(query.get('limit') ?? 30);
        const offset =
          query.get('tail') === '1'
            ? Math.max(0, end - limit)
            : Number(query.get('offset') ?? 0);
        const last = Math.min(end, offset + limit);
        return route.fulfill({
          json: {
            success: true,
            data: {
              entries: childEntries.filter(
                (entry) => entry.message >= offset && entry.message < last,
              ),
              offset,
              endOffset: Math.max(offset, last),
            },
          },
        });
      },
    );
  for (const reporter of [parent, earlier])
    await page.route(
      `**/api/orchestration/sessions/${reporter}/child-work/child-review/instructions**`,
      (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ json: { success: true, data: { entries: [] } } })
          : rejectUnexpectedFixtureRequest(route),
    );
}
for (const viewport of [
  { width: 1440, height: 1000 },
  // A Coding-layout chat column of about 620px.
  { width: 1060, height: 900 },
  { width: 412, height: 915 },
  { width: 390, height: 844 },
]) {
  for (const theme of ['dark', 'light']) {
    test(`child chat and breadcrumb at ${viewport.width}px ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      await seed(page);
      await page.route('**/api/me/preferences', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              json: {
                success: true,
                data: { schemaVersion: 1, values: { theme } },
              },
            })
          : rejectUnexpectedFixtureRequest(route),
      );
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
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
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
      // A result with no call on hand is a tool row, not the agent's prose
      // (a phone folds the turn's tool rows into one summary).
      await expect(childLog).toContainText(
        viewport.width < 600 ? 'used 1 tool' : 'Tool result',
      );
      await expect(childLog.getByText('Text output unavailable.')).toBeHidden();
      // One reply row, not one card per tool call, and no paging buttons
      // at the foot of the transcript.
      await expect(
        childLog.locator('[data-message-role="assistant"]'),
      ).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(
        0,
      );
      await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(
        0,
      );
      await expect(trail).not.toContainText('›');
      await page.screenshot({
        path: testInfo.outputPath(`child-chat-${viewport.width}-${theme}.png`),
      });
      // A phone bar names the child and goes back by ‹; a wider bar is one
      // trail whose parent crumb is the way back.
      const phone = viewport.width < 600;
      await expect(
        trail.getByRole('button', { name: 'Back to parent chat' }),
      ).toBeVisible({ visible: phone });
      await expect(
        trail.getByRole('button', { name: parentTitle, exact: true }),
      ).toBeVisible({ visible: !phone });
      // The parent's title yields first: the child's short title is shown
      // whole, not cut to an ellipsis.
      expect(
        await trail
          .locator('[aria-current="page"]')
          .evaluate((crumb) => crumb.scrollWidth <= crumb.clientWidth),
      ).toBe(true);
      for (const name of phone ? ['Back to parent chat'] : [parentTitle]) {
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
        // Back lands on the working chat, not a record reader of it.
        await expect(page.locator('.imported-conversation-pane')).toHaveCount(
          0,
        );
        if (name === 'Back to parent chat') {
          await page.goto(childUrl);
          await expect(trail).toBeVisible();
        }
      }
    });
  }
}
test('tool success has readable contrast in active, parent and child chat cards', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page, { includeTool: true });
  await page.route('**/api/me/preferences', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            success: true,
            data: { schemaVersion: 1, values: { theme: 'light' } },
          },
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  await page.addInitScript(() =>
    localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify({ version: 2, values: { theme: 'light' } }),
    ),
  );
  const successContrast = async () => {
    const transcript = page.getByRole('log', {
      name: 'Conversation transcript',
    });
    const call = transcript.locator('.tool-call').first();
    await expect(call).toBeVisible();
    const toggle = call.getByRole('button').first();
    if ((await toggle.getAttribute('aria-expanded')) === 'false')
      await toggle.click();
    const footer = call.locator('.tool-call__status-footer');
    await expect(footer).toContainText('Success');
    return contrastRatio(footer);
  };
  await page.goto(`/?dock=open&chat=${parent}`);
  await dismissSetupLauncher(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const activeContrast = await successContrast();

  await page.goto(
    `/?dock=open&chat=${parent}&surface=chat&session=${parent}&child=child-review&childTitle=Review+files`,
  );
  await dismissSetupLauncher(page);
  const trail = page.getByRole('navigation', { name: 'Chat breadcrumb' });
  await expect(trail).toContainText('Review files');
  const childContrast = await successContrast();
  await trail.getByRole('button', { name: parentTitle, exact: true }).click();
  await expect(trail).toBeHidden();
  const parentContrast = await successContrast();

  for (const [surface, ratio] of Object.entries({
    active: activeContrast,
    child: childContrast,
    parent: parentContrast,
  })) {
    expect
      .soft(ratio, `${surface} chat Success text contrast`)
      .toBeGreaterThanOrEqual(4.5);
  }
});

test('a child an earlier session of the working conversation reported opens over the working chat, and back lands on it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seed(page);
  await page.goto(
    `/?dock=open&chat=${parent}&surface=chat&session=${earlier}&child=child-review&childTitle=Review+files`,
  );
  await dismissSetupLauncher(page);
  const trail = page.getByRole('navigation', { name: 'Chat breadcrumb' });
  await expect(
    page
      .getByRole('log', { name: 'Conversation transcript' })
      .getByRole('heading', { name: 'Child review' }),
  ).toBeVisible();
  await trail.getByRole('button', { name: parentTitle, exact: true }).click();
  await expect(trail).toHaveCount(0);
  await expect(
    page.getByRole('log', { name: 'Conversation transcript' }),
  ).toContainText('Parent answer with a child review.');
  await expect(page.locator('.imported-conversation-pane')).toHaveCount(0);
});

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
