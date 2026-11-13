/**
 * The real server-older source and unified Updates panel, in both themes and
 * at phone/desktop widths. SDK responses and connection/platform identity are
 * controlled inputs; the panel, confirmation and service-progress UI are real.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { build, type Plugin } from 'esbuild';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';

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

/** Controls SDK, connection, chat and navigation inputs; renders real components. */
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
    builder.onResolve({ filter: /contexts\/ActiveChatsContext$/ }, () => ({
      path: 'chats',
      namespace: 'stub',
    }));
    builder.onResolve({ filter: /contexts\/NavigationContext$/ }, () => ({
      path: 'navigation',
      namespace: 'stub',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents:
        args.path === 'sdk'
          ? STUB_SDK
          : args.path === 'context'
            ? STUB_CONTEXT
            : args.path === 'chats'
              ? 'export function useActiveChatIds() { return []; }'
              : 'export function useNavigationActions() { return { navigate() {} }; }',
      loader: 'js',
      resolveDir: REPO_ROOT,
    }));
  },
};

const HARNESS_SOURCE = `
import './src-ui/src/index.css';
import './src-ui/src/components/updates/Updates.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { UpdatesPanel } from './src-ui/src/components/updates/UpdatesPanel';
import { WhatsNewDialog } from './src-ui/src/components/updates/WhatsNewDialog';
import { ServerOlderLaunchCheck } from './src-ui/src/components/ServerOlderLaunchCheck';
import { ToastProvider, toastStore } from './src-ui/src/contexts/ToastContext';
import { NotificationContainer } from './src-ui/src/components/notifications/NotificationContainer';

function Harness() {
  const [open, setOpen] = useState(false);
  if (window.__scene.startsWith('notice-')) return <ToastProvider>
    <button onClick={() => toastStore.upsert({ dedupeKey: 'connection-layout', message: window.__scene === 'notice-lost' ? "Studio didn't answer in time. Reconnecting…" : 'Server connection restored.', tone: window.__scene === 'notice-lost' ? 'warning' : 'success' })}>Show connection notice</button>
    <NotificationContainer />
  </ToastProvider>;
  if (window.__scene === 'notes') return <WhatsNewDialog version="0.1.11-nightly.246303" nativeApp={false} serverKey="fixture" onClose={() => {}} />;
  return <>
    <ServerOlderLaunchCheck clientVersion="0.1.11-nightly.2465" />
    <button type="button" onClick={() => setOpen(true)}>Review updates</button>
    {open && <UpdatesPanel open onClose={() => setOpen(false)} onNavigate={() => {}}
      returnFocusTarget={null} target="server" requestSequence={1} />}
  </>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Harness /></QueryClientProvider>);
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
  desktop: { width: 1440, height: 900 },
  ownerPhone: { width: 412, height: 915 },
  phone: { width: 390, height: 844 },
} as const;

async function installReleaseFixtures(page: Page, longNotes = false) {
  const history = [
    {
      tag_name: 'v0.1.11-nightly.246500',
      name: 'Available server release',
      draft: false,
      body: longNotes
        ? '## What Changed\n' +
          Array.from(
            { length: 2000 },
            (_, i) => `- Release improvement ${i + 1}`,
          ).join('\n')
        : '- Available server improvements.',
    },
    {
      tag_name: 'v0.1.11-nightly.246303',
      name: 'Installed server release',
      draft: false,
      body: '## Server changes\n- Restores connections after a server restart.\n- Shows the installed server changelog.\n\n## Installation\n\n```sh\ncurl https://example.test/install.sh | sh\n```',
    },
    {
      tag_name: 'v0.1.10',
      name: 'Earlier server release',
      draft: false,
      body: '- Earlier server changes.',
    },
  ];
  await page.route(
    'https://api.github.com/repos/kontourai/station/releases**',
    (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/releases') && url.search === '?per_page=100')
        return route.fulfill({ json: history });
      const tag = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
      const release = history.find((entry) => entry.tag_name === tag);
      return release
        ? route.fulfill({ json: release })
        : rejectUnexpectedFixtureRequest(route);
    },
  );
}

