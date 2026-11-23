import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const ROOT = resolve(import.meta.dirname, '../../..');

/** Theme and dialog transitions finish before a capture. */
const settled = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    Promise.allSettled(
      document.getAnimations().map((animation) => animation.finished),
    ),
  );

/**
 * The real SDK, with only the hooks these surfaces read answered from
 * fixed data: a paused Project with two schedules and a Delete preview.
 */
const sdkFixture: Plugin = {
  name: 'project-lifecycle-sdk',
  setup(builder) {
    builder.onResolve({ filter: /^@kontourai\/station-sdk$/ }, (args) =>
      args.importer.endsWith('project-lifecycle-sdk')
        ? undefined
        : { path: 'project-lifecycle-sdk', namespace: 'lifecycle-fixture' },
    );
    builder.onLoad({ filter: /.*/, namespace: 'lifecycle-fixture' }, () => ({
      contents: `
          export * from ${JSON.stringify(resolve(ROOT, 'packages/sdk/src/index.ts'))};
          const idle = { mutate() {}, mutateAsync: async () => ({ interrupted: 0, stillRunning: 0, failed: 0 }), isPending: false, error: null };
          export const useProjectLifecycleMutation = () => idle;
          export const useDeleteProjectMutation = () => idle;
          export const useProjectDeletionPreviewQuery = (_slug, config) => config && config.enabled
            ? { data: { removes: { layouts: 2, knowledgeDocuments: 14, schedules: 2 }, stops: { runningSessions: 3 }, keeps: { tasks: 27, sessions: 41 } }, error: null, isError: false, refetch() {} }
            : { data: undefined, error: null, isError: false, refetch() {} };
          export const useProjectSchedulesCapability = () => ({ data: true });
          export const useSchedulerJobs = () => ({
            isPending: false, isError: false, refetch() {},
            data: [
              { name: 'monday-digest', provider: 'built-in', prompt: 'x', enabled: true, projectId: 'id-atlas', schedule: { kind: 'cron', expr: '0 9 * * 1' } },
              { name: 'nightly-triage', displayName: 'Nightly triage', provider: 'built-in', prompt: 'x', enabled: false, projectId: 'id-atlas', schedule: { kind: 'every', everyMs: 86400000 } },
              { name: 'elsewhere', provider: 'built-in', prompt: 'x', enabled: true, projectId: 'id-birch', schedule: { kind: 'every', everyMs: 3600000 } },
            ],
          });
        `,
      resolveDir: ROOT,
      loader: 'js',
    }));
  },
};

test('Pause banner, Schedules and Delete counts fit and stay usable in both themes and widths', async () => {
  const fixture = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import {ProjectHeldBanner} from './src-ui/src/views/project-page/ProjectHeldBanner';
    import {ProjectLifecycleSection} from './src-ui/src/views/project-settings/ProjectLifecycleSection';
    import {ProjectSchedulesSection} from './src-ui/src/views/project-settings/ProjectSchedulesSection';
    const paused = {state:'paused', changedAt:'2026-11-16T09:00:00.000Z'};
    function App() {
      return <QueryClientProvider client={new QueryClient()}>
        <main className="page" style={{maxWidth:960,margin:'0 auto',padding:16,display:'grid',gap:16}}>
          <ProjectHeldBanner slug="atlas" lifecycle={paused}/>
          <ProjectSchedulesSection projectId="id-atlas" projectName="Atlas" held={true}/>
          <ProjectLifecycleSection slug="atlas" name="Atlas" lifecycle={paused} pauseArchiveEnabled={true} onDeleted={()=>{}}/>
        </main>
      </QueryClientProvider>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `;
  const { browser, page, errors } = await scrollBrowserFixture(fixture, [
    sdkFixture,
  ]);
  try {
    await page.addStyleTag({
      content: [
        '../index.css',
        '../views/page-layout.css',
        '../views/editor-layout.css',
        '../views/ProjectSettingsView.css',
      ]
        .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
        .join('\n'),
    });
    const output = resolve('.kontourai/pr-5069-project-lifecycle');
    mkdirSync(output, { recursive: true });
    await page.getByText('Paused. Chats here take no messages').waitFor();
    // Only this Project's schedules are listed.
    expect(await page.getByText('elsewhere').count()).toBe(0);
    await page.getByText('monday-digest').waitFor();
    // A schedule with a display name is listed by it, not by its slug.
    await page.getByText('Nightly triage').waitFor();
    expect(await page.getByText('nightly-triage').count()).toBe(0);
    // A cron rule reads in words, as on the Automations page.
    expect(await page.getByText('0 9 * * 1').count()).toBe(0);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await settled(page);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        if (width === 390)
          for (const name of ['Resume', 'Archive', 'Delete Project']) {
            const box = await page
              .getByRole('button', { name, exact: true })
              .first()
              .boundingBox();
            expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
          }
        await page.screenshot({
          path: `${output}/${width}-${theme}.png`,
          fullPage: true,
        });
        await page.getByRole('button', { name: 'Delete Project' }).click();
        const dialog = page.getByRole('alertdialog');
        await dialog.getByText('27 Tasks').waitFor();
        await settled(page);
        expect(await dialog.textContent()).toContain(
          'Project settings, 2 Layouts, 14 knowledge documents, 2 schedules',
        );
        await page.screenshot({
          path: `${output}/${width}-${theme}-delete.png`,
          fullPage: true,
        });
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'detached' });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
