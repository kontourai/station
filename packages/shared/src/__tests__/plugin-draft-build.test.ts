import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, test } from 'vitest';
import { buildPluginDraft } from '../build.js';

// esbuild startup can exceed the default budget on a loaded shared host.
const BUILD_TEST_TIMEOUT_MS = 30_000;
const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

function writeDraft(source: string, name = 'connected-pulse'): string {
  const pluginDir = tempDir('station-draft-src-');
  mkdirSync(join(pluginDir, 'src'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', entrypoint: './src/index.tsx' }),
  );
  writeFileSync(join(pluginDir, 'src', 'index.tsx'), source);
  return pluginDir;
}

const manifest = (name = 'connected-pulse') => ({
  name,
  version: '1.0.0',
  entrypoint: './src/index.tsx',
});

describe('buildPluginDraft', () => {
  test(
    'writes only into the host outdir: no dist/ or node_modules in the author folder',
    async () => {
      const pluginDir = writeDraft(
        "import { useAgents } from '@kontourai/station-sdk';\nexport const components = { pulse: () => String(typeof useAgents) };\n",
      );
      const outdir = join(tempDir('station-draft-out-'), '1');
      const result = await buildPluginDraft({
        pluginDir,
        outdir,
        registrationKey: 'draft_x:1',
        manifest: manifest(),
      });
      expect(result).toMatchObject({ ok: true });
      expect(existsSync(join(outdir, 'bundle.js'))).toBe(true);
      expect(existsSync(join(pluginDir, 'dist'))).toBe(false);
      expect(existsSync(join(pluginDir, 'node_modules'))).toBe(false);
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'registers under the draft global and never touches an installed plugin of the same name',
    async () => {
      const pluginDir = writeDraft(
        "export const components = { pulse: () => 'draft' };\n",
      );
      const outdir = join(tempDir('station-draft-out-'), '1');
      const result = await buildPluginDraft({
        pluginDir,
        outdir,
        registrationKey: 'draft_abc:7',
        manifest: manifest(),
      });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      const installed = { components: { pulse: () => 'installed' } };
      const window: Record<string, any> = {
        __station_ai_shared: {},
        __station_ai_plugins: { 'connected-pulse': installed },
      };
      const sandbox: Record<string, any> = { window, console };
      sandbox.globalThis = sandbox;
      runInNewContext(readFileSync(result.bundlePath, 'utf8'), sandbox);
      // The installed registration is the same object, untouched.
      expect(window.__station_ai_plugins).toEqual({
        'connected-pulse': installed,
      });
      expect(window.__station_ai_plugins['connected-pulse']).toBe(installed);
      expect(
        window.__station_ai_plugin_drafts['draft_abc:7'].components.pulse(),
      ).toBe('draft');
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'reports a dependency that is not installed as a diagnostic instead of fetching it',
    async () => {
      const pluginDir = writeDraft(
        "import leftPad from 'left-pad-not-installed';\nexport const components = { pulse: () => leftPad };\n",
      );
      const result = await buildPluginDraft({
        pluginDir,
        outdir: join(tempDir('station-draft-out-'), '1'),
        registrationKey: 'k',
        manifest: manifest(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]).toMatchObject({
        file: 'src/index.tsx',
        line: 1,
      });
      expect(result.diagnostics[0].text).toContain('left-pad-not-installed');
      expect(existsSync(join(pluginDir, 'node_modules'))).toBe(false);
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'refuses a symlink that reaches outside the plugin folder without naming the host path',
    async () => {
      const outside = tempDir('station-draft-outside-');
      writeFileSync(join(outside, 'secret.ts'), "export default 'secret';\n");
      const pluginDir = writeDraft(
        "import secret from './leak';\nexport const components = { pulse: () => secret };\n",
      );
      symlinkSync(join(outside, 'secret.ts'), join(pluginDir, 'src', 'leak.ts'));
      const result = await buildPluginDraft({
        pluginDir,
        outdir: join(tempDir('station-draft-out-'), '1'),
        registrationKey: 'k',
        manifest: manifest(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const text = result.diagnostics.map((d) => d.text).join('\n');
      expect(text).toContain('outside the plugin folder');
      expect(text).not.toContain(outside);
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test('refuses an output directory inside the author folder', async () => {
    const pluginDir = writeDraft('export const components = {};\n');
    await expect(
      buildPluginDraft({
        pluginDir,
        outdir: join(pluginDir, 'dist'),
        registrationKey: 'k',
        manifest: manifest(),
      }),
    ).rejects.toThrow(/must not be inside the plugin folder/);
    expect(existsSync(join(pluginDir, 'dist'))).toBe(false);
  });
});
