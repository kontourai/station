import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  type CDPSession,
  expect as expectBrowser,
  type Page,
} from '@playwright/test';
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
  import {useListRefresh} from './src-ui/src/components/refresh/ListRefresh';
  import {deviceSettingsStore} from './src-ui/src/lib/device-settings-store';
  import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
  import {ToastProvider} from './src-ui/src/contexts/ToastContext';
  import {NotificationContainer} from './src-ui/src/components/notifications/NotificationContainer';
  const items = [
    {id:'saved', kind:'orchestration', kindLabel:'Conversation', title:'Review the inbox', projectSlug:'station', projectLabel:'Station', agentSlug:'codex', agentLabel:'Codex', provider:'codex', executionProviders:['codex','claude','pi','kiro'], modelLabel:'GPT', updatedAt:Date.now(), lifecycleLabel:'Running'},
    {id:'idle', kind:'orchestration', kindLabel:'Conversation', title:'Plan the next release', projectSlug:'station', projectLabel:'Station', agentSlug:'claude', agentLabel:'Claude', provider:'claude', modelLabel:'Sonnet', updatedAt:Date.now(), lifecycleLabel:'Ready'},
  ];
  function RefreshableInbox(props) {
    const [updating, setUpdating] = React.useState(false);
    window.setInboxUpdating = setUpdating;
    const refresh = useListRefresh({
      scope: 'screen',
      refresh: () => {
        window.inboxRefreshes++;
        return new Promise((resolve, reject) => {
          window.finishInboxRefresh = (success) => {
            if (success) resolve();
            else reject(new Error('Offline'));
          };
        });
      },
    });
    return <MobileInboxPanel {...props} updating={updating} refresh={refresh} />;
  }
  let root;
  window.mount = (preview, mobile) => {
    root?.unmount();
    localStorage.clear();
    deviceSettingsStore.reloadFromStorage();
    deviceSettingsStore.set('developerToolsEnabled', preview);
    deviceSettingsStore.set('experimentalSheetGesturesEnabled', preview);
    document.body.dataset.theme = document.documentElement.dataset.theme;
    window.opens = 0; window.closes = 0; window.inboxRefreshes = 0;
    const props = { agents:[{slug:'codex',name:'Codex',engineId:'codex'},{slug:'claude',name:'Claude',engineId:'claude'}], projectIconBySlug:new Map([['station',${JSON.stringify(projectArtwork)}]]), activeChatSessionId:null, openChatSessionIds:[], onFocusChat:()=>window.opens++, onOpenConversation:()=>{window.opens++;return true}, onOpenSession:()=>window.opens++, onCloseChat:()=>window.closes++ };
    root = createRoot(document.getElementById('root'));
    // Dismissal Undo is a toast action (#4377), so the host renders toasts.
    root.render(<QueryClientProvider client={new QueryClient()}><NavigationProvider><ToastProvider>
      <NotificationContainer/>
      {mobile ? <RefreshableInbox {...props} open tasks={items} triggerRef={React.createRef()}  onClose={()=>{}} /> : <div style={{width:340}}><ChatDockInboxPanel {...props} items={items} onOpenHistory={()=>{}} /></div>}
    </ToastProvider></NavigationProvider></QueryClientProvider>);
  };
