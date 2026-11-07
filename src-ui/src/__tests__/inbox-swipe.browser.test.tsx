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

const discardFixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
  import {InboxRow} from './src-ui/src/components/chat-dock/ChatDockInboxRows';
  import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
  const draft = {
    id:'draft', kind:'orchestration', kindLabel:'Conversation',
    orchestrationThreadId:'draft-thread', conversationId:'draft-conversation',
    title:'Review draft before sending', projectSlug:'station', projectLabel:'Station',
    agentSlug:'codex', agentLabel:'Codex', provider:'codex',
    updatedAt:Date.now(), lifecycleLabel:'Draft',
  };
  window.fixtureRequestScope = {apiBase:'', authorityKey:'discard-fixture', isCurrent:()=>true};
  let root;
  window.mountDiscard = (inDetails) => {
    root?.unmount();
    window.discarded = 0;
    document.body.dataset.theme = document.documentElement.dataset.theme;
    root = createRoot(document.getElementById('root'));
    root.render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
      <NavigationProvider><main style={{padding:12}}>
        <InboxRow item={draft} now={Date.now()} chrome="touch" actionsInDetails={inDetails}
          isCurrent={false} isSnoozed={false} isOpenChat={false} onActivate={()=>{}}
          onDraftDiscarded={()=>window.discarded++}/>
      </main></NavigationProvider>
    </QueryClientProvider>);
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
      contents: `export * from ${JSON.stringify(args.path)}; export const useHostRequestAuthorityScope = () => window.fixtureRequestScope ?? null;`,
      loader: 'tsx',
      resolveDir: dirname(args.path),
    }));
  },
};

async function swipe(
  cdp: CDPSession,
  page: Page,
  dx: number,
  dy = 0,
  {
    name = 'Review the inbox, Station',
    during,
    cancel = false,
  }: {
    name?: string;
    during?: () => Promise<void>;
    cancel?: boolean;
  } = {},
) {
  const row = page.getByRole('button', {
    name,
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
  await during?.();
  await cdp.send('Input.dispatchTouchEvent', {
    type: cancel ? 'touchCancel' : 'touchEnd',
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
    // A plain-HTTP LAN origin: the dismissal toast must work without Web
    // Crypto's secure-context-only randomUUID.
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await mount(page, true);
    const row = page.getByRole('button', {
      name: 'Review the inbox, Station',
      exact: true,
    });
    const resting = await row.boundingBox();
    if (!resting) throw new Error('Inbox row did not render');
    await swipe(cdp, page, -90, 0, {
      during: async () => {
        await expect
          .poll(async () => (await row.boundingBox())?.x)
          .toBeCloseTo(resting.x - 90, 1);
        expect(
          await row.evaluate(
            (element) => getComputedStyle(element).transitionDuration,
          ),
        ).toBe('0s');
        expect(
          await page
            .locator('.inbox-row__swipe-actions')
            .first()
            .evaluate(
              (element) => element instanceof HTMLElement && element.inert,
            ),
        ).toBe(true);
      },
    });
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
      .getByRole('button', { name: 'Snooze Review the inbox', exact: true })
      .focus();
    await page.keyboard.press('Escape');
    expect(
      await row.evaluate((element) => document.activeElement === element),
    ).toBe(true);
    await rail.waitFor({ state: 'hidden' });
    await swipe(cdp, page, -90);
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
    await swipe(cdp, page, -90);
    await swipe(cdp, page, -90, 0, {
      name: 'Plan the next release, Station',
    });
    expect(await page.locator('.inbox-row--swiped').count()).toBe(1);
    expect(
      await page
        .locator('.inbox-row--swiped')
        .getByRole('button', {
          name: 'Plan the next release, Station',
          exact: true,
        })
        .count(),
    ).toBe(1);
    await page.getByRole('button', { name: 'Search inbox' }).focus();
    await expect
      .poll(() => page.locator('.inbox-row__swipe-actions:visible').count())
      .toBe(0);

    await swipe(cdp, page, -75, 0, { cancel: true });
    expect(
      await page.locator('.inbox-row__swipe-actions:visible').count(),
    ).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { opens: number }).opens),
    ).toBe(0);

    await swipe(cdp, page, 0, -80);
    expect(
      await page.locator('.inbox-row__swipe-actions:visible').count(),
    ).toBe(0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await swipe(cdp, page, -90);
    expect(
      await row.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).transitionDuration),
      ),
    ).toBeLessThan(0.001);
    expect(
      await row.evaluate((element) => getComputedStyle(element).opacity),
    ).toBe('1');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await mount(page, false);
    await swipe(cdp, page, -90);
    expect(await page.locator('.inbox-row__swipe-actions').count()).toBe(0);
    await page
      .getByRole('button', { name: 'Details for Review the inbox' })
      .click();
    await page
      .getByRole('button', { name: 'Dismiss from inbox', exact: true })
      .click();
    await page.getByRole('button', { name: 'Search inbox' }).click();
    await page.getByRole('searchbox').fill('Review the inbox');
    await page.getByRole('region', { name: /Dismissed/ }).waitFor();
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

test('draft discard offers a reachable Undo without overflow in touch rows and details sheets', async () => {
  const { page, browser, errors } = await scrollBrowserFixture(discardFixture, [
    scopeStub,
  ]);
  let commands = 0;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/orchestration/commands'
    )
      commands += 1;
  });
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve('src-ui/src/index.css')),
    });
    const artifacts = resolve('.surface/inbox-dismiss-swipe');
    await mkdir(artifacts, { recursive: true });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ['dark', 'light']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        for (const inDetails of [false, true]) {
          await page.evaluate((inDetails) => {
            const mountDiscard = Reflect.get(window, 'mountDiscard');
            mountDiscard(inDetails);
          }, inDetails);
          if (inDetails) {
            await page
              .getByRole('button', {
                name: 'Details for Review draft before sending',
              })
              .click();
          }
          const discard = page.getByRole('button', {
            name: 'Discard draft Review draft before sending',
            exact: true,
          });
          await discard.click();
          await page
            .getByText('Draft will be discarded', { exact: true })
            .waitFor();
          const undo = page.getByRole('button', {
            name: 'Undo discard of Review draft before sending',
            exact: true,
          });
          const target = await undo.boundingBox();
          expect(target).not.toBeNull();
          expect(target!.width).toBeGreaterThanOrEqual(44);
          expect(target!.height).toBeGreaterThanOrEqual(44);
          expect(target!.x).toBeGreaterThanOrEqual(0);
          expect(target!.x + target!.width).toBeLessThanOrEqual(width);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
          ).toBe(false);
          await page.screenshot({
            path: resolve(
              artifacts,
              `discard-${inDetails ? 'sheet-' : ''}${width}-${theme}.png`,
            ),
            fullPage: true,
            animations: 'disabled',
          });
          await undo.click();
          await undo.waitFor({ state: 'hidden' });
          expect(
            await page
              .getByText('Draft will be discarded', { exact: true })
              .count(),
          ).toBe(0);
          expect(
            await page.evaluate(() => Reflect.get(window, 'discarded')),
          ).toBe(0);
          expect(commands).toBe(0);
        }
      }
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 90_000);
