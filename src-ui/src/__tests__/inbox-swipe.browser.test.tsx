import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const projectArtwork = `data:image/png;base64,${readFileSync(resolve('src-ui/public/favicon.png')).toString('base64')}`;
const fixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
  import {ChatDockInboxPanel} from './src-ui/src/components/chat-dock/ChatDockInboxPanel';
  import {MobileInboxPanel} from './src-ui/src/components/chat-dock/MobileInboxPanel';
  import {deviceSettingsStore} from './src-ui/src/lib/device-settings-store';
  import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
  import {ToastProvider} from './src-ui/src/contexts/ToastContext';
  import {NotificationContainer} from './src-ui/src/components/notifications/NotificationContainer';
  const items = [
    {id:'saved', kind:'orchestration', kindLabel:'Conversation', title:'Review the inbox', projectSlug:'station', projectLabel:'Station', agentSlug:'codex', agentLabel:'Codex', provider:'codex', executionProviders:['codex','claude','pi','kiro'], modelLabel:'GPT', updatedAt:Date.now(), lifecycleLabel:'Running'},
    {id:'idle', kind:'orchestration', kindLabel:'Conversation', title:'Plan the next release', projectSlug:'station', projectLabel:'Station', agentSlug:'claude', agentLabel:'Claude', provider:'claude', modelLabel:'Sonnet', updatedAt:Date.now(), lifecycleLabel:'Ready'},
  ];
  let root;
  window.mount = (preview, mobile) => {
    root?.unmount();
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
    deviceSettingsStore.set('developerToolsEnabled', preview);
    deviceSettingsStore.set('experimentalSheetGesturesEnabled', preview);
    document.body.dataset.theme = document.documentElement.dataset.theme;
    window.opens = 0; window.closes = 0;
    const props = { agents:[{slug:'codex',name:'Codex',engineId:'codex'},{slug:'claude',name:'Claude',engineId:'claude'}], projectIconBySlug:new Map([['station',${JSON.stringify(projectArtwork)}]]), activeChatSessionId:null, openChatSessionIds:[], onFocusChat:()=>window.opens++, onOpenConversation:()=>{window.opens++;return true}, onOpenSession:()=>window.opens++, onCloseChat:()=>window.closes++ };
    root = createRoot(document.getElementById('root'));
    // Dismissal Undo is a toast action (#4377), so the host renders toasts.
    root.render(<QueryClientProvider client={new QueryClient()}><NavigationProvider><ToastProvider>
      <NotificationContainer/>
      {mobile ? <MobileInboxPanel {...props} open tasks={items} triggerRef={React.createRef()}  onClose={()=>{}} /> : <div style={{width:340}}><ChatDockInboxPanel {...props} items={items} onOpenHistory={()=>{}} /></div>}
    </ToastProvider></NavigationProvider></QueryClientProvider>);
  };
