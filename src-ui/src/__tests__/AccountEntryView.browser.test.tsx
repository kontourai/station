// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Browser,
  chromium,
  type Locator,
  type Page,
  type Route,
} from '@playwright/test';
import { build, loadConfigFromFile } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { UI_MIME_TYPES } from '../../../packages/cli/src/commands/lifecycle';
import { trackTempDirs } from '../../../src-server/__test-utils__/temp-dirs.js';
import {
  type AccountReply,
  accountDescriptor,
  accountSession,
  initialPasskeys,
  type PasskeyListReply,
  type RemovePasskeyRequest,
  removalRefusal,
  removalSuccess,
} from './fixtures/member-passkeys-render';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
const OWNER = 'src-ui/src/views/account/MemberPasskeys.tsx';
const ENTRY = '/virtual/member-passkeys-harness.tsx';
const ORIGIN = 'https://station-passkeys.test';
const hash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const normalized = (path: string) => path.replaceAll('\\', '/');
const ARTIFACTS = resolve(
  ROOT,
  '.kontourai/collaboration/rendered/member-passkeys',
  hash(readFileSync(fileURLToPath(import.meta.url))).slice(0, 12),
);
const CSP = Object.entries(
  require('../../../src-desktop/tauri.conf.json').app.security.csp,
)
  .map(([key, value]) => key + ' ' + value)
  .join('; ');
type Variant = 'candidate';
type Bundle = Map<string, string | Uint8Array>;
let files: Bundle;
let cacheDir: string | undefined;
const makeTempDir = trackTempDirs({ lifetime: 'file' });
type ProbeMapping = {
  sourceFile: string;
  lineNumber: number;
  columnNumber: number;
  sha256: string;
  retainedPath: string;
};
type CspEvent = {
  sourceFile: string;
  sourceIdentityExact: boolean;
  lineNumber: number;
  columnNumber: number;
  effectiveDirective: string;
  violatedDirective: string;
  blockedURI: string;
  disposition: string;
  sample: string;
};
const probeMappings = new Map<Variant, ProbeMapping>();
const PROBE = [
  'const allowsEval = /* @__PURE__ */ cached(() => {',
  '  if (globalConfig.jitless) {',
  '    return false;',
  '  }',
  '  if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) {',
  '    return false;',
  '  }',
  '  try {',
  '    const F = Function;',
  '    new F("");',
  '    return true;',
  '  } catch (_) {',
  '    return false;',
  '  }',
  '});',
].join('\n');

function expectedBlockedProbe(
  event: CspEvent,
  mapping: ProbeMapping,
  count: number,
) {
  return (
    count === 0 &&
    event.sourceIdentityExact &&
    event.sourceFile === mapping.sourceFile &&
    event.lineNumber === mapping.lineNumber &&
    event.columnNumber === mapping.columnNumber &&
    event.effectiveDirective === 'script-src' &&
    event.violatedDirective === 'script-src' &&
    event.blockedURI === 'eval' &&
    event.disposition === 'enforce' &&
    event.sample === ''
  );
}

