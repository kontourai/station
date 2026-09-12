import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { expect, type Page } from '@playwright/test';
import type { SessionTape } from '../src-ui/src/hooks/orchestration/replay/tape';
import {
  chatReplayScenarios,
  longHistoryReplayTape,
  multiTurnReplayTape,
  partialHistoryReplayTape,
} from './fixtures/chat-replay-scenarios';
import { seedMobileTaskSwitcher } from './helpers/chat-shell-fixture';
import { test } from './helpers/fixture-audit';
import { dismissSetupLauncher } from './helpers/orchestration';
import { inspectReplayStep } from './helpers/replay-inspector';

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(body),
});
test.use({ video: 'on' });
test('replay correlates each event with the real mobile transcript and a screenshot', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMobileTaskSwitcher(page);
  await page.addInitScript(() => {
    localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify({ version: 2, values: { developerToolsEnabled: true } }),
    );
  });
  const base = {
    provider: 'codex',
    threadId: 'conv-running',
    turnId: 'replay-turn',
    createdAt: '2026-09-12T00:00:00.000Z',
  } as const;
  const events = [
    {
      ...base,
      eventId: 'replay-start',
      method: 'turn.started',
      prompt: 'Show the replayed question.',
    },
    {
      ...base,
      eventId: 'replay-text',
      method: 'content.text-delta',
      itemId: 'text-1',
      delta: 'Replayed answer.',
    },
    {
      ...base,
      eventId: 'replay-tool',
      method: 'tool.started',
      itemId: 'tool-1',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      arguments: { path: 'fixture.txt' },
    },
    {
      ...base,
      eventId: 'replay-result',
      method: 'tool.completed',
      itemId: 'tool-1',
      toolCallId: 'tool-1',
      toolName: 'read_file',
      output: 'Recorded tool output',
      status: 'success',
    },
    {
      ...base,
      eventId: 'replay-done',
      method: 'turn.completed',
      outputText: 'Replayed answer.',
      finishReason: 'stop',
    },
  ] satisfies CanonicalRuntimeEvent[];
  await page.route(
    /\/api\/orchestration\/sessions\/(?:conv-running|chat-running)$/,
    (route) =>
      route.fulfill(
        json({
          success: true,
          data: { session: { model: 'model-selected' }, events },
        }),
      ),
  );
  await page.goto('/?dock=open&maximize=true&chat=conv-running');
  await dismissSetupLauncher(page);
  await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Chat settings', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Step through this conversation' })
    .click();
  await expect(page.getByTestId('replay-transport')).toBeVisible();
  await expect(page.getByTestId('replay-transport')).toContainText('0 / 5');
  for (let index = 0; index < events.length; index += 1) {
    const observation = await inspectReplayStep(page, testInfo);
    expect(observation.cursor.index).toBe(index);
    expect(observation.cursor.eventId).toBe(events[index].eventId);
    expect(observation.issues).toEqual([]);
    expect(observation.performance?.render?.mountedRows).toBeGreaterThan(0);
  }
  const transcript = page.getByRole('log', { name: 'Conversation transcript' });
  await expect(transcript).toContainText('Show the replayed question.');
  await expect(transcript).toContainText('Replayed answer.');
  await expect(transcript.locator('[data-chat-role="assistant"]')).toHaveCount(
    1,
  );
  await expect(page.getByTestId('replay-transport')).toContainText('5 / 5');
  await page.getByText('Replay controls · 5 / 5', { exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByTestId('replay-transport')).toContainText('4 / 5');
});