`;

const scopeStub: Plugin = {
  name: 'inbox-no-remote-detail-reads',
  setup(build) {
    build.onResolve({ filter: /ApiBaseContext$/ }, async (args) => {
      if (args.pluginData?.real) return;
      const real = await build.resolve(args.path, {
        resolveDir: args.resolveDir,
        kind: args.kind,
        pluginData: { real: true },
      });
      return { path: real.path, namespace: 'inbox-scope-stub' };
    });
    build.onLoad({ filter: /.*/, namespace: 'inbox-scope-stub' }, (args) => ({
      contents: `export * from ${JSON.stringify(args.path)}; export const useHostRequestAuthorityScope = () => null;`,
      loader: 'tsx',
      resolveDir: dirname(args.path),
    }));
  },
};

async function swipe(cdp: CDPSession, page: Page, dx: number, dy = 0) {
  const row = page.getByRole('button', {
    name: 'Review the inbox, Station',
    exact: true,
  });
  const box = await row.boundingBox();
  if (!box) throw new Error('Inbox row did not render');
  const x = Math.max(box.x + 30, Math.min(box.x + box.width - 30, 230));
  const y = box.y + box.height / 2;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  for (let step = 1; step <= 5; step++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * step) / 5, y: y + (dy * step) / 5 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });
}

async function mount(page: Page, preview: boolean, mobile = true) {
  await page.evaluate(
    ({ preview, mobile }) => {
      (
        window as unknown as {
          mount: (preview: boolean, mobile: boolean) => void;
        }
      ).mount(preview, mobile);
    },
    { preview, mobile },
  );
  await page
    .getByRole('button', { name: 'Review the inbox, Station', exact: true })
    .waitFor();
}

test('mobile swipes reveal existing actions without opening or stopping a conversation; desktop retains hover controls', async () => {
  const { page, browser, errors } = await scrollBrowserFixture(fixture, [
    scopeStub,
  ]);
  try {
    const css = ['src-ui/src/index.css', 'src-ui/src/components/chat/chat.css']
      .map((path) => resolveCssImports(resolve(path)))
      .join('\n');
    await page.addStyleTag({ content: css });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await mount(page, true);
    await swipe(cdp, page, -90);
    const rail = page.locator('.inbox-row__swipe-actions').first();
    await rail.waitFor({ state: 'visible' });
    for (const button of await rail.getByRole('button').all()) {
      const box = await button.boundingBox();
      expect(box && box.width >= 44 && box.height >= 44).toBe(true);
    }
    expect(
      await page.evaluate(() => (window as unknown as { opens: number }).opens),
    ).toBe(0);
    await rail
      .getByRole('button', { name: 'Dismiss Review the inbox from inbox' })
      .click();
    await page
      .getByRole('button', { name: 'Review the inbox, Station', exact: true })
      .waitFor({ state: 'hidden' });
    expect(
      await page.evaluate(
        () => (window as unknown as { closes: number }).closes,
      ),
    ).toBe(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page
      .getByRole('button', { name: 'Review the inbox, Station', exact: true })
      .waitFor();

    await swipe(cdp, page, -90);
    await rail
      .getByRole('button', { name: 'Snooze Review the inbox', exact: true })
      .click();
    await page.getByRole('menuitem', { name: '1 hour', exact: true }).click();
    await page.getByRole('button', { name: 'Snoozed · 1' }).click();
    expect(
      await page
        .getByRole('region', { name: /Snoozed/ })
        .getByRole('button', { name: 'Review the inbox, Station', exact: true })
        .count(),
    ).toBe(1);

    await mount(page, true);
    await swipe(cdp, page, 0, -80);
    expect(
      await page.locator('.inbox-row__swipe-actions:visible').count(),
    ).toBe(0);
    await mount(page, false);
    await swipe(cdp, page, -90);
    expect(await page.locator('.inbox-row__swipe-actions').count()).toBe(0);
    await page
      .getByRole('button', { name: 'Details for Review the inbox' })
      .click();
    await page
      .getByRole('button', { name: 'Dismiss from inbox', exact: true })
      .click();
    await page.getByRole('button', { name: /Dismissed/ }).click();
    await page
      .getByRole('button', { name: 'Details for Review the inbox' })
      .click();
    await page
      .getByRole('button', { name: 'Restore to inbox', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Review the inbox, Station', exact: true })
      .waitFor();

    const artifacts = resolve('.surface/inbox-dismiss-swipe');
    await mkdir(artifacts, { recursive: true });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const mobile = width === 390;
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
      for (const theme of ['dark', 'light']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await mount(page, true, mobile);
        await page
          .locator('[data-testid="identity-marks"] svg')
          .first()
          .waitFor();
        await page.screenshot({
          path: resolve(artifacts, `inbox-${width}-${theme}.png`),
          fullPage: true,
          animations: 'disabled',
        });
        if (mobile) await swipe(cdp, page, -90);
        else {
          await page.mouse.move(1300, 850);
          await page.evaluate(() => {
            if (document.activeElement instanceof HTMLElement)
              document.activeElement.blur();
          });
          const dismiss = page.getByRole('button', {
            name: 'Dismiss Review the inbox from inbox',
          });
          expect(
            await dismiss.evaluate((el) =>
              el.closest('.inbox-row')?.classList.contains('inbox-row--hover'),
            ),
          ).toBe(true);
          expect(
            await dismiss.evaluate(
              (el) => getComputedStyle(el.parentElement!).opacity,
            ),
          ).toBe('0');
          await page
            .getByRole('button', {
              name: 'Review the inbox, Station',
              exact: true,
            })
            .hover();
          await dismiss.waitFor({ state: 'visible' });
          expect(
            await dismiss.evaluate(
              (el) => getComputedStyle(el.parentElement!).opacity,
            ),
          ).toBe('1');
        }
        await page.screenshot({
          path: resolve(artifacts, `${width}-${theme}.png`),
          fullPage: true,
          animations: 'disabled',
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
        ).toBe(false);
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 90_000);
