import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import { expect as expectBrowser } from '@playwright/test';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

/**
 * The inbox row ⋯ menu is the only way to act on a row, so it must work from
 * the keyboard: Tab to it, Enter opens it with the first item focused,
 * ArrowDown moves, Escape closes only the menu and puts focus back on ⋯. In
 * the dock, the row's metadata card opens on focus and listens for Escape in
 * its own capture phase; the menu must still take Escape first.
 */
const fixture = `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
  import {ChatDockInboxPanel} from './src-ui/src/components/chat-dock/ChatDockInboxPanel';
  import {RowMenu} from './src-ui/src/components/notifications/RowMenu';
  import {NavigationProvider} from './src-ui/src/contexts/NavigationContext';
  import {ToastProvider} from './src-ui/src/contexts/ToastContext';
  const items = [
    {id:'one', kind:'orchestration', kindLabel:'Conversation', title:'Review the inbox', projectLabel:'Station', agentLabel:'Agent A', modelLabel:'Model A', updatedAt:Date.now(), lifecycleLabel:'Ready'},
    {id:'two', kind:'orchestration', kindLabel:'Conversation', title:'Plan the next release', projectLabel:'Station', agentLabel:'Agent B', modelLabel:'Model B', updatedAt:Date.now() - 60000, lifecycleLabel:'Ready'},
  ];
  window.closedDock = 0;
  window.dialogEscapes = 0;
  const props = { activeChatSessionId:null, openChatSessionIds:[], onFocusChat:()=>{}, onOpenConversation:()=>true, onOpenSession:()=>{}, onCloseChat:()=>{} };
  createRoot(document.getElementById('root')).render(
    <QueryClientProvider client={new QueryClient()}><NavigationProvider><ToastProvider>
      <div style={{display:'flex', gap:24}}>
        <div style={{width:340}} onKeyDown={(e) => { if (e.key === 'Escape') window.closedDock++; }}>
          <ChatDockInboxPanel {...props} items={items} onOpenHistory={()=>{}} />
        </div>
        <article aria-label="Inbox page row" style={{width:360, padding:12}}>
          <span>Session failed</span>
          <RowMenu items={[
            {id:'done', label:'Mark done', onSelect:()=>{}},
            {id:'snooze-1', group:'Snooze until', label:'In 1 hour', hint:'7:00 PM', onSelect:()=>{}},
          ]} />
        </article>
        <div role="dialog" aria-label="Other dialog" onKeyDown={(e) => { if (e.key === 'Escape') window.dialogEscapes++; }}>
          <input aria-label="Other dialog field" />
        </div>
      </div>
    </ToastProvider></NavigationProvider></QueryClientProvider>);
`;

/** No connection scope: the rows read nothing from a Station. */
const scopeStub: Plugin = {
  name: 'row-menu-no-remote-reads',
  setup(build) {
    build.onResolve({ filter: /ApiBaseContext$/ }, async (args) => {
      if (args.pluginData?.real) return;
      const real = await build.resolve(args.path, {
        resolveDir: args.resolveDir,
        kind: args.kind,
        pluginData: { real: true },
      });
      return { path: real.path, namespace: 'row-menu-scope-stub' };
    });
    build.onLoad(
      { filter: /.*/, namespace: 'row-menu-scope-stub' },
      (args) => ({
        contents: `export * from ${JSON.stringify(args.path)}; export const useHostRequestAuthorityScope = () => null;`,
        loader: 'tsx',
        resolveDir: dirname(args.path),
      }),
    );
  },
};

const focused = (page: Page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    return element
      ? `${element.getAttribute('role') ?? element.tagName}:${element.getAttribute('aria-label') ?? element.textContent?.trim()}`
      : 'none';
  });

test('the row menu works from the keyboard in the dock and on the inbox page', async () => {
  const { page, browser, errors } = await scrollBrowserFixture(
    fixture,
    [scopeStub],
    { viewport: { width: 1000, height: 800 } },
  );
  try {
    const css = ['src-ui/src/index.css', 'src-ui/src/components/chat/chat.css']
      .map((path) => resolveCssImports(resolve(path)))
      .join('\n');
    await page.addStyleTag({ content: css });
    for (const [where, trigger] of [
      [
        'dock, first row',
        page.getByRole('button', { name: 'Actions for Review the inbox' }),
      ],
      [
        'dock, second row',
        page.getByRole('button', {
          name: 'Actions for Plan the next release',
        }),
      ],
      [
        'dock, first row again',
        page.getByRole('button', { name: 'Actions for Review the inbox' }),
      ],
      [
        'inbox page',
        page
          .getByRole('article', { name: 'Inbox page row' })
          .getByRole('button', { name: 'More actions' }),
      ],
    ] as const) {
      // Tab to ⋯ from the control before it, as a keyboard user does.
      await trigger.focus({ timeout: 5000 });
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      expect(await focused(page), where).toMatch(/^BUTTON:(Actions for|More)/);
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu');
      await expectBrowser(menu).toBeVisible();
      // The row's metadata card stays shut while its menu is open.
      await page.waitForTimeout(400);
      await expectBrowser(page.getByTestId('inbox-row-hover-card')).toHaveCount(
        0,
      );
      const items = menu.getByRole('menuitem');
      await expectBrowser(items.first()).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expectBrowser(items.nth(1)).toBeFocused();
      await page.keyboard.press('Escape');
      await expectBrowser(menu).toHaveCount(0);
      await expectBrowser(trigger).toBeFocused();
    }
    // Escape closed the menus only: nothing around them saw it.
    expect(await page.evaluate(() => Reflect.get(window, 'closedDock'))).toBe(
      0,
    );
    // An open menu does not own Escape pressed elsewhere: a dialog that has
    // focus while a row menu is still open gets its own Escape, and keeps
    // focus.
    const dockTrigger = page.getByRole('button', {
      name: 'Actions for Review the inbox',
    });
    await dockTrigger.focus();
    await page.keyboard.press('Enter');
    await expectBrowser(page.getByRole('menu')).toBeVisible();
    const field = page.getByRole('textbox', { name: 'Other dialog field' });
    await field.focus();
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(() => Reflect.get(window, 'dialogEscapes')),
    ).toBe(1);
    await expectBrowser(field).toBeFocused();
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30_000);
