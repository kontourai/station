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
import {
  buildPlugin,
  buildPluginDraft,
  MAX_DRAFT_BUNDLE_BYTES,
} from '../build.js';

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
      symlinkSync(
        join(outside, 'secret.ts'),
        join(pluginDir, 'src', 'leak.ts'),
      );
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
      // Attributed to the author's importing file, not to Station's own hook.
      expect(result.diagnostics[0]).toMatchObject({
        text: expect.stringContaining('This import resolves outside'),
        file: 'src/index.tsx',
        line: 1,
      });
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  // S3 review HIGH-2: esbuild used to read tsconfig.json itself and follow
  // `extends` anywhere on the host, echoing the first token of a non-JSON
  // file in the build error that every Project member can read.
  test.each([
    ['a non-JSON host file', 'TOPSECRET_token_value = 1\n'],
    ['a JSON host file', '{"compilerOptions":{"jsxFactory":"TOPSECRET"}}'],
  ])(
    'an extends outside the plugin folder (%s) is never read into diagnostics or the bundle',
    async (_label, secret) => {
      const outside = tempDir('station-draft-secret-');
      const secretFile = join(outside, 'secret.cfg');
      writeFileSync(secretFile, secret);
      const pluginDir = writeDraft(
        "export const components = { pulse: () => 'draft' };\n",
      );
      writeFileSync(
        join(pluginDir, 'tsconfig.json'),
        JSON.stringify({ extends: secretFile }),
      );
      const result = await buildPluginDraft({
        pluginDir,
        outdir: join(tempDir('station-draft-out-'), '1'),
        registrationKey: 'k',
        manifest: manifest(),
      });
      const observable = result.ok
        ? readFileSync(result.bundlePath, 'utf8')
        : JSON.stringify(result.diagnostics);
      expect(observable).not.toContain('TOPSECRET');
      expect(result.ok).toBe(true);
      // Said, not silently ignored: the author learns the extends was dropped.
      if (result.ok)
        expect(result.warnings?.[0]).toMatchObject({
          file: 'tsconfig.json',
          text: expect.stringContaining('was not applied'),
        });
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'honors the author tsconfig inside the folder, including a contained extends and paths, and drops paths that leave it',
    async () => {
      const outside = tempDir('station-draft-outside-src-');
      writeFileSync(join(outside, 'leak.ts'), "export default 'leaked';\n");
      const pluginDir = writeDraft(
        "import value from '@lib/value';\nexport const components = { pulse: () => value };\n",
      );
      mkdirSync(join(pluginDir, 'src', 'lib'), { recursive: true });
      writeFileSync(
        join(pluginDir, 'src', 'lib', 'value.ts'),
        "export default 'aliased';\n",
      );
      writeFileSync(
        join(pluginDir, 'tsconfig.base.json'),
        // Comments and a trailing comma, as tsconfig allows.
        '{\n  // shared\n  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"], }, },\n}\n',
      );
      writeFileSync(
        join(pluginDir, 'tsconfig.json'),
        JSON.stringify({ extends: './tsconfig.base.json' }),
      );
      const ok = await buildPluginDraft({
        pluginDir,
        outdir: join(tempDir('station-draft-out-'), '1'),
        registrationKey: 'k',
        manifest: manifest(),
      });
      if (!ok.ok) throw new Error(JSON.stringify(ok.diagnostics));
      expect(readFileSync(ok.bundlePath, 'utf8')).toContain('aliased');

      writeFileSync(
        join(pluginDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: { '@lib/*': [`${outside}/*`] },
          },
        }),
      );
      writeFileSync(
        join(pluginDir, 'src', 'index.tsx'),
        "import value from '@lib/leak';\nexport const components = { pulse: () => value };\n",
      );
      const refused = await buildPluginDraft({
        pluginDir,
        outdir: join(tempDir('station-draft-out-'), '2'),
        registrationKey: 'k',
        manifest: manifest(),
      });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).not.toContain('leaked');
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'ships no source map, whose sources would reveal host storage layout',
    async () => {
      const pluginDir = writeDraft(
        "export const components = { pulse: () => 'draft' };\n",
      );
      const result = await buildPluginDraft({
        pluginDir,
        outdir: join(tempDir('station-draft-out-'), '1'),
        registrationKey: 'k',
        manifest: manifest(),
      });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      expect(readFileSync(result.bundlePath, 'utf8')).not.toContain(
        'sourceMappingURL',
      );
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'refuses a revision over the size cap with a diagnostic',
    async () => {
      const pluginDir = writeDraft(
        `export const components = { pulse: () => ${JSON.stringify('x'.repeat(MAX_DRAFT_BUNDLE_BYTES + 1))} };\n`,
      );
      const outdir = join(tempDir('station-draft-out-'), '1');
      const result = await buildPluginDraft({
        pluginDir,
        outdir,
        registrationKey: 'k',
        manifest: manifest(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0].text).toContain('preview limit');
      expect(existsSync(outdir)).toBe(false);
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'an install build also reports a dropped tsconfig extends as a warning',
    async () => {
      const outside = tempDir('station-install-outside-');
      writeFileSync(join(outside, 'base.json'), '{"compilerOptions":{}}');
      const pluginDir = writeDraft(
        "export const components = { pulse: () => 'installed' };\n",
      );
      writeFileSync(
        join(pluginDir, 'tsconfig.json'),
        JSON.stringify({ extends: join(outside, 'base.json') }),
      );
      const result = await buildPlugin(pluginDir, 'production', manifest());
      expect(result.built).toBe(true);
      expect(result.warnings).toEqual([
        expect.stringContaining(
          `extends ${JSON.stringify(join(outside, 'base.json'))} was not applied`,
        ),
      ]);
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