async function mount(
  page: Page,
  theme: 'light' | 'dark',
  viewport: keyof typeof VIEWPORTS,
  scenario: 'update' | 'manual',
  scene = 'updates',
) {
  await installReleaseFixtures(page, scene === 'long-notes');
  await page.setViewportSize(VIEWPORTS[viewport]);
  await page.setContent(
    `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:var(--bg-primary);color:var(--text-primary)"><div id="root"></div></body></html>`,
  );
  await page.addStyleTag({ content: harnessStyles });

  await page.evaluate(
    ({ scenario, scene }) => {
      (window as typeof window & { __scenario: string }).__scenario = scenario;
      (window as typeof window & { __scene: string }).__scene = scene;
      try {
        window.localStorage.clear();
      } catch {}
    },
    { scenario, scene },
  );
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

const OLDER = 'Server is older than this app (0.1.11-nightly.2465).';

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
        name: 'Update server',
        exact: true,
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

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of ['desktop', 'phone', 'ownerPhone'] as const) {
    test(`installed server changelog (${theme}, ${viewport})`, async ({
      page,
    }, testInfo) => {
      await mount(page, theme, viewport, 'update');
      await page
        .getByRole('button', { name: 'Review updates', exact: true })
        .click();
      const panel = page.getByRole('dialog', { name: 'Updates', exact: true });
      await expect(
        panel.getByText('Available server improvements.'),
      ).toBeVisible();
      // Retain the panel before the installed-note assertion for failure diagnosis.
      await page.screenshot({
        path: testInfo.outputPath(
          `changelog-readiness-${theme}-${viewport}.png`,
        ),
      });
      await expect(
        panel.getByText('Shows the installed server changelog.'),
      ).toBeVisible();
      await expect(
        panel.getByText('Available server improvements.'),
      ).toBeVisible();
      await expect(
        panel.getByText('Installation', { exact: true }),
      ).toHaveCount(0);
      await expect(panel.getByText(/curl https/)).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`installed-${theme}-${viewport}.png`),
      });
      const retained = resolve(REPO_ROOT, 'gallery/diagnostics/ux-lane-e');
      mkdirSync(retained, { recursive: true });
      copyFileSync(
        testInfo.outputPath(`installed-${theme}-${viewport}.png`),
        resolve(retained, `installed-${theme}-${viewport}.png`),
      );
    });
  }
}

for (const capture of [
  {
    name: 'updates-after-390-dark',
    theme: 'dark',
    viewport: 'phone',
    scene: 'updates',
  },
  {
    name: 'updates-after-1440-light',
    theme: 'light',
    viewport: 'desktop',
    scene: 'updates',
  },
  {
    name: 'updates-history-after-390-dark',
    theme: 'dark',
    viewport: 'phone',
    scene: 'history',
  },
  {
    name: 'updates-notes-after-390-light',
    theme: 'light',
    viewport: 'phone',
    scene: 'notes',
  },
] as const) {
  test(`learning media ${capture.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mount(page, capture.theme, capture.viewport, 'update', capture.scene);
    if (capture.scene !== 'notes') {
      await page
        .getByRole('button', { name: 'Review updates', exact: true })
        .click();
      await expect(
        page.getByText('Available server improvements.'),
      ).toBeVisible();
    }
    await expect(
      page.getByText('Shows the installed server changelog.'),
    ).toBeVisible();
    if (capture.scene === 'history') {
      await page
        .getByRole('button', {
          name: 'Previous versions and changelogs',
          exact: true,
        })
        .click();
      const release = page.getByRole('combobox', {
        name: 'Release',
        exact: true,
      });
      await release.selectOption('v0.1.10');
      await expect(page.getByText('Earlier server changes.')).toBeVisible();
      await release.scrollIntoViewIfNeeded();
      const box = await release.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      await release.focus();
      await expect(release).toBeFocused();
      await page.keyboard.press('Tab');
    }
    await page.evaluate(async () => {
      await Promise.all(
        document
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await expectNoHorizontalScroll(page);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${capture.name}.png`) });
    const retained = resolve(REPO_ROOT, 'gallery/diagnostics/ux-lane-e/media');
    mkdirSync(retained, { recursive: true });
    copyFileSync(
      testInfo.outputPath(`${capture.name}.png`),
      resolve(retained, `${capture.name}.png`),
    );
  });
}

