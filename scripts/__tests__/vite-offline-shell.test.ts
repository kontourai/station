import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, type Rollup } from 'vite';
import { expect, it } from 'vitest';
import {
  UI_IMMUTABLE_ASSET_PATTERN,
  uiDocumentContentSecurityPolicy,
} from '../../packages/shared/src/ui-document-policy';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs';
import { offlineShell } from '../vite-offline-shell';

const makeTempDir = trackTempDirs({
  base: path.resolve('node_modules/.cache'),
});

interface OfflineBuild {
  precache: string[];
  warm: string[];
  immutable: string;
  csp: string;
}

async function buildFixture(warmModules: readonly string[]) {
  mkdirSync(path.resolve('node_modules/.cache'), { recursive: true });
  const root = makeTempDir('station-offline-shell-');
  writeFileSync(
    path.join(root, 'index.html'),
    '<head></head><body><script type="module" src="/main.js"></script></body>',
  );
  writeFileSync(
    path.join(root, 'main.js'),
    "import './main.css'; document.addEventListener('click', () => [import('./chat.js'), import('./settings.js')]);",
  );
  writeFileSync(path.join(root, 'main.css'), '.main { color: red; }');
  writeFileSync(
    path.join(root, 'chat.js'),
    "import './chat.css'; import { shared } from './shared.js'; export const chat = shared('chat');",
  );
  writeFileSync(path.join(root, 'chat.css'), '.chat { color: blue; }');
  writeFileSync(
    path.join(root, 'settings.js'),
    "import './settings.css'; import { shared } from './shared.js'; export const settings = shared('settings');",
  );
  writeFileSync(path.join(root, 'settings.css'), '.settings { color: green; }');
  writeFileSync(
    path.join(root, 'shared.js'),
    'export const shared = (name) => [name, Date.now()].join(":");',
  );
  const result = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [offlineShell({ warmModules })],
    build: { write: false, minify: false },
  });
  if (!('output' in result)) throw new Error('Expected one Vite build output');
  const outputs = result.output as (Rollup.OutputAsset | Rollup.OutputChunk)[];
  const worker = outputs.find((output) => output.fileName === 'sw.js');
  if (worker?.type !== 'asset') throw new Error('Expected the worker asset');
  const injected = String(worker.source).match(
    /const OFFLINE_BUILD = (\{.*?\});/,
  )?.[1];
  if (!injected) throw new Error('Expected an injected offline build');
  const named = (pattern: RegExp) =>
    outputs
      .filter((output) => pattern.test(output.fileName))
      .map((output) => `/${output.fileName}`);
  const asset = (fileName: string) => {
    const output = outputs.find((candidate) => candidate.fileName === fileName);
    if (output?.type !== 'asset') throw new Error(`Expected ${fileName}`);
    return String(output.source);
  };
  return { build: JSON.parse(injected) as OfflineBuild, named, asset };
}

it('precaches each chunk with its own stylesheet and warms a named lazy graph', async () => {
  const { build: offline, named } = await buildFixture(['chat.js']);
  const [mainCss] = named(/^assets\/index-.*\.css$/);
  const [chatJs] = named(/^assets\/chat-.*\.js$/);
  const [chatCss] = named(/^assets\/chat-.*\.css$/);
  const [sharedJs] = named(/^assets\/shared-.*\.js$/);
  const settings = named(/^assets\/settings-/);
  expect(mainCss && chatJs && chatCss && sharedJs).toBeTruthy();
  expect(settings).toHaveLength(2);

  // The shell keeps the entry's stylesheet, not every lazy one.
  expect(offline.precache).toContain(mainCss);
  for (const lazy of [chatJs, chatCss, ...settings])
    expect(offline.precache).not.toContain(lazy);
  // The warm graph carries its stylesheet and shared chunk, nothing unnamed.
  expect(offline.warm).toEqual(
    expect.arrayContaining([chatJs, chatCss, sharedJs]),
  );
  for (const other of settings) expect(offline.warm).not.toContain(other);
  for (const file of offline.warm) expect(offline.precache).not.toContain(file);

  // The worker receives the listener's own rules.
  expect(offline.immutable).toBe(UI_IMMUTABLE_ASSET_PATTERN.source);
  expect(offline.csp).toBe(uiDocumentContentSecurityPolicy());
});

it('refuses a warm module the bundle does not contain', async () => {
  await expect(buildFixture(['missing-surface.js'])).rejects.toThrow(
    'Offline warm module not in the bundle: missing-surface.js',
  );
});

it('skips a warm module outside the build root, which belongs to another build', async () => {
  // The app's configuration names its own sources; a fixture that reuses it
  // under another root has none of them and still builds.
  const { build: offline } = await buildFixture([
    path.resolve('src-ui/src/components/chat-dock/ChatDock.tsx'),
  ]);
  expect(offline.warm).toEqual([]);
});

it('links an installable manifest whose icons ship in the UI public directory', async () => {
  const { build: offline, asset } = await buildFixture([]);
  const html = asset('index.html');
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  expect(html).toContain(
    '<link rel="apple-touch-icon" href="/icons/station-maskable-512.png">',
  );
  // The offline fallback is the same document, so it links the manifest too.
  expect(JSON.parse(asset('offline-shell.json')).html).toContain(
    'rel="manifest"',
  );
  expect(offline.precache).toContain('/manifest.webmanifest');
  const manifest = JSON.parse(asset('manifest.webmanifest')) as {
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };
  expect(manifest).toMatchObject({ start_url: '/', display: 'standalone' });
  const publicDir = path.resolve('src-ui/public');
  for (const icon of manifest.icons)
    expect(existsSync(path.join(publicDir, icon.src)), icon.src).toBe(true);
  const sizes = (purpose?: string) =>
    manifest.icons
      .filter((icon) => icon.purpose === purpose)
      .map((icon) => icon.sizes);
  expect(sizes()).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect(sizes('maskable')).toEqual(['512x512']);
});
