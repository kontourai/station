import { mkdirSync, writeFileSync } from 'node:fs';
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
  return { build: JSON.parse(injected) as OfflineBuild, named };
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