async function observePage(
  page: Page,
  variant: Variant,
  label: string,
  expectedRefusals = new Set<string>(),
) {
  const mapping = probeMappings.get(variant);
  const problems: string[] = [];
  const diagnostics: unknown[] = [];
  let blockedProbeCount = 0;
  const diagnostic = (entry: unknown) => {
    diagnostics.push(entry);
    observations.push({ variant, label, diagnostic: entry });
  };
  page.on('pageerror', (error) => problems.push('pageerror: ' + error.message));
  page.on('console', (message) => {
    const location = message.location();
    const url = location.url ? new URL(location.url) : undefined;
    diagnostic({
      kind: 'console',
      type: message.type(),
      location: {
        url: url ? url.origin + url.pathname : '',
        lineNumber: location.lineNumber,
        columnNumber: location.columnNumber,
      },
    });
    if (message.text().startsWith('CSP metadata: ')) {
      const event: CspEvent = JSON.parse(
        message.text().slice('CSP metadata: '.length),
      );
      const expected =
        !!mapping && expectedBlockedProbe(event, mapping, blockedProbeCount);
      if (expected) blockedProbeCount++;
      diagnostic({
        kind: 'securitypolicyviolation',
        event,
        disposition: expected ? 'expected-blocked-zod-probe' : 'unexpected',
        mapping,
      });
      if (!expected)
        problems.push(
          'CSP violation: ' + event.violatedDirective + ' ' + event.blockedURI,
        );
    }
    const expectedHttp =
      message.text().startsWith('Failed to load resource') &&
      expectedRefusals.has(location.url);
    if (message.type() === 'error' && !expectedHttp)
      problems.push(message.text());
  });
  page.on('requestfailed', (request) => {
    problems.push(
      'Request failed: ' +
        request.method() +
        ' ' +
        new URL(request.url()).pathname,
    );
    diagnostic({
      kind: 'requestfailed',
      method: request.method(),
      path: new URL(request.url()).pathname,
      errorText: request.failure()?.errorText,
    });
  });
  await page.addInitScript((expectedSource) => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const redactUrl = (value: string) => {
        if (!value.includes('://')) return value;
        const url = new URL(value);
        return url.origin + url.pathname;
      };
      console.debug(
        'CSP metadata: ' +
          JSON.stringify({
            sourceFile: redactUrl(event.sourceFile),
            sourceIdentityExact: event.sourceFile === expectedSource,
            lineNumber: event.lineNumber,
            columnNumber: event.columnNumber,
            effectiveDirective: event.effectiveDirective,
            violatedDirective: event.violatedDirective,
            blockedURI: redactUrl(event.blockedURI),
            disposition: event.disposition,
            sample: event.sample,
          }),
      );
    });
  }, mapping?.sourceFile);
  return {
    problems,
    diagnostics,
    get blockedProbeCount() {
      return blockedProbeCount;
    },
  };
}
const observations: unknown[] = [];
let browser: Browser | undefined;

