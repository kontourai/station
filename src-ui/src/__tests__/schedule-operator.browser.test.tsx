import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { SchedulerService } from '../../../src-server/services/scheduling/scheduler-service.js';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

/** Saturday 21 November 2026, noon UTC; the page reads in UTC. */
const NOW = '2026-11-21T12:00:00.000Z';

const base = { provider: 'built-in', prompt: 'fixture', enabled: true };
const jobs = [
  {
    ...base,
    name: 'daily-repo-digest',
    displayName: 'Daily repo digest',
    schedule: { kind: 'cron', expr: '0 8 * * 1-5', timezone: 'UTC' },
    target: { kind: 'dedicated', agent: 'helper' },
    nextRun: '2026-11-23T08:00:00.000Z',
    lastRun: '2026-11-20T08:00:00.000Z',
    recentOutcomes: {
      outcomes: [
        'worked',
        'worked',
        'skipped',
        'worked',
        'worked',
        'worked',
        'worked',
        'worked',
        'worked',
        'worked',
        'worked',
        'worked',
      ],
      more: true,
    },
  },
  {
    ...base,
    name: 'check-back',
    displayName: 'Check back on open work with a name long enough to wrap',
    schedule: { kind: 'cron', expr: '0 16 * * 1-5', timezone: 'UTC' },
    target: { kind: 'dedicated', agent: 'helper' },
    nextRun: '2026-11-23T16:00:00.000Z',
    lastRun: '2026-11-20T16:00:00.000Z',
    consecutiveFailures: 2,
    recentOutcomes: {
      outcomes: ['worked', 'worked', 'worked', 'failed', 'failed'],
      more: false,
    },
  },
  {
    ...base,
    name: 'nightly-sweep',
    displayName: 'Nightly test sweep',
    enabled: false,
    schedule: { kind: 'cron', expr: '0 2 * * *', timezone: 'UTC' },
    consecutiveFailures: 5,
    pausedItself: { failures: 5, at: '2026-11-21T02:00:00.000Z' },
    recentOutcomes: {
      outcomes: ['worked', 'failed', 'failed', 'unknown', 'unknown', 'failed'],
      more: false,
    },
  },
  {
    ...base,
    name: 'release-notes',
    displayName: 'Release notes draft',
    // A one-time automation whose run happened: it reads Done.
    schedule: { kind: 'at', timeMs: Date.parse('2026-11-20T10:00:00.000Z') },
    lastRun: '2026-11-20T10:00:02.000Z',
    recentOutcomes: { outcomes: ['worked'], more: false },
  },
];
const weeks = Object.fromEntries(
  ['2026-11-16', '2026-11-23'].map((start) => [
    start,
    SchedulerService.prototype.projectWeek(jobs as never, start, 'UTC'),
  ]),
);

const data: Plugin = {
  name: 'schedule-operator-fixtures',
  setup(builder) {
    const modules = {
      useScheduler: `
        const weeks = ${JSON.stringify(weeks)};
        export const useSchedulerJobs=(start)=>({data:weeks[start],isLoading:false,isError:false,refetch(){}});
        export const useRunsQuery=()=>({data:[],isLoading:false});
        export const useFetchRunOutputRef=()=>({mutateAsync:async()=>({content:''})});
        export const useRestartJobMonitor=()=>({mutateAsync:async()=>{}});
        export const useResolveIndeterminateJobMonitor=useRestartJobMonitor;
        export const usePreviewSchedule=()=>({data:undefined,isLoading:false});
      `,
      NavigationContext:
        'export const useNavigation=()=>({navigate(){}}); export const navigationStore={};',
    };
    builder.onResolve(
      { filter: /\/(useScheduler|NavigationContext)$/ },
      (args) => ({
        path: args.path.split('/').at(-1)!,
        namespace: 'schedule-fixture',
      }),
    );
    builder.onLoad(
      { filter: /.*/, namespace: 'schedule-fixture' },
      ({ path }) => ({
        contents: modules[path as keyof typeof modules],
        loader: 'js',
      }),
    );
  },
};