`;

const discardFixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
  import {InboxRow} from './src-ui/src/components/chat-dock/ChatDockInboxRows';
  import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
  import {setClientCredentialResolver} from '@kontourai/station-sdk/client';
  const draft = {
    id:'draft', kind:'orchestration', kindLabel:'Conversation',
    orchestrationThreadId:'draft-thread', conversationId:'draft-conversation',
    title:'Review draft before sending', projectSlug:'station', projectLabel:'Station',
    agentSlug:'codex', agentLabel:'Codex', provider:'codex',
    updatedAt:Date.now(), lifecycleLabel:'Draft',
  };
  window.fixtureRequestScope = {apiBase:window.location.origin, authorityKey:'discard-fixture', isCurrent:()=>true};
  setClientCredentialResolver(() => ({origin:window.location.origin, requestAuthority:window.fixtureRequestScope}));
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
    name = /^Review the inbox\b/,
    during,
    cancel = false,
  }: {
    name?: string | RegExp;
    during?: (start: { x: number; y: number }) => Promise<void>;
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
  await during?.({ x, y });
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
  await page.getByRole('button', { name: /^Review the inbox\b/ }).waitFor();
}

test('Inbox pulls and its menu join one refresh while keeping rows usable', async () => {
  const { page, browser, errors } = await scrollBrowserFixture(
    fixture,
    [scopeStub],
    { hasTouch: true, isMobile: true },
  );
  try {
    const css = ['src-ui/src/index.css', 'src-ui/src/components/chat/chat.css']
      .map((path) => resolveCssImports(resolve(path)))
      .join('\n');
    await page.addStyleTag({
      content:
        css +
        '\n#root { display: flex; flex-direction: column; height: 100dvh; }',
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mount(page, true);
    const cdp = await page.context().newCDPSession(page);
    const inbox = page.getByRole('region', { name: 'Inbox', exact: true });
    const row = inbox.getByRole('button', { name: /^Review the inbox\b/ });
    const cue = inbox.locator('.list-refresh__pull');
    const rowTravel = async () =>
      ((await row.boundingBox())?.y ?? rowTop) - rowTop;
    const ringProgress = () =>
      cue
        .locator('.list-refresh__ring-progress')
        .evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).strokeDasharray),
        );
    const refreshes = () =>
      page.evaluate(() => Reflect.get(window, 'inboxRefreshes'));
    const setUpdating = (value: boolean) =>
      page.evaluate(
        (updating) => Reflect.get(window, 'setInboxUpdating')(updating),
        value,
      );
    const status = inbox.locator('.list-refresh__status');
    const pill = status.locator('.list-refresh__pill');
    const menu = inbox.getByRole('button', { name: 'Inbox actions' });
    const target = await menu.boundingBox();
    expect(target?.height).toBeGreaterThanOrEqual(44);
    expect(target?.width).toBeGreaterThanOrEqual(44);

    await expectBrowser
      .poll(() =>
        row.evaluate((element) => {
          const container = element.closest('.inbox-row');
          return container && getComputedStyle(container).transform;
        }),
      )
      .toBe('none');
    const rowTop = (await row.boundingBox())?.y ?? 0;
    await setUpdating(true);
    await expectBrowser(pill).toHaveText('Refreshing inbox…');
    await pill.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    const [panelBounds, pillBounds] = await Promise.all([
      inbox.boundingBox(),
      pill.boundingBox(),
    ]);
    if (!panelBounds || !pillBounds)
      throw new Error('Inbox status did not render');
    expect(
      panelBounds.y + panelBounds.height - pillBounds.y - pillBounds.height,
    ).toBeGreaterThanOrEqual(8);
    expect(
      panelBounds.y + panelBounds.height - pillBounds.y - pillBounds.height,
    ).toBeLessThanOrEqual(16);
    expect((await row.boundingBox())?.y).toBe(rowTop);
    await expectBrowser(pill).toHaveCSS('pointer-events', 'none');
    await expectBrowser(pill.locator('.live-status-glyph__orbit')).toHaveCSS(
      'animation-iteration-count',
      '1',
    );
    await setUpdating(false);
    await expectBrowser(pill).toHaveCount(0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await swipe(cdp, page, 0, 36, {
      during: async () => {
        const travel = await rowTravel();
        expect(travel).toBeGreaterThan(12);
        expect(travel).toBeLessThan(36);
        const progress = await ringProgress();
        expect(progress).toBeGreaterThan(0);
        expect(progress).toBeLessThan(1);
      },
    });
    await expectBrowser.poll(rowTravel).toBe(0);
    await swipe(cdp, page, 0, 110, { cancel: true });
    await expectBrowser.poll(rowTravel).toBe(0);
    await swipe(cdp, page, 0, 110, {
      during: async ({ x, y }) => {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y + 3 }],
        });
      },
    });
    await swipe(cdp, page, 0, 110, {
      during: async ({ x, y }) => {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [
            { x, y: y + 110 },
            { x: 12, y: 12 },
          ],
        });
      },
    });
    expect(await refreshes()).toBe(0);
    await swipe(cdp, page, 0, 110, {
      during: async () => {
        await expectBrowser.poll(ringProgress).toBe(1);
        expect(await rowTravel()).toBeLessThan(62);
        expect(await refreshes()).toBe(0);
      },
    });
    await expectBrowser(pill).toHaveText('Refreshing inbox…');
    await expectBrowser(pill.locator('.live-status-glyph__orbit')).toHaveCSS(
      'animation-name',
      'live-status-orbit',
    );
    await expectBrowser.poll(rowTravel).toBe(0);
    expect((await row.boundingBox())?.y).toBe(rowTop);
    await expectBrowser(row).toBeVisible();

    await swipe(cdp, page, 0, 110);
    await menu.press('Enter');
    await page.getByRole('menuitem', { name: 'Refresh inbox' }).click();
    expect(await refreshes()).toBe(1);
    await page.evaluate(() => Reflect.get(window, 'finishInboxRefresh')(true));
    await expectBrowser(pill).toHaveText('Updated');
    await expectBrowser(row).toBeVisible();

    await inbox.getByRole('button', { name: 'Inbox actions' }).click();
    await page.getByRole('menuitem', { name: 'Refresh inbox' }).click();
    await expectBrowser(pill).toHaveText('Refreshing inbox…');
    await page.evaluate(() => Reflect.get(window, 'finishInboxRefresh')(false));
    await expectBrowser(pill).toHaveText('Couldn’t refresh');
    await expectBrowser(row).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, 'opens'))).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);

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
      name: /^Review the inbox\b/,
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
        await mkdir(resolve('.surface/inbox-dismiss-swipe'), {
          recursive: true,
        });
        await page.screenshot({
          path: resolve('.surface/inbox-dismiss-swipe/dragging-390-dark.png'),
          animations: 'disabled',
        });
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
      .getByRole('button', { name: /^Review the inbox\b/ })
      .waitFor({ state: 'hidden' });
    expect(
      await page.evaluate(
        () => (window as unknown as { closes: number }).closes,
      ),
    ).toBe(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: /^Review the inbox\b/ }).waitFor();

    await swipe(cdp, page, -90);
    await rail
      .getByRole('button', { name: 'Snooze Review the inbox', exact: true })
      .click();
    await page.getByRole('menuitem', { name: '1 hour', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
      )
      .toBe('Snooze Review the inbox');
    await rail
      .getByRole('button', { name: 'Snooze Review the inbox', exact: true })
      .click();
    await page.getByRole('menuitem', { name: '1 hour', exact: true }).click();
    await expectBrowser(
      page.getByRole('button', { name: /^Plan the next release\b/ }),
    ).toBeFocused();
    await page.getByRole('button', { name: 'Snoozed · 1' }).click();
    expect(
      await page
        .getByRole('region', { name: /Snoozed/ })
        .getByRole('button', { name: /^Review the inbox\b/ })
        .count(),
    ).toBe(1);

    await mount(page, true);
    await swipe(cdp, page, -90);
    await swipe(cdp, page, -90, 0, {
      name: /^Plan the next release\b/,
    });
    expect(await page.locator('.inbox-row--swiped').count()).toBe(1);
    expect(
      await page
        .locator('.inbox-row--swiped')
        .getByRole('button', {
          name: /^Plan the next release\b/,
        })
        .count(),
    ).toBe(1);
    await page.getByRole('button', { name: 'Search inbox' }).focus();
    await expect
      .poll(() => page.locator('.inbox-row__swipe-actions:visible').count())
      .toBe(0);

    await swipe(cdp, page, -75, 0, {
      cancel: true,
      during: async () => {
        await expectBrowser(rail).toBeVisible();
        await expectBrowser(rail).toHaveAttribute('aria-hidden', 'true');
      },
    });
    await expectBrowser(
      page.locator('.inbox-row__swipe-actions:visible'),
    ).toHaveCount(0);
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
    await page.getByRole('button', { name: /^Review the inbox\b/ }).waitFor();

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
              name: /^Review the inbox\b/,
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
      content: ['src-ui/src/index.css', 'src-ui/src/components/chat/chat.css']
        .map((path) => resolveCssImports(resolve(path)))
        .join('\n'),
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
          expect(target!.y).toBeGreaterThanOrEqual(0);
          expect(target!.y + target!.height).toBeLessThanOrEqual(844);
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

test('a refused direct discard keeps the 320px touch row readable and focused', async () => {
  const { page, browser, errors } = await scrollBrowserFixture(
    discardFixture,
    [scopeStub],
    { viewport: { width: 320, height: 720 }, hasTouch: true, isMobile: true },
  );
  try {
    await page.addStyleTag({
      content: ['src-ui/src/index.css', 'src-ui/src/components/chat/chat.css']
        .map((path) => resolveCssImports(resolve(path)))
        .join('\n'),
    });
    let sent: unknown;
    await page.route('**/api/orchestration/commands', async (route) => {
      expect(route.request().method()).toBe('POST');
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        json: {
          success: false,
          code: 'draft_busy',
          error:
            'This draft is starting on another device or tab, so it was not discarded. Try again in a moment.',
        },
      });
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => Reflect.get(window, 'mountDiscard')(false));
    await page.clock.install();
    const row = page.getByTestId('inbox-row');
    const discard = row.getByRole('button', { name: /^Discard draft / });
    const geometry = () =>
      row.evaluate((node) => {
        const title = node.querySelector('.inbox-row__title-text');
        const action = node.querySelector('[aria-label^="Discard draft "]');
        if (!title || !action)
          throw new Error('The draft row must lay out its title and action');
        const rowBox = node.getBoundingClientRect();
        const actionBox = action.getBoundingClientRect();
        return {
          titleWidth: title.getBoundingClientRect().width,
          actionTop: actionBox.y - rowBox.y,
          actionLeft: actionBox.x - rowBox.x,
        };
      });
    const before = await geometry();
    await discard.tap();
    await row.getByRole('button', { name: /^Undo discard of / }).waitFor();
    await page.clock.fastForward(8_100);
    const alert = row.getByRole('alert');
    await alert.waitFor();
    expect(sent).toEqual({ type: 'discardDraft', threadId: 'draft-thread' });
    expect(await alert.textContent()).toContain('starting on another device');
    expect(
      await discard.evaluate((node) => document.activeElement === node),
    ).toBe(true);
    const layout = await row.evaluate((node) => {
      const message = node
        .querySelector('[role="alert"]')!
        .getBoundingClientRect();
      return {
        fits: node.scrollWidth <= node.clientWidth,
        fullWidth: message.width >= node.clientWidth * 0.75,
      };
    });
    await mkdir(resolve('.surface/inbox-dismiss-swipe'), { recursive: true });
    await page.screenshot({
      path: resolve('.surface/inbox-dismiss-swipe/discard-refused-320.png'),
      animations: 'disabled',
    });
    expect(layout).toEqual({ fits: true, fullWidth: true });
    const after = await geometry();
    expect(after.titleWidth).toBeGreaterThanOrEqual(before.titleWidth - 4);
    expect(after.actionTop).toBeCloseTo(before.actionTop);
    expect(after.actionLeft).toBeCloseTo(before.actionLeft);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);

test('an engine-list swipe reveals Remove without selecting the engine or invoking Remove', async () => {
  const splitFixture = `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
    import {SplitPaneLayout} from './src-ui/src/components/SplitPaneLayout';
    window.selected = 0;
    window.removalRequests = 0;
    createRoot(document.getElementById('root')).render(
      <QueryClientProvider client={new QueryClient()}><NavigationProvider>
        <SplitPaneLayout
          label="engines" title="Engines" selectedId={null}
          items={[{ id: 'agy', name: 'Antigravity', swipeAction: {
            label: 'Remove', onSelect: () => window.removalRequests++,
          } }]}
          onSelect={() => window.selected++}
        >
          <div>Engine details</div>
        </SplitPaneLayout>
      </NavigationProvider></QueryClientProvider>
    );
  `;
  const { page, browser, errors } = await scrollBrowserFixture(
    splitFixture,
    [],
    { hasTouch: true },
  );
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve('src-ui/src/index.css')),
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await expectBrowser(
      page.getByRole('button', { name: 'Antigravity', exact: true }),
    )
      .toBeVisible({ timeout: 4000 })
      .catch((error: Error) => {
        throw new Error(`${error.message} (page errors: ${errors.join('; ')})`);
      });
    const remove = page.getByRole('button', { name: 'Remove', exact: true });
    await expectBrowser(remove).toHaveCount(0);
    await swipe(cdp, page, -90, 0, {
      name: 'Antigravity',
      during: async () => {
        const row = page.locator('.split-pane__swipe-row');
        await expectBrowser(row).toHaveAttribute('data-dragging', 'true');
      },
    });
    await expectBrowser(remove).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toBe(0);
    expect(
      await page.evaluate(() => Reflect.get(window, 'removalRequests')),
    ).toBe(0);
    await remove.tap({ timeout: 4000 });
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'removalRequests')))
      .toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
