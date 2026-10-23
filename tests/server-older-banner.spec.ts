/**
 * The real server-older source and unified Updates panel, in both themes and
 * at phone/desktop widths. SDK responses and connection/platform identity are
 * controlled inputs; the panel, confirmation and service-progress UI are real.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { build, type Plugin } from 'esbuild';
import { test } from './helpers/fixture-audit';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK_ENTRY = createRequire(import.meta.url).resolve(
  '@kontourai/station-sdk',
);

const STUB_SDK = `
export * from ${JSON.stringify(SDK_ENTRY)};
const checkedAt = Date.now();
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
  return { data: status(), dataUpdatedAt: checkedAt, error: null, isFetching: false, isPending: false, refetch: () => Promise.resolve() };
}
export function useApplyCoreUpdateMutation(_apiBase, options) {
  return {
    isPending: false, error: null, reset: () => {},
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
export function useServerUpdateStateQuery() { return { data: undefined, refetch: () => Promise.resolve() }; }
export function useServerUpdateRunningTurnsQuery() {
  return { data: { turns: [], hiddenCount: 0 }, isPending: false, isFetching: false, error: null };
}
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
      resolveDir: REPO_ROOT,
    }));
  },
};

const HARNESS_SOURCE = `
import './src-ui/src/index.css';
import './src-ui/src/components/updates/Updates.css';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { UpdatesPanel } from './src-ui/src/components/updates/UpdatesPanel';
import { ServerOlderLaunchCheck } from './src-ui/src/components/ServerOlderLaunchCheck';

function Harness() {
  const [open, setOpen] = useState(false);
  return <>
    <ServerOlderLaunchCheck clientVersion="0.1.11-nightly.2465" />
    <button type="button" onClick={() => setOpen(true)}>Review updates</button>
    {open && <UpdatesPanel open onClose={() => setOpen(false)} onNavigate={() => {}}
      returnFocusTarget={null} target="server" requestSequence={1} />}
  </>;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

let harnessScript = '';
let harnessStyles = '';

test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: HARNESS_SOURCE, resolveDir: REPO_ROOT, loader: 'tsx' },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': '{}',
    },
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
  expect(harnessStyles.length, 'real panel styles bundled').toBeGreaterThan(0);
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

  await page.evaluate((value) => {
    (window as typeof window & { __scenario: string }).__scenario = value;
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
    test(`confirms a server update and follows its progress in Updates (${theme}, ${viewport})`, async ({
      page,
    }, testInfo) => {
      await mount(page, theme, viewport, 'update');
      await page
        .getByRole('button', { name: 'Review updates', exact: true })
        .click();
      const panel = page.getByRole('dialog', { name: 'Updates', exact: true });
      await expect(panel.getByText(OLDER)).toBeVisible();
      const update = page.getByRole('button', {
        name: 'Update server to 0.1.11-nightly.246500',
      });
      await expect(update).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`offer-${theme}-${viewport}.png`),
      });

      await update.click();
      const confirmation = page.getByRole('alertdialog', {
        name: 'Update and restart the server?',
      });
      await expect(confirmation).toBeVisible();
      await confirmation
        .getByRole('button', { name: 'Update and restart', exact: true })
        .click();
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
    test(`explains the host-managed server update in Updates (${theme}, ${viewport})`, async ({
      page,
    }, testInfo) => {
      await mount(page, theme, viewport, 'manual');
      await page
        .getByRole('button', { name: 'Review updates', exact: true })
        .click();
      const panel = page.getByRole('dialog', { name: 'Updates', exact: true });
      await expect(panel.getByText(OLDER)).toBeVisible();
      await expect(
        page.getByRole('button', { name: /Update server/ }),
      ).toHaveCount(0);
      await expect(
        panel.getByText(/Run "station upgrade" on its host to update it\./),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`manual-${theme}-${viewport}.png`),
      });
    });
  }
}