async function openReplayScenario(page: Page, tape: SessionTape) {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedMobileTaskSwitcher(page);
  await page.addInitScript(() =>
    localStorage.setItem(
      'station-device-settings-v1',
      JSON.stringify({ version: 2, values: { developerToolsEnabled: true } }),
    ),
  );
  await page.goto('/?dock=open&maximize=true&chat=conv-running');
  await dismissSetupLauncher(page);
  await page.getByRole('button', { name: 'Chat actions', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Chat settings', exact: true })
    .click();
  await page.getByLabel('Import replay file').setInputFiles({
    name: 'scenario.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(tape)),
  });
  await expect(page.getByTestId('replay-transport')).toBeVisible();
}

test.describe('replay state coverage', () => {
  for (const scenario of chatReplayScenarios) {
    test(scenario.name, async ({ page }, testInfo) => {
      await openReplayScenario(page, scenario.tape);
      let observation:
        | Awaited<ReturnType<typeof inspectReplayStep>>
        | undefined;
      for (const _frame of scenario.tape.frames ?? [])
        observation = await inspectReplayStep(page, testInfo);
      const transcript = page.getByRole('log', {
        name: 'Conversation transcript',
      });
      await expect(transcript).toContainText(scenario.text);
      expect(observation?.streaming.present).toBe(scenario.streaming);
      expect(observation?.performance?.render?.mountedRows).toBeLessThan(80);
      if ('timer' in scenario)
        await expect(transcript.locator('.elapsed-wait')).toContainText(
          scenario.timer!,
        );
      if ('tools' in scenario) {
        expect(observation?.streaming.toolCallCount).toBe(scenario.tools);
        await expect(transcript.locator('.tool-call-batch__count')).toHaveText(
          `${scenario.tools} tools`,
        );
        await expect(transcript.locator('.streaming-activity')).toHaveCount(0);
      }
      if (scenario.name === 'partial answer still running')
        await expect(transcript.locator('.streaming-activity')).toHaveCount(0);
      expect(
        await transcript.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
      if ('connection' in scenario) {
        await expect(page.locator('[data-chat-stream-status]')).toContainText(
          scenario.connection!,
        );
        await expect(transcript.locator('.streaming-activity')).toHaveCount(0);
      }
      if (scenario.name === 'provider error after partial text')
        await expect(transcript).toContainText('The first check completed.');
      if (scenario.name === 'waiting before content') {
        const motion = await transcript
          .locator('.loading-dots-inline > span')
          .first()
          .evaluate(async (node) => {
            const samples: number[] = [];
            for (let frame = 0; frame < 75; frame++) {
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
              );
              samples.push(Number(getComputedStyle(node).opacity));
            }
            return {
              name: getComputedStyle(node).animationName,
              minimum: Math.min(...samples),
              maximum: Math.max(...samples),
            };
          });
        expect(motion.name).not.toBe('none');
        expect(motion.maximum - motion.minimum).toBeGreaterThan(0.1);
        const video = page.video();
        await page.close();
        if (!video)
          throw new Error('The loading-state recording was not created.');
        await video.saveAs(testInfo.outputPath('loading-state.webm'));
        const directory = process.env.STATION_REPLAY_EVIDENCE_DIR;
        if (directory) {
          await mkdir(directory, { recursive: true });
          await copyFile(
            testInfo.outputPath('loading-state.webm'),
            join(directory, 'loading-state.webm'),
          );
        }
      }
    });
  }

  test('multiple turns retain separate questions and answers', async ({
    page,
  }, testInfo) => {
    const tape = multiTurnReplayTape();
    await openReplayScenario(page, tape);
    for (const _frame of tape.frames ?? [])
      await inspectReplayStep(page, testInfo);
    const transcript = page.getByRole('log', {
      name: 'Conversation transcript',
    });
    await expect(transcript.locator('[data-chat-role="user"]')).toHaveCount(8);
    await expect(
      transcript.locator('[data-chat-role="assistant"]'),
    ).toHaveCount(8);
    await expect(transcript).toContainText(
      'Answer 8 remains associated with its own question.',
    );
  });

  test('partial 150-event history cannot replace the completed reply', async ({
    page,
  }, testInfo) => {
    const tape = partialHistoryReplayTape();
    await openReplayScenario(page, tape);
    for (const _frame of tape.frames ?? [])
      await inspectReplayStep(page, testInfo);
    const transcript = page.getByRole('log', {
      name: 'Conversation transcript',
    });
    await expect(transcript).toContainText(
      'The full answer survived completion and the incomplete history refresh.',
    );
    await expect(
      transcript.locator('[data-chat-role="assistant"]'),
    ).toHaveCount(1);
    await expect(page.getByTestId('chat-dock-history-elided')).toHaveCount(0);
  });

  test('ten-thousand-turn history stays virtualized while recorded pages load', async ({
    page,
  }, testInfo) => {
    const tape = longHistoryReplayTape();
    await openReplayScenario(page, tape);
    for (const _frame of tape.frames ?? [])
      await inspectReplayStep(page, testInfo);
    const transcript = page.getByRole('log', {
      name: 'Conversation transcript',
    });
    await expect(
      transcript.locator('[data-transcript-row-count]'),
    ).toHaveAttribute('data-transcript-row-count', '180');
    expect(
      await transcript.locator('[data-transcript-row]').count(),
    ).toBeLessThan(80);
    await transcript.hover();
    await page.mouse.wheel(0, -600);
    await expect(
      page.getByRole('button', { name: 'Scroll to bottom' }),
    ).toBeVisible();
  });

  for (const theme of ['light', 'dark']) {
    test(`loading state honors reduced motion in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openReplayScenario(
        page,
        chatReplayScenarios.find(
          (scenario) => scenario.name === 'waiting before content',
        )!.tape,
      );
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-theme', theme),
        theme,
      );
      for (const _frame of chatReplayScenarios.find(
        (scenario) => scenario.name === 'waiting before content',
      )!.tape.frames ?? [])
        await inspectReplayStep(page, testInfo);
      const durations = await page
        .locator('.loading-dots-inline > span')
        .evaluateAll((nodes) =>
          nodes.map((node) =>
            Number.parseFloat(getComputedStyle(node).animationDuration),
          ),
        );
      expect(durations.length).toBe(3);
      expect(durations.every((duration) => duration <= 0.01)).toBe(true);
      await expect(page.locator('.elapsed-wait')).toContainText('0:28');
    });
  }
});
