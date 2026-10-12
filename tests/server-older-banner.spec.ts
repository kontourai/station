/**
 * E2E: the "server is older than this app" banner (#2675) as a reader sees it.
 *
 * Harness: the real `ServerOlderLaunchCheck`, `BannerHost` and
 * `src-ui/src/index.css` (both token layers) bundled from source with
 * esbuild — the technique `banner-stack-bound.spec.ts` and
 * `toggle-contrast.spec.ts` use. Only the two data seams are stubbed: the
 * SDK's core-update hooks answer with the exact status a service-run archive
 * install returns, and the connected-server context names a remote server.
 * No live instance or server.
 *
 * Proves what jsdom cannot: the banner and its one-click update fit at phone
 * width without a horizontal scroll, in both themes, and clicking the update
 * moves the same banner to the update's progress. Each state is captured to
 * the test's own output directory for a person to look at.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { build, type Plugin } from 'esbuild';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STUB_SDK = `
const scenario = () => window.__scenario;
const status = () => ({
  installKind: scenario() === 'manual' ? 'archive' : 'archive-service',
  applyMethod: scenario() === 'manual' ? 'station-upgrade' : 'service-update',
  channel: 'nightly',
  currentVersion: '0.1.11-nightly.246303',
  latestVersion: '0.1.11-nightly.246500',
  releaseCheck: 'verified',
  updateAvailable: true,
  selfUpdateUnavailableReason: null,
  selfUpdateUnavailableCode: null,
  serverIdentity: { instanceId: 'station-nightly', bootId: 'boot-1', sha: 'a'.repeat(40) },
  serviceUpdate: { state: 'idle' },
});
export function useCoreUpdateStatusQuery(_apiBase, options) {
  return { data: options.enabled ? status() : undefined, error: null, refetch: () => Promise.resolve() };
}
export function useApplyCoreUpdateMutation(_apiBase, options) {
  return {
    mutate: () => setTimeout(() => options.onSuccess({ success: true, serviceUpdate: { requestId: 'req-1' } }), 0),
  };
}
const trial = {
  state: 'updating',
  requestId: 'req-1',
  phase: 'trial',
  fromVersion: '0.1.11-nightly.246303',
  targetVersion: '0.1.11-nightly.246500',
  attempts: 1,
};
export function useServiceUpdateProgressQuery(_apiBase, options) {
  return options.enabled
    ? { data: trial, dataUpdatedAt: 1, errorUpdatedAt: 0 }
    : { data: undefined, dataUpdatedAt: 0, errorUpdatedAt: 0 };
}
`;

const STUB_CONTEXT = `
const context = {
  scopeKey: 'remote',
  apiBase: 'https://station.example:38141',
  connectionName: 'Home server',
  reachability: 'connected',
  kind: 'remote-server',
  identity: { instanceId: 'station-nightly', bootId: 'boot-1', sha: 'a'.repeat(40) },
  identitySettled: true,
  identityReady: true,
  nativeObservationPending: false,
  claimedOwnerUnresolved: false,
  isCurrent: () => true,
};
export function useConnectedServerUpdateContext() { return context; }
export function coreUpdateScopeFromContext(c) {
  return c ? c.scopeKey + '\\u0000' + (c.identity?.bootId ?? 'no-boot') : undefined;
}
`;

/** Replaces only the two data seams; everything else is the real source. */
const stubSeams: Plugin = {
  name: 'server-older-banner-seams',
  setup(builder) {
    builder.onResolve({ filter: /^@kontourai\/station-sdk$/ }, () => ({
      path: 'sdk',
      namespace: 'stub',
    }));
    builder.onResolve(
      { filter: /hooks\/useConnectedServerUpdateContext$/ },
      () => ({ path: 'context', namespace: 'stub' }),
    );
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'sdk' ? STUB_SDK : STUB_CONTEXT,
      loader: 'js',
    }));
  },
};

const HARNESS_SOURCE = `
import './src-ui/src/index.css';
import { createRoot } from 'react-dom/client';
import { BannerHost } from './src-ui/src/components/notifications/BannerHost';
import { ServerOlderLaunchCheck } from './src-ui/src/components/ServerOlderLaunchCheck';

createRoot(document.getElementById('root')).render(
  <>
    <ServerOlderLaunchCheck clientVersion="0.1.11-nightly.2465" />
    {/* The banner alone: the shell's toolbar and content inset are not
      part of this harness, so no content is drawn for it to sit over. */}
    <BannerHost />
  </>,
);
`;

let harnessScript = '';
let harnessStyles = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: HARNESS_SOURCE, resolveDir: REPO_ROOT, loader: 'tsx' },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    external: ['/fonts/*', '/favicon-*'],
    loader: { '.woff2': 'empty', '.woff': 'empty' },
    plugins: [stubSeams],
    write: false,
    outdir: 'server-older-banner-harness',
    platform: 'browser',
    logLevel: 'silent',
  });
  for (const file of result.outputFiles) {
    if (file.path.endsWith('.js')) harnessScript = file.text;
    if (file.path.endsWith('.css')) harnessStyles = file.text;
  }
  expect(harnessScript.length, 'harness JS bundled').toBeGreaterThan(0);
  expect(harnessStyles, 'the real BannerHost.css is bundled').toContain(
    '.banner-host',
  );
});

const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  phone: { width: 390, height: 844 },
} as const;

async function mount(
  page: Page,
  theme: 'light' | 'dark',
  viewport: keyof typeof VIEWPORTS,
  scenario: 'update' | 'manual',
) {
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.setContent(
    `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:var(--bg-primary);color:var(--text-primary)"><div id="root"></div></body></html>`,
  );
  await page.addStyleTag({ content: harnessStyles });
  // A capture taken mid-transition shows the content inset half applied.
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; }',
  });
  await page.evaluate((value) => {
    (window as unknown as { __scenario: string }).__scenario = value;
    try {
      window.localStorage.clear();
    } catch {}
  }, scenario);
  await page.addScriptTag({ content: harnessScript });
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal page scroll').toBeLessThanOrEqual(0);
}

const OLDER =
  'This Station server runs Nightly Sep 29, build 3, which is older than this app (Nightly Oct 1).';

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of ['desktop', 'phone'] as const) {
    test(`offers a one-click server update (${theme}, ${viewport})`, async ({
      page,
    }, testInfo) => {
      await mount(page, theme, viewport, 'update');
      await expect(page.getByText(OLDER)).toBeVisible();
      const update = page.getByRole('button', {
        name: 'Update server to Nightly Oct 1',
      });
      await expect(update).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`offer-${theme}-${viewport}.png`),
      });

      await update.click();
      await expect(
        page.getByText(
          'Trying Station 0.1.11-nightly.246500 (attempt 1). The server restarts during the trial.',
        ),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: /Update server/ }),
      ).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`progress-${theme}-${viewport}.png`),
      });
    });
  }

  for (const viewport of ['desktop', 'phone'] as const) {
    test(`explains how to update a server that cannot do it from here (${theme}, ${viewport})`, async ({
      page,
    }, testInfo) => {
      await mount(page, theme, viewport, 'manual');
      await expect(page.getByText(OLDER)).toBeVisible();
      await expect(
        page.getByRole('button', { name: /Update server/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('link', { name: 'Server update details' }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`manual-${theme}-${viewport}.png`),
      });
    });
  }
}