async function bundle() {
  const loaded = await loadConfigFromFile(
    { command: 'build', mode: 'production' },
    resolve(ROOT, 'vite.config.ts'),
    ROOT,
  );
  if (!loaded)
    throw new Error('BLOCKED: production Vite configuration missing');
  cacheDir = makeTempDir('station-passkey-render-');
  const imports = [
    'src-ui/src/index.css',
    'src-ui/src/views/page-layout.css',
  ].map(
    (path) => 'import ' + JSON.stringify(normalized(resolve(ROOT, path))) + ';',
  );
  const harness = [
    ...imports,
    'import {createRoot} from "react-dom/client";',
    'import {AccountEntryPage} from ' +
      JSON.stringify(
        normalized(
          resolve(ROOT, 'src-ui/src/views/account/AccountEntryView.tsx'),
        ),
      ) +
      ';',
    'document.documentElement.dataset.theme=new URL(location.href).searchParams.get("theme");',
    'createRoot(document.getElementById("root")).render(<AccountEntryPage apiBase={location.origin}/>);',
  ].join('\n');
  const output = await build({
    ...loaded.config,
    configFile: false,
    mode: 'production',
    cacheDir,
    root: resolve(ROOT, 'src-ui'),
    publicDir: resolve(ROOT, 'src-ui/public'),
    plugins: [
      ...(loaded.config.plugins ?? []),
      {
        name: 'account-entry-render',
        enforce: 'pre',
        resolveId: (id) => (id === ENTRY ? id : undefined),
        load: (id) => (id === ENTRY ? harness : undefined),
      },
    ],
    build: {
      ...loaded.config.build,
      write: false,
      minify: false,
      modulePreload: false,
      rollupOptions: { ...loaded.config.build?.rollupOptions, input: ENTRY },
    },
  });
  if (Array.isArray(output) || !('output' in output))
    throw new Error('BLOCKED: expected one component bundle');
  const result: Bundle = new Map();
  const styles = new Set<string>();
  let entry: string | undefined;
  for (const item of output.output) {
    const bytes = item.type === 'chunk' ? item.code : item.source;
    const retained = resolve(ARTIFACTS, 'bundle', item.fileName);
    mkdirSync(dirname(retained), { recursive: true });
    writeFileSync(retained, bytes);
    result.set('/' + item.fileName, bytes);
    observations.push({ asset: item.fileName, sha256: hash(bytes), retained });
    if (item.type === 'chunk' && item.isEntry) {
      entry = item.fileName;
      for (const css of item.viteMetadata?.importedCss ?? []) styles.add(css);
    }
  }
  if (!entry || styles.size === 0)
    throw new Error('BLOCKED: missing production entry/CSS');
  result.set(
    '/',
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="/favicon.png">' +
      [...styles]
        .map((path) => '<link rel="stylesheet" href="/' + path + '">')
        .join('') +
      '</head><body><div id="root"></div><script type="module" src="/' +
      entry +
      '"></script></body></html>',
  );
  const util = readFileSync(
    resolve(dirname(require.resolve('zod/package.json')), 'v4/core/util.js'),
  );
  if (
    hash(util) !==
    'bb08133b11b478c8e715038fff26ebea204d7fd5443fba31fe138b142d202efb'
  )
    throw new Error('BLOCKED: pinned probe source changed');
  const mappings: ProbeMapping[] = [];
  for (const [path, bytes] of result) {
    if (!path.endsWith('.js') || typeof bytes !== 'string') continue;
    const first = bytes.indexOf(PROBE);
    if (first < 0) continue;
    if (bytes.indexOf(PROBE, first + 1) >= 0)
      throw new Error('BLOCKED: duplicate probe body');
    const position = first + PROBE.indexOf('new F("");');
    const prefix = bytes.slice(0, position);
    const retainedPath = resolve(ARTIFACTS, 'bundle', path.slice(1));
    if (hash(readFileSync(retainedPath)) !== hash(bytes))
      throw new Error('BLOCKED: retained probe bytes differ');
    mappings.push({
      sourceFile: ORIGIN + path,
      lineNumber: prefix.split('\n').length,
      columnNumber: position - prefix.lastIndexOf('\n'),
      sha256: hash(bytes),
      retainedPath,
    });
  }
  if (mappings.length > 1)
    throw new Error('BLOCKED: ambiguous current probe mapping');
  if (mappings[0]) probeMappings.set('candidate', mappings[0]);
  observations.push({
    source: '3730c07cd0c6729e4edf0d7040eb9ae70f836c67',
    ownerSha256: hash(readFileSync(resolve(ROOT, OWNER))),
    testSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    fixtureSha256: hash(
      readFileSync(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          'fixtures/member-passkeys-render.ts',
        ),
      ),
    ),
    resourceSha256: hash(
      readFileSync(resolve(ROOT, 'scripts/vitest-resource-manifest.mjs')),
    ),
    configSha256: hash(readFileSync(resolve(ROOT, 'vite.config.ts'))),
    mode: 'production',
    root: resolve(ROOT, 'src-ui'),
    publicDir: resolve(ROOT, 'src-ui/public'),
    envPrefix: loaded.config.envPrefix,
    probeMappings: mappings,
    pinnedUtilSha256: hash(util),
  });
  return result;
}

// The render evidence must come from the exact Chromium build the locked
// Playwright ships, never another cached or system browser. Derive that build
// from playwright-core's own browsers.json (as scripts/lib/pinned-vitest-
// chromium.mjs does) so a Playwright bump moves the pin with it.
function pinnedChromium() {
  const metadata = resolve(
    dirname(require.resolve('playwright-core/package.json')),
    'browsers.json',
  );
  const { browsers } = JSON.parse(readFileSync(metadata, 'utf8')) as {
    browsers: Array<{ name: string; revision: string; browserVersion: string }>;
  };
  const entry = browsers.find((candidate) => candidate.name === 'chromium');
  if (!entry || !/^\d+$/.test(entry.revision) || !entry.browserVersion)
    throw new Error('BLOCKED: Playwright does not identify its Chromium');
  return entry;
}

