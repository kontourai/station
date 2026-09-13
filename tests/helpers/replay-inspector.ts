import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import type { ReplayObservation } from '../../src-ui/src/hooks/orchestration/replay/observation-types';

/** Agent-facing browser evidence: one input, one observed UI, one screenshot. */
export async function inspectReplayStep(
  page: Page,
  testInfo: TestInfo,
): Promise<ReplayObservation> {
  const observation = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        __stationReplay?: { step(): Promise<ReplayObservation> };
      }
    ).__stationReplay;
    if (!api)
      throw new Error('Open a replay in the dock before inspecting it.');
    return api.step();
  });
  if (observation.performance?.render?.phase !== 'observed') {
    throw new Error(
      `Replay frame ${observation.cursor.index} has no settled mounted observation: ${observation.performance?.render?.phase}`,
    );
  }
  const name = `replay-frame-${String(observation.cursor.index).padStart(5, '0')}`;
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  const cursorAfterScreenshot = await page.evaluate(
    () =>
      (
        window as unknown as {
          __stationReplay: { observeState(): ReplayObservation };
        }
      ).__stationReplay.observeState().cursor.index,
  );
  if (cursorAfterScreenshot !== observation.cursor.index)
    throw new Error(
      'Replay advanced during screenshot capture; the artifact cannot be attributed to one frame.',
    );
  const record = testInfo.outputPath(`${name}.json`);
  await writeFile(record, JSON.stringify({ observation, screenshot }, null, 2));
  const retainedDirectory = process.env.STATION_REPLAY_EVIDENCE_DIR
    ? join(
        process.env.STATION_REPLAY_EVIDENCE_DIR,
        testInfo.title.replace(/[^a-z0-9-]+/gi, '-').slice(0, 100),
      )
    : undefined;
  if (retainedDirectory) {
    await mkdir(retainedDirectory, { recursive: true });
    await copyFile(screenshot, join(retainedDirectory, `${name}.png`));
    await writeFile(
      join(retainedDirectory, `${name}.json`),
      JSON.stringify(observation, null, 2),
    );
  }
  await testInfo.attach(name, { path: screenshot, contentType: 'image/png' });
  await testInfo.attach(`${name}-observation`, {
    path: record,
    contentType: 'application/json',
  });
  return observation;
}
