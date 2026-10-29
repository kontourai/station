import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';

const ROOT = resolve(import.meta.dirname, '../../..');
const ORIGIN = 'http://station.test';

declare global {
  interface Window {
    startupFixture: {
      ready(): void;
      wait(): void;
      fail(): void;
      admit(): void;
      nativeReads: number;
      glyphs: number[];
    };
  }
}

describe('cold-launch presentation in the browser', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let javascript: string;
  let css: string;
  beforeAll(async () => {
    browser = await chromium.launch();
    const bundled = await build({
      stdin: {
        resolveDir: ROOT,
        loader: 'tsx',
        contents: `
          import React, {StrictMode, useState} from 'react';
          import {createRoot} from 'react-dom/client';
          import {createPortal} from 'react-dom';
          import {flushSync} from 'react-dom';
          import {StartupHandoff} from './src-ui/src/components/StartupHandoff';
          import {StartupScreen} from './src-ui/src/components/StartupScreen';
          import {SplitPaneLayout} from './src-ui/src/components/SplitPaneLayout';
          import {observeInitialStartupVisibility} from './src-ui/src/platform/native/startupPresentation';
          let admitted = new URL(location.href).searchParams.get('native') !== 'covered';
          const fixture = window.startupFixture = {nativeReads: 0, glyphs: [], admit(){admitted = true}};
          window.fixtureAdapter = {
            platform: new URL(location.href).searchParams.has('native') ? 'tauri' : 'web',
            async getCapabilityReport(){return {status:'ok',value:{platform:'macos'}}},
            async isStartupWindowAdmitted(){fixture.nativeReads++; return {status:'ok',value:admitted}}
          };
          observeInitialStartupVisibility();
          const paint = CanvasRenderingContext2D.prototype.fillText;
          CanvasRenderingContext2D.prototype.fillText = function(...args){
            if(args[0] === 'tation') fixture.glyphs.push(this.globalAlpha);
            return paint.apply(this,args);
          };
          function App(){
            const [phase,setPhase] = useState(new URL(location.href).searchParams.has('fast') ? 'ready' : 'waiting');
            fixture.ready = () => flushSync(() => setPhase('ready'));
            fixture.wait = () => flushSync(() => setPhase('waiting'));
            fixture.fail = () => flushSync(() => setPhase('failed'));
            return <><StartupHandoff/>{phase === 'waiting' ? <StartupScreen message="Preparing this device"/> : phase === 'failed' ? <div role="alert"><button>Reload Station</button></div> : new URL(location.href).searchParams.has('sheet') ? <SplitPaneLayout label="agents" title="Agents" items={[]} selectedId="new" onSelect={()=>{}} onSearch={()=>{}} onDeselect={fixture.wait} unselectedDetailOpen><h3>New agent</h3></SplitPaneLayout> : <><button onClick={fixture.wait}>Ready workspace</button>{createPortal(<button id="portal-action" style={{position:'fixed',inset:0,zIndex:10000}} onClick={fixture.wait}>Portal action</button>,document.body)}</>}</>;
          }
          flushSync(() => createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>));
        `,
      },
      bundle: true,
      format: 'esm',
      jsx: 'automatic',
      write: false,
      outdir: '/virtual',
      define: { 'process.env.NODE_ENV': '"development"' },
      plugins: [
        {
          name: 'native-host-fixture',
          setup(builder) {
            builder.onResolve(
              { filter: /\/contexts\/NavigationContext$/ },
              () => ({
                path: 'navigation',
                namespace: 'fixture',
              }),
            );
            builder.onResolve({ filter: /^\.\/index$/ }, (args) =>
              args.importer.endsWith('/native/startupPresentation.ts')
                ? { path: 'native-host', namespace: 'fixture' }
                : undefined,
            );
            builder.onLoad(
              { filter: /^navigation$/, namespace: 'fixture' },
              () => ({
                contents:
                  'export const useNavigationActions = () => ({navigate(){}});',
              }),
            );
            builder.onLoad(
              { filter: /^native-host$/, namespace: 'fixture' },
              () => ({
                contents:
                  'export const nativePlatformPromise = Promise.resolve().then(() => window.fixtureAdapter);',
              }),
            );
          },
        },
      ],
    });
    javascript = bundled.outputFiles.find((file) =>
      file.path.endsWith('.js'),
    )!.text;
    css =
      resolveCssImports(
        resolve(ROOT, 'src-ui/src/components/startup-screen.css'),
      ) +
      (bundled.outputFiles.find((file) => file.path.endsWith('.css'))?.text ??
        '') +
      '#root {display:flex;height:100vh;}';
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function open({ query = '', reduced = false, mobile = false } = {}) {
    const page = await browser.newPage({
      reducedMotion: reduced ? 'reduce' : 'no-preference',
      viewport: mobile ? { width: 390, height: 844 } : undefined,
    });
    const epoch = new Date('2026-10-15T00:00:00Z');
    await page.clock.install({ time: epoch });
    await page.clock.pauseAt(epoch);
    const html = readFileSync(
      resolve(ROOT, 'src-ui/index.html'),
      'utf8',
    ).replace('/src/boot.ts', '/fixture.js');
    const fontErrors: string[] = [];
    await page.route(`${ORIGIN}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/')
        return route.fulfill({ contentType: 'text/html', body: html });
      if (path === '/fixture.js')
        return route.fulfill({
          contentType: 'text/javascript',
          body: javascript,
        });
      if (path.endsWith('.css'))
        return route.fulfill({ contentType: 'text/css', body: css });
      if (path.endsWith('.woff2')) {
        const fontPath = path.startsWith('/fonts/')
          ? resolve(ROOT, 'src-ui/public', path.slice(1))
          : resolve(
              ROOT,
              'node_modules/@kontourai/ui/tokens/fonts',
              basename(path),
            );
        let body: Buffer;
        try {
          body = readFileSync(fontPath);
        } catch (error) {
          fontErrors.push(
            `Cannot load startup fixture font ${route.request().url()} from ${fontPath}: ${error}`,
          );
          return route.abort('failed');
        }
        return route.fulfill({ contentType: 'font/woff2', body });
      }
      if (path === '/startup-theme.js' || path.startsWith('/favicon'))
        return route.fulfill({
          body: readFileSync(resolve(ROOT, 'src-ui/public', path.slice(1))),
        });
      throw new Error(`Unexpected startup fixture resource: ${path}`);
    });
    await page.goto(`${ORIGIN}/${query}`);
    await page.waitForFunction(
      () => window.startupFixture?.ready !== undefined,
    );
    await page.evaluate(() => document.fonts.ready);
    if (fontErrors.length > 0) {
      await page.close();
      throw new Error(fontErrors.join('\n'));
    }
    return page;
  }

  const intro = (page: Page) =>
    page.locator('.station-startup-frame[open] > .station-startup');

  test('the shared presentation imports without browser globals', async () => {
    expect(typeof globalThis.document).toBe('undefined');
    const presentation = await import('../lib/startup-presentation');
    expect(presentation.initialStartupIsActive()).toBe(false);
  });

  test('a mobile detail opened behind the intro receives its initial keyboard focus after handoff', async () => {
    const page = await open({ query: '?sheet', mobile: true });
    try {
      await page.clock.runFor(100);
      await page.evaluate(() => window.startupFixture.ready());
      await page.clock.runFor(1100);
      expect(await intro(page).count()).toBe(0);
      expect(
        await page.getByRole('heading', { name: 'New agent' }).count(),
      ).toBe(1);
      const back = page.getByRole('button', { name: '← Back to list' });
      expect(await back.count()).toBe(1);
      expect(
        await back.evaluate((button) => button === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('Enter');
      expect(
        await page
          .getByRole('status', { name: 'Preparing this device' })
          .count(),
      ).toBe(1);
    } finally {
      await page.close();
    }
  });

  test('a visible intro completes the word before a brief fade, without waiting for loading effects', async () => {
    const page = await open();
    try {
      await page.clock.runFor(100);
      expect(
        await intro(page).locator('canvas').getAttribute('data-ready'),
      ).toBe('true');
      await page.evaluate(() => window.startupFixture.ready());
      await page.clock.runFor(700);
      expect(await intro(page).count()).toBe(1);
      expect(
        await page.evaluate(
          () =>
            document
              .elementFromPoint(innerWidth / 2, innerHeight / 2)
              ?.closest('.station-startup') !== null,
        ),
      ).toBe(true);
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id)).not.toBe(
        'portal-action',
      );
      expect(
        await page
          .locator('#root')
          .evaluate((root) => root instanceof HTMLElement && root.inert),
      ).toBe(true);
      await page.clock.runFor(250);
      expect(await intro(page).getAttribute('class')).toContain(
        'station-startup--leaving',
      );
      expect(
        await page.evaluate(() => window.startupFixture.glyphs.slice(-6)),
      ).toEqual([1, 1, 1, 1, 1, 1]);
      await page.clock.runFor(170);
      expect(await intro(page).count()).toBe(0);
      expect(
        await page
          .locator('#root')
          .evaluate((root) => root instanceof HTMLElement && root.inert),
      ).toBe(false);
      await page.getByRole('button', { name: 'Portal action' }).click();
      expect(await intro(page).count()).toBe(0);
      expect(
        await page
          .getByRole('status', { name: 'Preparing this device' })
          .count(),
      ).toBe(1);
    } finally {
      await page.close();
    }
  });

  test.each([false, true])(
    'a ready app skips an unseen intro, reduced motion=%s',
    async (reduced) => {
      const page = await open({ query: '?fast', reduced });
      try {
        expect(await intro(page).count()).toBe(0);
        expect(
          await page.getByRole('button', { name: 'Ready workspace' }).count(),
        ).toBe(1);
        expect(
          await page
            .locator('#root')
            .evaluate((root) => root instanceof HTMLElement && root.inert),
        ).toBe(false);
      } finally {
        await page.close();
      }
    },
  );

  test('slow loading can continue indefinitely, but readiness after the intro exits immediately', async () => {
    const page = await open();
    try {
      await page.clock.runFor(3500);
      expect(await intro(page).count()).toBe(1);
      await page.evaluate(() => window.startupFixture.ready());
      await page.clock.runFor(170);
      expect(await intro(page).count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  test('reduced motion and startup recovery do not wait for a running intro', async () => {
    for (const failure of [false, true]) {
      const page = await open({ reduced: !failure });
      try {
        await page.clock.runFor(100);
        await page.evaluate(
          (failed) =>
            failed
              ? window.startupFixture.fail()
              : window.startupFixture.ready(),
          failure,
        );
        expect(await intro(page).count()).toBe(0);
        expect(
          await page
            .locator('#root')
            .evaluate((root) => root instanceof HTMLElement && root.inert),
        ).toBe(false);
        if (failure)
          expect(
            await page.getByRole('button', { name: 'Reload Station' }).count(),
          ).toBe(1);
      } finally {
        await page.close();
      }
    }
  });

  test('time behind the native startup cover does not consume the visible intro', async () => {
    const page = await open({ query: '?native=covered' });
    try {
      await page.clock.runFor(5000);
      expect(
        await intro(page).locator('canvas').getAttribute('data-ready'),
      ).toBeNull();
      expect(
        await page.evaluate(() => window.startupFixture.nativeReads),
      ).toBeGreaterThan(1);
      await page.evaluate(() => window.startupFixture.admit());
      await page.clock.runFor(150);
      await page.evaluate(() => window.startupFixture.ready());
      await page.clock.runFor(700);
      expect(await intro(page).count()).toBe(1);
      await page.clock.runFor(450);
      expect(await intro(page).count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  test('a ready native window skips the unseen intro and stops checking admission', async () => {
    const page = await open({ query: '?native=covered&fast' });
    try {
      expect(await intro(page).count()).toBe(0);
      const reads = await page.evaluate(
        () => window.startupFixture.nativeReads,
      );
      await page.clock.runFor(5000);
      expect(await page.evaluate(() => window.startupFixture.nativeReads)).toBe(
        reads,
      );
    } finally {
      await page.close();
    }
  });
});