// Controlled ToastStore input: transition and deduplication behavior is covered
// by the mounted ConnectionBannerSource tests, not claimed by these layouts.
for (const theme of ['light', 'dark'] as const) {
  for (const viewport of ['desktop', 'ownerPhone'] as const) {
    for (const notice of ['lost', 'restored'] as const) {
      test(`connection notice presentation ${notice} (${theme}, ${viewport})`, async ({
        page,
      }, testInfo) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await mount(page, theme, viewport, 'update', `notice-${notice}`);
        await page
          .getByRole('button', { name: 'Show connection notice', exact: true })
          .click();
        const message =
          notice === 'lost'
            ? "Studio didn't answer in time. Reconnecting…"
            : 'Server connection restored.';
        const card = page.locator('.toast-card');
        await expect(card).toContainText(message);
        await expect(card).toBeVisible();
        const box = await card.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          VIEWPORTS[viewport].width,
        );
        await expectNoHorizontalScroll(page);
        await page.screenshot({
          path: testInfo.outputPath(
            `connection-${notice}-${theme}-${viewport}.png`,
          ),
        });
        const retained = resolve(REPO_ROOT, 'gallery/diagnostics/ux-lane-e');
        mkdirSync(retained, { recursive: true });
        copyFileSync(
          testInfo.outputPath(`connection-${notice}-${theme}-${viewport}.png`),
          resolve(retained, `connection-${notice}-${theme}-${viewport}.png`),
        );
      });
    }
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of ['desktop', 'phone', 'ownerPhone'] as const) {
    test(`install-only changelog empty state (${theme}, ${viewport})`, async ({
      page,
    }, testInfo) => {
      await mount(page, theme, viewport, 'update');
      await page.route(
        'https://api.github.com/repos/kontourai/station/releases/tags/**',
        (route) =>
          route.fulfill({
            json: {
              tag_name: decodeURIComponent(
                new URL(route.request().url()).pathname.split('/').at(-1) ?? '',
              ),
              draft: false,
              body: '\n\n## Installation\n\nInstall fixture\n',
            },
          }),
      );
      await page
        .getByRole('button', { name: 'Review updates', exact: true })
        .click();
      const panel = page.getByRole('dialog', { name: 'Updates', exact: true });
      await expect(
        panel.getByText('Release notes unavailable').first(),
      ).toBeVisible();
      await expect(panel.getByText('Install fixture')).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`install-only-${theme}-${viewport}.png`),
      });
    });
  }
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of ['desktop', 'phone', 'ownerPhone'] as const) {
    test(`long changelog is bounded (${theme}, ${viewport})`, async ({
      page,
    }, testInfo) => {
      await mount(page, theme, viewport, 'update', 'long-notes');
      await page
        .getByRole('button', { name: 'Review updates', exact: true })
        .click();
      await expect(
        page.getByText('Release improvement 50', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText('Release improvement 51', { exact: true }),
      ).toHaveCount(0);
      const all = page.getByRole('link', {
        name: 'See all changes',
        exact: true,
      });
      await expect(all).toHaveAttribute(
        'href',
        'https://github.com/kontourai/station/releases/tag/v0.1.11-nightly.246500',
      );
      await all.scrollIntoViewIfNeeded();
      await expect(all).toBeVisible();
      await expectNoHorizontalScroll(page);
      const path = testInfo.outputPath(`long-notes-${theme}-${viewport}.png`);
      await page.screenshot({
        path: testInfo.outputPath(`long-notes-${theme}-${viewport}.png`),
      });
      const retained = resolve(REPO_ROOT, 'gallery/diagnostics/ux-lane-e');
      mkdirSync(retained, { recursive: true });
      copyFileSync(
        path,
        resolve(retained, `long-notes-${theme}-${viewport}.png`),
      );
    });
  }
}
