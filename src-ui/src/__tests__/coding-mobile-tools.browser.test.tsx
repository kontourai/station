import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const occupants: Plugin = {
  name: 'coding-tool-occupants',
  setup(builder) {
    const modules: Record<string, string> = {
      ChatDock: `import React from 'react'; export const ChatWorkspacePane=()=> <div style={{padding:16}}><h2>Build the workspace</h2><p>Chat and tools keep their own state.</p><textarea aria-label="Message" placeholder="Message your agent" /></div>;`,
      KeyboardShortcutsContext:
        'export const useKeyboardShortcuts=()=>({isMac:false});',
      useKeyboardShortcut: 'export const useKeyboardShortcut=()=>{};',
      useShowSurface: 'export const useShowSurface=()=>()=>{};',
    };
    builder.onResolve({ filter: /./ }, (args) => {
      const key = args.path.split('/').at(-1)!;
      return key in modules ? { path: key, namespace: 'occupants' } : undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: 'occupants' }, (args) => ({
      contents: modules[args.path],
      loader: 'tsx',
      resolveDir: process.cwd(),
    }));
  },
};

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
import {DialogHistoryHostBoundary} from './src-ui/src/components/DialogHistoryHost';
import {navigationStore} from './src-ui/src/contexts/navigation-store';
import {CodingWorkbench} from './src-ui/src/components/coding-layout/CodingWorkbench';
import {useCodingWide} from './src-ui/src/components/coding-layout/codingPanels';
import {useCodingStackSelection,resolveCodingStackLocation} from './src-ui/src/components/coding-layout/codingStackPage';
import {createWorkspaceCodingFileBrowserPaneInstance,createWorkspaceCodingTerminalPaneInstance} from '@kontourai/station-contracts/workspace-coding-panels';
import {ToolControls} from './src-ui/src/components/ToolControls';
const files=createWorkspaceCodingFileBrowserPaneInstance('demo');
const terminal=createWorkspaceCodingTerminalPaneInstance('demo');
const instances=[files,terminal];
const scope={kind:'project',projectId:'demo',layoutId:'coding'};
navigationStore.navigate('/projects/demo/layouts/coding');
function App(){const selection=useCodingStackSelection();const wide=useCodingWide();
return <div style={{height:'100dvh',display:'flex',flexDirection:'column'}}><CodingWorkbench projectId="demo" projectSlug="demo" stackName="Coding" drillInOrder={[]} centerChat wide={wide} location={resolveCodingStackLocation(scope,instances,selection.pane,selection.paneScope)} scope={scope} instances={instances} hostDocument={()=>null} paneLabel={i=>i===files?'Files':'Terminal'} hostOpen={null} onOpenCatalog={()=>{}}><div style={{height:'100%',overflow:'auto',padding:16}}><ToolControls><label>Find in file <input aria-label="Find in file" /></label></ToolControls><pre>{Array.from({length:100},(_,i)=>'Line '+(i+1)).join('\\n')}</pre></div></CodingWorkbench></div>;
}
createRoot(document.getElementById('root')).render(<NavigationProvider><DialogHistoryHostBoundary><App/></DialogHistoryHostBoundary></NavigationProvider>);
`;

for (const theme of ['dark', 'light']) {
  test(`tool navigation and local floating controls in ${theme}`, async () => {
    const { browser, page, errors } = await scrollBrowserFixture(fixture, [
      occupants,
    ]);
    try {
      await page.addStyleTag({
        content: resolveCssImports(
          resolve(import.meta.dirname, '../index.css'),
        ),
      });
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      const out = resolve('.kontourai/mobile-tools');
      mkdirSync(out, { recursive: true });
      const trigger = page.getByRole('button', {
        name: 'Switch tool, current: Chat',
      });
      await trigger.waitFor();
      await page
        .getByRole('textbox', { name: 'Message' })
        .fill('Keep this draft');
      await page.screenshot({ path: `${out}/phone-${theme}.png` });
      const target = await trigger.boundingBox();
      expect(target!.height).toBeGreaterThanOrEqual(44);
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Tools' });
      await dialog.waitFor();
      await page.evaluate(() =>
        Promise.all(
          document.getAnimations().map((animation) => animation.finished),
        ),
      );
      const sheet = await dialog.boundingBox();
      expect(sheet!.y + sheet!.height).toBeGreaterThan(800);
      await page.screenshot({ path: `${out}/picker-${theme}.png` });
      await page.getByRole('button', { name: 'Files', exact: true }).click();
      await page
        .getByRole('button', { name: 'Switch tool, current: Files' })
        .waitFor();
      expect(await dialog.count()).toBe(0);
      const room = await page.locator('.coding-workbench__main').boundingBox();
      expect(room!.width).toBe(390);
      const control = page.getByRole('textbox', { name: 'Find in file' });
      await control.fill('needle');
      await page
        .locator('.coding-workbench__page--drill-in > div')
        .evaluate((element) => {
          element.scrollTop = 700;
        });
      const floating = await page.locator('.tool-controls').boundingBox();
      const tool = await page
        .locator('.coding-workbench__page--drill-in')
        .boundingBox();
      expect(floating!.y).toBeGreaterThanOrEqual(tool!.y);
      expect(floating!.y + floating!.height).toBeLessThanOrEqual(
        tool!.y + tool!.height,
      );
      await page.screenshot({ path: `${out}/file-${theme}.png` });
      await page
        .getByRole('button', { name: 'Switch tool, current: Files' })
        .click();
      await page
        .getByRole('dialog', { name: 'Tools' })
        .getByRole('button', { name: 'Chat', exact: true })
        .click();
      await page.getByRole('textbox', { name: 'Message' }).waitFor();
      expect(
        await page.getByRole('textbox', { name: 'Message' }).inputValue(),
      ).toBe('Keep this draft');
      await trigger.click();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await expect
        .poll(() =>
          trigger.evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('navigation', { name: 'Views' }).waitFor();
      expect(await trigger.count()).toBe(0);
      await page.screenshot({ path: `${out}/desktop-${theme}.png` });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 30000);
}