test('Automations: Next 7 days and the list fit phone and desktop in both themes', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ScheduleNextDays, NextDaysTitle} from './src-ui/src/views/schedule/ScheduleNextDays';
    import {ScheduleAutomationList, OutcomeLegend} from './src-ui/src/views/schedule/ScheduleAutomationList';
    const NativeDate = Date;
    const fixed = NativeDate.parse('${NOW}');
    globalThis.Date = class extends NativeDate {
      constructor(...args){ super(...(args.length ? args : [fixed])); }
      static now(){ return fixed; }
    };
    const jobs = ${JSON.stringify(jobs)};
    const noop = () => {};
    function App() {
      return <main className="schedule" style={{padding:16}}>
        <h2 className="page-section__title" data-testid="next-title"><NextDaysTitle /></h2>
        <ScheduleNextDays onOpen={noop} />
        <OutcomeLegend jobs={jobs} />
        <ScheduleAutomationList jobs={jobs}
          agents={[{slug:'helper',name:'Release helper',engineDisplayName:'Codex'}]}
          projectName={() => undefined} expanded={null} onExpand={noop} autoOpenRun={null}
          isRunning={() => false} getMissedCount={() => 0}
          actions={{onRun:noop,onPause:noop,onResume:noop,onEdit:noop,onDuplicate:noop,onDelete:noop}} />
      </main>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    [data],
    { timezoneId: 'UTC' },
  );
  try {
    await page.addStyleTag({
      content:
        resolveCssImports(resolve(import.meta.dirname, '../index.css')) +
        resolveCssImports(
          resolve(import.meta.dirname, '../views/ScheduleView.css'),
        ),
    });
    const out = resolve('.kontourai/automations-list-5466');
    mkdirSync(out, { recursive: true });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme,
        );
        await page.getByText('Nightly test sweep').waitFor();
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
          `no sideways scroll at ${width}px ${theme}`,
        ).toBe(true);
        const week = page.getByRole('list', { name: 'Next 7 days' });
        const nextUp = page.locator('.automations-next-up__list');
        const triggers = page.getByRole('button', { name: /^Actions for / });
        expect(await triggers.count()).toBe(4);
        const title = await page.getByTestId('next-title').innerText();
        expect(title.trim()).toBe(width === 390 ? 'Next up' : 'Next 7 days');
        await expect
          .poll(() =>
            page
              .getByTestId('job-row-release-notes')
              .locator('.automations-row__status')
              .innerText(),
          )
          .toBe('Done');
        if (width === 390) {
          // The ⋯ sits in the middle of its row, whatever the row holds.
          for (const row of await page.locator('.automations-row').all()) {
            const rowBox = (await row.boundingBox())!;
            const menuBox = (await row
              .locator('.action-overflow__trigger')
              .boundingBox())!;
            const offset = Math.abs(
              menuBox.y + menuBox.height / 2 - (rowBox.y + rowBox.height / 2),
            );
            expect(offset, 'menu centred in its row').toBeLessThanOrEqual(4);
            // A full strip of twelve never runs into the status word.
            const strip = await row.locator('.automations-strip').boundingBox();
            const status = (await row
              .locator('.automations-row__status')
              .boundingBox())!;
            if (strip && strip.y + strip.height > status.y)
              expect(
                strip.x + strip.width,
                'strip clear of status',
              ).toBeLessThanOrEqual(status.x);
          }
          expect(await week.isVisible()).toBe(false);
          expect(
            await nextUp.locator('.automations-next-up__row').count(),
          ).toBe(3);
          for (const trigger of await triggers.all()) {
            const box = await trigger.boundingBox();
            expect(box!.width).toBeGreaterThanOrEqual(44);
            expect(box!.height).toBeGreaterThanOrEqual(44);
          }
        } else {
          expect(await nextUp.isVisible()).toBe(false);
          expect(
            await week.getByRole('listitem', { name: /^Today/ }).count(),
          ).toBe(1);
          // A day's runs stay inside its column.
          const overflowing = await week.evaluate((list) =>
            [...list.querySelectorAll('.automations-week__day')].some(
              (day) => day.scrollWidth > day.clientWidth,
            ),
          );
          expect(overflowing).toBe(false);
          // A truncated chip still names its automation in full.
          const chip = week.getByRole('button', {
            name: /Check back on open work with a name long enough to wrap/,
          });
          expect(await chip.first().getAttribute('title')).toMatch(
            /Check back on open work with a name long enough to wrap$/,
          );
        }
        await page.screenshot({
          path: `${out}/automations-${width}-${theme}.png`,
        });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
