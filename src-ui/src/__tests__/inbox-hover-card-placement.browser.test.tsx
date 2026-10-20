/**
 * #3884: the inbox row's hover card stays inside a short viewport after its
 * late sections arrive. The real ChatInboxHoverCard and its stylesheet in
 * Chromium, anchored to a row near the bottom of a 600px window. The
 * session-inventory read is the one seam replaced: it answers only when the
 * test says so, as the real read answers some time after the card opens,
 * with the Basis preview that used to run off the screen.
 */
import { dirname } from 'node:path';
import type { Plugin } from 'esbuild';
import { expect, test } from 'vitest';
import { scrollBrowserFixture } from './scroll-browser-fixture';

const VIEWPORT = { width: 1280, height: 600 };

/** The shell values and the inventory read the card asks for. */
const STUBS: Array<{ pattern: RegExp; overrides: string }> = [
  {
    pattern: /src-ui\/src\/contexts\/ApiBaseContext\.tsx?$/,
    overrides:
      "export const useHostRequestAuthorityScope = () => ({ apiBase: 'http://station.test', authorityKey: 'hover-card-fixture', isCurrent: () => true });",
  },
  {
    // The session-inventory subpath's source module.
    pattern: /packages\/sdk\/src\/.*session-inventory[^/]*\.tsx?$/,
    overrides: `
      import { useSyncExternalStore as __useStore } from 'react';
      const __listeners = new Set();
      let __answer = { data: undefined, isLoading: true, error: null };
      globalThis.__answerInventory = (data) => {
        __answer = { data, isLoading: false, error: null };
        for (const listener of __listeners) listener();
      };
      export const useSessionInventoryQuery = () =>
        __useStore((listener) => { __listeners.add(listener); return () => __listeners.delete(listener); }, () => __answer);
    `,
  },
];

const stubs: Plugin = {
  name: 'hover-card-stubs',
  setup(build) {
    build.onResolve(
      { filter: /(ApiBaseContext|session-inventory)$/ },
      async (args) => {
        if (args.namespace === 'hover-card-stub' || args.pluginData?.real)
          return undefined;
        const real = await build.resolve(args.path, {
          resolveDir: args.resolveDir,
          kind: args.kind,
          importer: args.importer,
          pluginData: { real: true },
        });
        const stub = STUBS.find((candidate) =>
          candidate.pattern.test(real.path.replaceAll('\\', '/')),
        );
        if (!stub || real.errors.length > 0) return undefined;
        return {
          path: real.path,
          namespace: 'hover-card-stub',
          pluginData: stub,
        };
      },
    );
    build.onLoad({ filter: /.*/, namespace: 'hover-card-stub' }, (args) => ({
      contents: `export * from ${JSON.stringify(args.path)};\n${
        (args.pluginData as (typeof STUBS)[number]).overrides
      }`,
      loader: 'tsx',
      resolveDir: dirname(args.path),
    }));
  },
};

async function hoverCardFixture() {
  const fixture = await scrollBrowserFixture(
    `
    import React, {useEffect, useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
    import {ChatInboxHoverCard} from './src-ui/src/components/chat-dock/ChatInboxHoverCard';
    const client = new QueryClient({defaultOptions: {queries: {retry: false}}});
    const NOW = Date.parse('2026-10-19T12:00:00Z');
    const item = {id: 'thread-1', kind: 'orchestration', kindLabel: 'Session', title: 'Cross-machine project repository mapping',
      projectLabel: 'kontourai/station', agentLabel: 'Codex', modelLabel: 'GPT-6', updatedAt: NOW - 60000, lifecycleLabel: 'Done',
      orchestrationThreadId: 'thread-1'};
    function App() {
      const [anchor, setAnchor] = useState(null);
      // Hovered only once the test has sized the window, as a real hover
      // happens in an already laid-out window; the card closes on resize.
      const [hovered, setHovered] = useState(false);
      useEffect(() => {
        globalThis.__hoverRow = () => setHovered(true);
      }, []);
      return <QueryClientProvider client={client}>
        <div ref={setAnchor} data-testid="row" style={{position: 'fixed', top: 470, left: 40, width: 280, height: 56}}>Inbox row</div>
        {anchor && hovered && <ChatInboxHoverCard item={item} now={NOW} anchor={anchor} onClose={() => {}} id="hover-card"/>}
      </QueryClientProvider>;
    }
    document.documentElement.dataset.theme = 'dark';
    createRoot(document.getElementById('root')).render(<App/>);
  `,
    [stubs],
  );
  await fixture.page.setViewportSize(VIEWPORT);
  await fixture.page.waitForFunction(
    (height) =>
      window.innerHeight === height &&
      typeof (globalThis as unknown as { __hoverRow?: unknown }).__hoverRow ===
        'function',
    VIEWPORT.height,
  );
  await fixture.page.evaluate(() =>
    (globalThis as unknown as { __hoverRow(): void }).__hoverRow(),
  );
  return fixture;
}

