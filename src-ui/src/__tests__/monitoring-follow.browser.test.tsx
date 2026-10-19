import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const feeds: Plugin = {
  name: 'monitoring-feed',
  setup(builder) {
    const modules: Record<string, string> = {
      '@kontourai/station-sdk':
        'export const useOrchestrationSessionsQuery=()=>({data:[],status:"success"});',
      ModelsContext: 'export const useModels=()=>[];',
      useCopyToClipboardToast:
        'export const useCopyToClipboardToast=()=>()=>{};',
      MonitoringContext: `import {useState} from 'react';
        const initial=Array.from({length:40},(_,i)=>({id:String(i),'gen_ai.operation.name':'invoke_agent','span.kind':'start'}));
        export const monitoringEventIdentity=e=>e.id;
        const noop=()=>{};
        export function useMonitoring(){const [events,setEvents]=useState(initial);window.arrive=()=>setEvents(old=>[...old,{...initial[0],id:String(old.length)}]);return {events,stats:{agents:[]},setTimeRange:noop,clearEvents:noop,connectionStatus:'connected',isLoading:false}};`,
      EventEntry:
        'export const EventEntry=({event})=><div style={{height:40}}>{event.id}</div>;',
    };
    for (const name of [
      'FleetReceipts',
      'MonitoringLogControls',
      'MonitoringTimeControls',
      'ContextDiagnostics',
      'MonitoringActiveFilters',
      'MonitoringHeader',
      'MonitoringSidebar',
      'SessionDiagnostics',
      'ToolLatencyPanel',
      'UsageRollupPanel',
      'StationUsagePanel',
    ]) {
      modules[name === 'FleetReceipts' ? 'FleetRoutingReceipts' : name] =
        `export const ${name}=()=>null;`;
    }
    builder.onResolve({ filter: /./ }, (args) => {
      const key =
        args.path === '@kontourai/station-sdk'
          ? args.path
          : args.path.split('/').at(-1)!;
      return key in modules ? { path: key, namespace: 'feed' } : undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: 'feed' }, (args) => ({
      contents: modules[args.path],
      resolveDir: process.cwd(),
      loader: 'tsx',
    }));
  },
};

test('Monitoring auto follow scrolls its log box without moving the surrounding page', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {MonitoringViewWithBoundary} from './src-ui/src/views/MonitoringView';
    createRoot(document.getElementById('root')).render(<><button onClick={()=>window.arrive()}>Arrive</button><div id="outer" style={{height:300,overflow:'auto'}}><div style={{paddingTop:180,paddingBottom:500}}><MonitoringViewWithBoundary/></div></div></>);
  `,
    [feeds],
  );
  try {
    await page.addStyleTag({
      content:
        '.log-stream{height:200px!important;max-height:200px!important;overflow:auto!important;flex:none!important}.monitoring-page{height:auto!important;overflow:visible!important}.monitoring-page__panel{overflow:visible!important}',
    });
    await page.waitForSelector('.log-stream');
    expect(errors).toEqual([]);
    await page.waitForTimeout(400);
    await page.locator('#outer').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.getByRole('button', { name: 'Arrive', exact: true }).click();
    await page.waitForTimeout(400);
    expect(
      await page
        .locator('.log-stream')
        .evaluate(
          (element) =>
            element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
    ).toBeLessThanOrEqual(1);
    expect(
      await page.locator('#outer').evaluate((element) => element.scrollTop),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
