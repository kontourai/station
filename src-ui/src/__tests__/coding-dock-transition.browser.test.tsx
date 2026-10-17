import { resolve } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const navigation: Plugin = {
  name: 'coding-navigation',
  setup(builder) {
    const modules: Record<string, string> = {
      NavigationContext:
        'export const useNavigation=()=>({setDockState:window.setDockState,updateParams(){}});',
      BrowserPreviewPaneLauncher:
        'export const BrowserPreviewPaneLauncher=()=>null;',
    };
    builder.onResolve({ filter: /./ }, (args) => {
      const key = args.path.split('/').at(-1)!;
      return key in modules
        ? { path: key, namespace: 'navigation' }
        : undefined;
    });
    builder.onLoad({ filter: /.*/, namespace: 'navigation' }, (args) => ({
      contents: modules[args.path],
    }));
  },
};

test('Coding mobile ownership opens and closes the dock without an intermediate animated height', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(
    `
    import React,{useState,useCallback} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useCodingChatPositionEffects} from './src-ui/src/workspace-panes/CodingChatPane';
    function Position(){useCodingChatPositionEffects({projectId:'demo',projectSlug:'demo',paneHostOpen:null,ownsMobileDock:true});return null;}
    function App(){const [open,setOpen]=useState(false),[height,setHeight]=useState(64);
      window.setDockState=useCallback(value=>setHeight(value?600:64),[]);
      return <><button onClick={()=>setOpen(v=>!v)}>Visit Chat</button><section id="chat-dock" className="chat-dock" style={{height,position:'relative',width:390}}/>{open&&<Position/>}</>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    [navigation],
  );
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    await page.waitForSelector('#chat-dock');
    const sample = () =>
      page.locator('#chat-dock').evaluate(
        (element) =>
          new Promise<number[]>((resolve) => {
            const heights: number[] = [];
            const frame = () => {
              heights.push(element.getBoundingClientRect().height);
              if (heights.length < 16) requestAnimationFrame(frame);
              else resolve(heights);
            };
            frame();
          }),
      );
    await page.getByRole('button', { name: 'Visit Chat', exact: true }).click();
    expect(await sample()).toEqual(Array(16).fill(600));
    await page.getByRole('button', { name: 'Visit Chat', exact: true }).click();
    expect(await sample()).toEqual(Array(16).fill(64));
    expect(
      await page
        .locator('#chat-dock')
        .evaluate((element) =>
          element.style.getPropertyValue('--dock-transition'),
        ),
    ).toBe('');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