/** A whole-session inventory with full Outputs and Kept groups. */
function inventory() {
  const ids = [
    'inputs',
    'sources',
    'work-items',
    'execution',
    'decisions',
    'outputs',
    'verification-delivery',
    'live-now',
    'kept',
    'attention',
    'resources',
  ];
  const outputs = Array.from({ length: 4 }, (_, index) => ({
    kind: 'station-session-output',
    key: `output-${index}`,
    relations: [],
    output: {
      ref: { sessionId: 'thread-1', eventId: `evt-${index}` },
      turnId: `turn-${index}`,
      toolCallId: `call-${index}`,
      declaredAt: '2026-10-19T10:00:00.000Z',
      label: `Feed refresh worker part ${index + 1}`,
      descriptor: {
        kind: 'pull-request',
        liveExternal: true,
        provider: 'github',
        host: 'github.com',
        repository: { owner: 'kontourai', name: 'station' },
        ref: String(2041 + index),
        nativeId: String(2041 + index),
      },
    },
  }));
  const kept = Array.from({ length: 4 }, (_, index) => ({
    kind: 'task-kept-pull-request',
    key: `kept-${index}`,
    relations: ['kept-in-task'],
  }));
  return {
    version: 'station.session-inventory/v2',
    scope: { kind: 'whole-session', sessionId: 'thread-1' },
    groups: ids.map((id) => {
      const items = id === 'outputs' ? outputs : id === 'kept' ? kept : [];
      return {
        id,
        owner: { owner: 'station.inventory', id: 'v2' },
        state: items.length ? 'available' : 'empty',
        count: { kind: 'exact', value: items.length },
        items,
        gaps: [],
      };
    }),
  };
}

test('a card that grows when its Basis section arrives stays inside a short viewport', async () => {
  const { browser, page, errors } = await hoverCardFixture();
  try {
    const card = page.getByTestId('inbox-row-hover-card');
    await card.waitFor();
    const row = (await page.getByTestId('row').boundingBox())!;
    // Opened beside the row, short: the inventory has not answered yet. The
    // first placement can settle a few pixels up before it is measured, so
    // assert the relationship to the row rather than one exact offset.
    await expect
      .poll(async () => {
        const box = (await card.boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(VIEWPORT.height - 8);
    const opened = (await card.boundingBox())!;
    expect(opened.x).toBeGreaterThanOrEqual(row.x + row.width);
    expect(opened.y).toBeLessThanOrEqual(row.y);
    expect(opened.y + opened.height).toBeGreaterThan(row.y);

    await page.evaluate(
      (data) =>
        (
          globalThis as unknown as { __answerInventory(data: unknown): void }
        ).__answerInventory(data),
      inventory(),
    );
    await page.getByText('Feed refresh worker part 1').waitFor();
    await expect
      .poll(async () => {
        const box = (await card.boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(VIEWPORT.height - 8);
    const settled = (await card.boundingBox())!;
    expect(settled.height).toBeGreaterThan(opened.height);
    expect(settled.y).toBeGreaterThanOrEqual(8);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