beforeAll(async () => {
  const executable = chromium.executablePath();
  const pinned = pinnedChromium();
  if (
    !normalized(executable).includes(`/chromium-${pinned.revision}/`) ||
    !existsSync(executable)
  )
    throw new Error(
      `BLOCKED: configured Chromium${pinned.revision} prerequisite`,
    );
  files = await bundle();
  browser = await chromium.launch({ executablePath: executable });
  expect(browser.version()).toBe(pinned.browserVersion);
  observations.push({ executable, browserVersion: browser.version() });
}, 180_000);
function cleanupOwnedCache() {
  if (cacheDir) {
    if (
      !normalized(cacheDir).startsWith(
        normalized(tmpdir()) + '/station-passkey-render-',
      )
    )
      throw new Error('Refusing cleanup outside owned temporary cache');
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(
      resolve(ARTIFACTS, 'manifest.json'),
      JSON.stringify(observations, null, 2),
    );
    cleanupOwnedCache();
  }
});

async function mount(width: number, theme: 'dark' | 'light') {
  if (!browser) throw new Error('BLOCKED: browser unavailable');
  const context = await browser.newContext({
    viewport: { width, height: width === 390 ? 844 : 900 },
  });
  context.setDefaultTimeout(15_000);
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  });
  const page = await context.newPage();
  const expectedRefusals = new Set<string>();
  const collector = await observePage(
    page,
    'candidate',
    `${width}-${theme}`,
    expectedRefusals,
  );
  const requests: Array<{ method: string; path: string; id?: string }> = [];
  let passkeys = initialPasskeys();
  let holdRemoval = false;
  let refuseNext = false;
  const pending: Array<{ route: Route; id: string; done: () => void }> = [];
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== ORIGIN) {
      collector.problems.push('Unexpected origin: ' + url.origin);
      await route.abort();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.headers().authorization) {
        collector.problems.push('Unexpected account bearer');
        await route.abort();
        return;
      }
      requests.push({ method: req.method(), path: url.pathname });
      if (req.method() === 'GET' && url.pathname === '/api/account-auth') {
        const reply: AccountReply<typeof accountDescriptor> = {
          data: accountDescriptor,
        };
        await route.fulfill({ json: reply });
        return;
      }
      if (
        req.method() === 'GET' &&
        url.pathname === '/api/account-auth/session'
      ) {
        const reply: AccountReply<typeof accountSession> = {
          data: accountSession,
        };
        await route.fulfill({ json: reply });
        return;
      }
      if (req.method() === 'GET' && url.pathname === '/api/projects') {
        expectedRefusals.add(req.url());
        await route.fulfill({
          status: 401,
          json: {
            error: {
              code: 'device_approval_required',
              message: 'This browser needs Device approval.',
            },
          },
        });
        return;
      }
      if (
        req.method() === 'POST' &&
        url.pathname === '/api/account-auth/passkey/list'
      ) {
        const reply: AccountReply<PasskeyListReply> = { data: { passkeys } };
        await route.fulfill({ json: reply });
        return;
      }
      if (
        req.method() === 'POST' &&
        url.pathname === '/api/account-auth/passkey/remove'
      ) {
        const body: unknown = req.postDataJSON();
        if (
          !body ||
          typeof body !== 'object' ||
          !('id' in body) ||
          typeof body.id !== 'string' ||
          Object.keys(body).length !== 1 ||
          !passkeys.some((p) => p.id === body.id)
        ) {
          collector.problems.push('Invalid removal request');
          await route.abort();
          return;
        }
        const input: RemovePasskeyRequest = { id: body.id };
        requests[requests.length - 1].id = input.id;
        if (holdRemoval) {
          await new Promise<void>((done) =>
            pending.push({ route, id: input.id, done }),
          );
          return;
        }
        if (refuseNext) {
          refuseNext = false;
          expectedRefusals.add(req.url());
          await route.fulfill({ status: 503, json: removalRefusal });
          return;
        }
        passkeys = passkeys.filter((p) => p.id !== input.id);
        await route.fulfill({ json: removalSuccess });
        return;
      }
      collector.problems.push(
        'Unknown API: ' + req.method() + ' ' + url.pathname,
      );
      await route.fulfill({ status: 501, body: 'Unmodeled API' });
      return;
    }
    const bytes = files.get(url.pathname);
    const asset = resolve(
      ROOT,
      'src-ui/public',
      '.' + decodeURIComponent(url.pathname),
    );
    const allowed =
      normalized(asset).startsWith(
        normalized(resolve(ROOT, 'src-ui/public')) + '/',
      ) && existsSync(asset);
    if (req.method() !== 'GET' || (bytes === undefined && !allowed)) {
      collector.problems.push('Unknown asset: ' + url.pathname);
      await route.fulfill({ status: 501, body: 'Unmodeled asset' });
      return;
    }
    await route.fulfill({
      body:
        typeof bytes === 'string'
          ? bytes
          : Buffer.from(bytes ?? readFileSync(asset)),
      headers: {
        'Content-Type':
          url.pathname === '/'
            ? 'text/html'
            : (UI_MIME_TYPES[extname(url.pathname)] ??
              'application/octet-stream'),
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  const dir = resolve(ARTIFACTS, `${width}-${theme}`);
  mkdirSync(dir, { recursive: true });
  const capture = async (name: string) => {
    const png = resolve(dir, name + '.png');
    await page.screenshot({
      path: png,
      fullPage: true,
    });
    observations.push({
      width,
      theme,
      name,
      png,
      sha256: hash(readFileSync(png)),
      requests: structuredClone(requests),
      diagnostics: structuredClone(collector.diagnostics),
      problems: [...collector.problems],
      expectedBlockedProbeCount: collector.blockedProbeCount,
    });
    expect(collector.problems).toEqual([]);
  };
  return {
    page,
    requests,
    pending,
    capture,
    async start() {
      await page.goto(ORIGIN + '/?theme=' + theme);
      await page.getByText('Laptop A', { exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
    },
    hold() {
      holdRemoval = true;
    },
    async release() {
      expect(pending).toHaveLength(1);
      holdRemoval = false;
      for (const item of pending.splice(0)) {
        passkeys = passkeys.filter((p) => p.id !== item.id);
        await item.route.fulfill({ json: removalSuccess });
        item.done();
      }
    },
    refuse() {
      refuseNext = true;
    },
    async close() {
      for (const item of pending.splice(0)) {
        await item.route.abort();
        item.done();
      }
      const trace = resolve(dir, 'flow.trace.zip');
      try {
        await context.tracing.stop({ path: trace });
        observations.push({
          width,
          theme,
          trace,
          sha256: hash(readFileSync(trace)),
        });
      } finally {
        await context.close();
      }
    },
  };
}

async function geometry(locator: Locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, r.left + r.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, r.top + r.height / 2));
    const hit = document.elementFromPoint(x, y);
    return {
      rect: {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        bottom: r.bottom,
        right: r.right,
      },
      viewport: { width: innerWidth, height: innerHeight },
      scroll: { x: scrollX, y: scrollY },
      hit: !!hit && (el === hit || el.contains(hit)),
      active: el === document.activeElement,
      hitIdentity: hit
        ? {
            tag: hit.tagName,
            role: hit.getAttribute('role'),
            label: hit.getAttribute('aria-label'),
          }
        : null,
    };
  });
}
async function keyboardReach(page: Page, target: Locator) {
  // Initial entry and dialog traversal use the browser's ordinary sequential keyboard order.
  for (let i = 0; i < 40; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard could not reach requested control');
}
async function measureDialog(page: Page, width: number, label: string) {
  const dialog = page.getByRole('alertdialog', {
    name: 'Remove this passkey?',
    exact: true,
  });
  await dialog.waitFor();
  const settlement = await dialog.evaluate(async (root) => {
    const relevant = () =>
      document.getAnimations().filter((animation) => {
        const effect = animation.effect;
        const target = effect instanceof KeyframeEffect ? effect.target : null;
        return (
          target instanceof Element &&
          (root.contains(target) || target.contains(root))
        );
      });
    const assertActive = () => {
      if (
        !root.isConnected ||
        document.visibilityState !== 'visible' ||
        !document.hasFocus()
      )
        throw new Error('Dialog settlement incomplete: root or focus changed');
    };
    const assertFinite = (animations: Animation[]) => {
      if (
        animations.some(
          (animation) =>
            animation.playState === 'paused' ||
            !Number.isFinite(animation.playbackRate) ||
            animation.playbackRate <= 0 ||
            !Number.isFinite(animation.effect?.getComputedTiming().endTime),
        )
      )
        throw new Error('Dialog settlement incomplete: paused or nonfinite');
    };
    assertActive();
    const initial = relevant();
    assertFinite(initial);
    let deadline: number | undefined;
    const frames: number[] = [];
    try {
      await Promise.race([
        (async () => {
          await Promise.all(initial.map((animation) => animation.ready));
          assertActive();
          assertFinite(initial);
          await Promise.all(initial.map((animation) => animation.finished));
          for (let i = 0; i < 2; i++)
            await new Promise<void>((resolveFrame) =>
              requestAnimationFrame((time) => {
                frames.push(time);
                resolveFrame();
              }),
            );
        })(),
        new Promise<never>((_, reject) => {
          deadline = window.setTimeout(
            () => reject(new Error('Dialog settlement incomplete: deadline')),
            2000,
          );
        }),
      ]);
    } finally {
      window.clearTimeout(deadline);
    }
    assertActive();
    const after = relevant();
    assertFinite(after);
    if (
      after.some(
        (animation) =>
          !initial.includes(animation) ||
          animation.pending ||
          animation.playState !== 'finished',
      )
    )
      throw new Error('Dialog settlement incomplete: animation changed');
    return { animationCount: initial.length, frames };
  });
  observations.push({ label, settlement });
  const panel = await geometry(dialog);
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const confirm = dialog.getByRole('button', {
    name: 'Remove passkey',
    exact: true,
  });
  const cancelBox = await geometry(cancel);
  const confirmBox = await geometry(confirm);
  const closeBox = await geometry(
    dialog.getByRole('button', {
      name: 'Close Remove this passkey?',
      exact: true,
    }),
  );
  const overlay = await geometry(page.locator('.station-dialog__overlay'));
  observations.push({
    label,
    panel,
    overlay,
    cancelBox,
    confirmBox,
    closeBox,
    focusInside: await dialog.evaluate((el) =>
      el.contains(document.activeElement),
    ),
  });
  expect(panel.rect.x).toBeGreaterThanOrEqual(0);
  expect(panel.rect.y).toBeGreaterThanOrEqual(0);
  expect(panel.rect.right).toBeLessThanOrEqual(panel.viewport.width);
  expect(panel.rect.bottom).toBeLessThanOrEqual(panel.viewport.height);
  expect(overlay.rect.x).toBe(0);
  expect(overlay.rect.y).toBe(0);
  expect(overlay.rect.right).toBe(overlay.viewport.width);
  expect(overlay.rect.bottom).toBe(overlay.viewport.height);
  expect(cancelBox.hit).toBe(true);
  expect(confirmBox.hit).toBe(true);
  expect(closeBox.hit).toBe(true);
  expect(
    await dialog.evaluate((el) => el.contains(document.activeElement)),
  ).toBe(true);
  if (width === 390) {
    for (const box of [cancelBox, confirmBox, closeBox]) {
      expect(box.rect.width).toBeGreaterThanOrEqual(44);
      expect(box.rect.height).toBeGreaterThanOrEqual(44);
    }
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  return { dialog, cancel, confirm };
}

test('passkey confirmation keyboard and geometry preserve current intent across widths and themes', async () => {
  for (const width of [390, 1440])
    for (const theme of ['dark', 'light'] as const) {
      const fixture = await mount(width, theme);
      const { page } = fixture;
      try {
        await fixture.start();
        const removeA = page
          .getByRole('listitem')
          .filter({ has: page.getByText('Laptop A', { exact: true }) })
          .getByRole('button', { name: 'Remove', exact: true });
        await keyboardReach(page, removeA);
        await page.keyboard.press('Enter');
        let controls = await measureDialog(page, width, 'initial-confirmation');
        await fixture.capture('initial-confirmation');
        await keyboardReach(page, controls.cancel);
        await page.keyboard.press('Enter');
        await controls.dialog.waitFor({ state: 'hidden' });
        await expect
          .poll(() => removeA.evaluate((el) => el === document.activeElement))
          .toBe(true);
        expect(
          fixture.requests.filter((r) => r.path.endsWith('/passkey/remove')),
        ).toHaveLength(0);
        await fixture.capture('cancel-return');
        if (width === 390 && theme === 'dark') {
          fixture.hold();
          await page.keyboard.press('Enter');
          controls = await measureDialog(page, width, 'pending-A');
          await keyboardReach(page, controls.confirm);
          await page.keyboard.press('Enter');
          await expect.poll(() => fixture.pending.length).toBe(1);
          await keyboardReach(page, controls.cancel);
          await page.keyboard.press('Enter');
          await controls.dialog.waitFor({ state: 'hidden' });
          await expect
            .poll(() => removeA.evaluate((el) => el === document.activeElement))
            .toBe(true);
          const removeB = page
            .getByRole('listitem')
            .filter({ has: page.getByText('Laptop B', { exact: true }) })
            .getByRole('button', { name: 'Remove', exact: true });
          await keyboardReach(page, removeB);
          await page.keyboard.press('Enter');
          controls = await measureDialog(page, width, 'current-B');
          await fixture.release();
          await page
            .getByText('Laptop A', { exact: true })
            .waitFor({ state: 'hidden' });
          await measureDialog(page, width, 'B-after-A-success');
          expect(
            await page.getByText('Passkey removed.', { exact: true }).count(),
          ).toBe(0);
          await fixture.capture('B-after-A-success');
          fixture.refuse();
          await keyboardReach(page, controls.confirm);
          await page.keyboard.press('Enter');
          await controls.dialog
            .getByText('Try again in a moment.', { exact: true })
            .waitFor();
          expect(
            await controls.dialog
              .getByText('Passkey removal unavailable.', { exact: true })
              .count(),
          ).toBe(0);
          await measureDialog(page, width, 'B-503-recovery');
          await fixture.capture('B-503-recovery');
          await keyboardReach(page, controls.confirm);
          await page.keyboard.press('Enter');
          await controls.dialog.waitFor({ state: 'hidden' });
          await page
            .getByText('Laptop B', { exact: true })
            .waitFor({ state: 'hidden' });
          await page.getByText('Laptop C', { exact: true }).waitFor();
          await page.getByText('Passkey removed.', { exact: true }).waitFor();
          expect(
            fixture.requests
              .filter((r) => r.path.endsWith('/passkey/remove'))
              .map((r) => r.id),
          ).toEqual(['A', 'B', 'B']);
          await fixture.capture('B-retry-completed-C-remains');
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await fixture.capture('complete');
      } finally {
        await fixture.close();
      }
    }
}, 180_000);
