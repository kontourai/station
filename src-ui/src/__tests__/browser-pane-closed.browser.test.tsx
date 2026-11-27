import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { resolveCssImports } from '../../../tests/helpers/css-cascade-fixture';
import { scrollBrowserFixture } from './scroll-browser-fixture';

// The production Browser pane on a session that was closed elsewhere (an
// agent closed the page it opened), against a fake Station.
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {KeyboardShortcutsProvider} from './src-ui/src/contexts/KeyboardShortcutsContext';
import BrowserPane from './src-ui/src/workspace-panes/browser-pane/BrowserPane';
const closed = {
  browserSessionId: 's1', projectId: 'p-alpha', projectSlug: 'alpha',
  principalKey: 'operator', reach: 'operator', url: 'https://www.google.com/',
  title: 'Google', viewport: {width: 1280, height: 800, deviceScaleFactor: 1},
  generation: 1, state: 'closed', createdAt: '2026-11-16T12:00:00.000Z',
  updatedAt: '2026-11-16T12:00:00.000Z', history: {entries: [], total: 0},
  activity: {agentDriven: true},
};
const routes = {
  'GET /api/browser/projects/alpha/access': {projectId: 'p-alpha', role: 'operator', operator: true, browser: 'ready', experiencePreviewEnabled: true},
  'GET /api/browser/sessions?projectSlug=alpha': [closed],
  'GET /api/browser/sessions/s1?view=summary': closed,
};
const transport = async (input, init) => {
  const url = new URL(String(input));
  const data = routes[(init?.method ?? 'GET') + ' ' + url.pathname + url.search];
  return data === undefined
    ? new Response(JSON.stringify({success: false, code: 'nope'}), {status: 599})
    : new Response(JSON.stringify({success: true, data}), {status: 200});
};
createRoot(document.getElementById('root')).render(
  <KeyboardShortcutsProvider><QueryClientProvider client={new QueryClient({defaultOptions: {queries: {retry: false}}})}>
    <div style={{height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-primary)'}}>
      <BrowserPane projectSlug="alpha" target={{kind: 'session', browserSessionId: 's1'}}
        browserSessionIds={['s1']} onTabsChange={() => {}} onAttach={() => {}} transport={transport} />
    </div>
  </QueryClientProvider></KeyboardShortcutsProvider>);
`;

test('a closed Browser session reads as closed: dimmed chrome, centred message, Reopen its address', async () => {
  const { browser, page, errors } = await scrollBrowserFixture(fixture, [
    {
      // The seams BrowserPane.test.tsx stubs: the Station address and its
      // feature flags, and the chat attachment intake (no chat here).
      name: 'browser-pane-host-stubs',
      setup(builder) {
        const stubs: Record<string, string> = {
          ApiBaseContext: `export const useApiBase = () => ({apiBase: 'http://station.test'});
            export const useHostRequestAuthorityScope = () => ({apiBase: 'http://station.test', authorityKey: 'fixture', isCurrent: () => true});`,
          useSurfaceVisibilityFlags: `export const useSurfaceVisibilityFlags = () => new Set(['browser-experience']);`,
          useBrowserArtifactIntake: `export const useBrowserArtifactIntake = () => () => async () => {};`,
        };
        builder.onResolve(
          {
            filter:
              /\/(ApiBaseContext|useSurfaceVisibilityFlags|useBrowserArtifactIntake)$/,
          },
          (args) => ({
            path: args.path.split('/').at(-1)!,
            namespace: 'stub',
          }),
        );
        builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubs[args.path],
          loader: 'js',
        }));
      },
    },
  ]);
  try {
    await page.addStyleTag({
      content: resolveCssImports(resolve(import.meta.dirname, '../index.css')),
    });
    const out = resolve('.kontourai/shell-chrome');
    mkdirSync(out, { recursive: true });
    for (const [width, theme] of [
      [640, 'dark'],
      [1440, 'light'],
      [390, 'dark'],
    ] as const) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute('data-theme', value),
        theme,
      );
      await page.setViewportSize({ width, height: 800 });
      await page.getByText('This session was closed').waitFor();
      await page
        .getByRole('button', { name: 'Reopen www.google.com' })
        .waitFor();
      await page.evaluate(() =>
        Promise.all(document.getAnimations().map((a) => a.finished)),
      );
      await page.screenshot({
        path: `${out}/browser-closed-${width}-${theme}.png`,
      });
      const geometry = await page.evaluate(() => {
        const box = (selector: string) =>
          document.querySelector(selector)!.getBoundingClientRect();
        const stage = box('.browser-pane__stage');
        const message = [...document.querySelectorAll('.browser-pane__stage *')]
          .find((el) => el.textContent?.trim() === 'This session was closed')!
          .getBoundingClientRect();
        return {
          toolbarOpacity: getComputedStyle(
            document.querySelector('.browser-pane__toolbar')!,
          ).opacity,
          tabOpacity: getComputedStyle(
            document.querySelector('.browser-tabs__item')!,
          ).opacity,
          stageCentre: stage.left + stage.width / 2,
          stageMiddle: stage.top + stage.height / 2,
          messageCentre: message.left + message.width / 2,
          messageTop: message.top,
        };
      });
      const where = `${width}px ${theme}`;
      expect(Number(geometry.toolbarOpacity), where).toBeLessThan(1);
      expect(Number(geometry.tabOpacity), where).toBeLessThan(1);
      // Centred across the stage, and in its lower half rather than its top.
      expect(
        Math.abs(geometry.messageCentre - geometry.stageCentre),
        where,
      ).toBeLessThanOrEqual(2);
      expect(geometry.messageTop, where).toBeGreaterThan(
        geometry.stageMiddle - 150,
      );
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 120_000);
