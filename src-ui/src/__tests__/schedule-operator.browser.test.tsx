import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { SchedulerService } from '../../../src-server/services/scheduling/scheduler-service.js';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const run = {
  runId: 'schedule:built-in:daily:log-one',
  source: 'schedule',
  sourceId: 'daily',
  providerId: 'built-in',
  status: 'failed',
  startedAt: '2026-03-07T08:00:00.000Z',
  attempt: 2,
};

const dailyJob = {
  name: 'Daily check',
  provider: 'built-in',
  prompt: 'fixture',
  enabled: true,
};
const calendar = {
  'America/New_York': SchedulerService.prototype.projectWeek(
    [
      {
        ...dailyJob,
        schedule: {
          kind: 'at',
          timeMs: Date.parse('2026-03-08T00:30:00.000Z'),
        },
      },
    ],
    '2026-03-02',
    'America/New_York',
  ),
  'Pacific/Kiritimati': SchedulerService.prototype.projectWeek(
    [{ ...dailyJob, cron: '* * * * *' }],
    '2026-03-02',
    'Pacific/Kiritimati',
  ),
};

const data: Plugin = {
  name: 'schedule-operator-fixtures',
  setup(builder) {
    const modules = {
      useScheduler: `
        const calendar = ${JSON.stringify(calendar)};
        export const useSchedulerJobs=(_,zone)=>({data:calendar[zone] ?? calendar['America/New_York']});
        export const useRunsQuery=()=>({data:${JSON.stringify([run])},isLoading:false});
        export const useFetchRunOutputRef=()=>({mutateAsync:async()=>({content:''})});
        export const useRestartJobMonitor=()=>({mutateAsync:async()=>{}});
        export const useResolveIndeterminateJobMonitor=useRestartJobMonitor;
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

test('Schedule calendar and executions fit phone and desktop in both themes', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Tabs, tabElementId, tabPanelElementId} from './src-ui/src/components/Tabs';
    import {ScheduleWeek} from './src-ui/src/views/schedule/ScheduleWeek';
    import {ScheduleExecutions} from './src-ui/src/views/schedule/ScheduleExecutions';
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      constructor(...args){ super(...(args.length ? args : ['2026-03-07T12:00:00.000Z'])); }
    };
    function App() {
      const [pane,setPane]=useState('week');
      const [selectedId,onSelect]=useState(null);
      return <main className="schedule" style={{padding:16}}>
        <Tabs id="schedule-views" aria-label="Schedule view" activeKey={pane}
          activation="manual" onSelect={setPane} items={[{key:'week',label:'Calendar'},{key:'exec',label:'Executions'}]} />
        <div role="tabpanel" aria-labelledby={tabElementId('schedule-views',pane)} id={tabPanelElementId('schedule-views',pane)}>
          {pane==='week' ? <ScheduleWeek/> : <ScheduleExecutions runs={${JSON.stringify([run])}} jobs={[]} loading={false} unavailable={false} selectedId={selectedId} onSelect={onSelect}/>}
        </div>
      </main>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    [data],
  );
  try {
    await page.addStyleTag({
      content:
        resolveCssImports(resolve(import.meta.dirname, '../index.css')) +
        resolveCssImports(
          resolve(import.meta.dirname, '../views/ScheduleView.css'),
        ),
    });
    const out = resolve('.kontourai/schedule-operator-315-174');
    mkdirSync(out, { recursive: true });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme,
        );
        await page.getByRole('tab', { name: 'Calendar' }).click();
        await page
          .getByRole('combobox', { name: 'Display time zone' })
          .selectOption('America/New_York');
        await page.getByText('Daily check', { exact: false }).waitFor();
        const week = page.getByRole('region', { name: 'Weekly schedule' });
        expect(
          await week.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `${out}/calendar-${width}-${theme}.png`,
        });
        expect(await week.getByText('None scheduled').count()).toBe(6);
        await page
          .getByRole('combobox', { name: 'Display time zone' })
          .selectOption('Pacific/Kiritimati');
        await week
          .getByText('Some frequent schedules have additional occurrences.')
          .waitFor();
        expect(await week.getByText('None scheduled').count()).toBe(0);
        expect(await week.locator('time').count()).toBe(56);
        await page.getByRole('tab', { name: 'Calendar' }).press('ArrowRight');
        await page.getByRole('tab', { name: 'Executions' }).press('Enter');
        await page.getByRole('button', { name: 'View run for daily' }).click();
        const receipt = page.getByRole('region', {
          name: 'Selected run details',
        });
        await receipt.getByText('failed · Attempt 2').waitFor();
        expect(
          await receipt.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
        await page.screenshot({
          path: `${out}/executions-${width}-${theme}.png`,
        });
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
