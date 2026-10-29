import { expect, type Page } from '@playwright/test';
import type { PaneRelationsRecord } from '../../src-ui/src/regions/pane-relations';

export async function seedLegacyKeptPluginOpener(page: Page): Promise<string> {
  await page.waitForFunction(() => {
    const record: PaneRelationsRecord | null = JSON.parse(
      localStorage.getItem('station:pane-relations:v1') ?? 'null',
    );
    return record?.entries.some(
      (entry) =>
        entry.kept &&
        entry.target.kind === 'plugin' &&
        entry.target.key === 'weekly',
    );
  });
  return page.evaluate(() => {
    const key = 'station:pane-relations:v1';
    const record: PaneRelationsRecord = JSON.parse(
      localStorage.getItem(key) ?? 'null',
    );
    const relation = record.entries.find(
      (entry) =>
        entry.kept &&
        entry.target.kind === 'plugin' &&
        entry.target.key === 'weekly',
    );
    if (relation?.opener.source.kind !== 'plugin-occurrence')
      throw new Error(
        'The installed Reports caller must have a kept Weekly report',
      );
    const source = { ...relation.opener.source };
    delete source.projectPane;
    localStorage.setItem(
      key,
      JSON.stringify({
        ...record,
        entries: record.entries.map((entry) =>
          entry.instanceId === relation.instanceId
            ? { ...entry, opener: { ...entry.opener, source } }
            : entry,
        ),
      }),
    );
    return relation.instanceId;
  });
}

export async function expectUpgradedPluginOpener(
  page: Page,
  handle: string,
  descriptorId: string,
  instanceId: string,
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate((handle) => {
        const record: PaneRelationsRecord = JSON.parse(
          localStorage.getItem('station:pane-relations:v1') ?? 'null',
        );
        return record.entries.find((entry) => entry.instanceId === handle);
      }, handle),
    )
    .toMatchObject({
      instanceId: handle,
      kept: true,
      opener: { source: { projectPane: { descriptorId, instanceId } } },
    });
}
