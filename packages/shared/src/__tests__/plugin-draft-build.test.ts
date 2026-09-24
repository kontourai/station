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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildPlugin,
  buildPluginDraft,
  MAX_DRAFT_BUNDLE_BYTES,
  readPluginBuildManifest,
} from '../build.js';

// esbuild startup can exceed the default budget on a loaded shared host.
const BUILD_TEST_TIMEOUT_MS = 30_000;
const cleanupDirs: string[] = [];
const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

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

/**
 * Stands in for the host's `import * as X` namespaces: like a real module
 * namespace it takes no new properties, so a strict-mode write throws.
 */
function moduleNamespace(exports: Record<string, unknown>): object {
  const namespace = Object.assign(Object.create(null), exports);
  Object.defineProperty(namespace, Symbol.toStringTag, { value: 'Module' });
  return Object.preventExtensions(namespace);
}

/** Runs a built bundle the way the page does, with the host's shared modules. */
function loadBundle(bundlePath: string): Record<string, any> {
  const noop = () => undefined;
  const jsxRuntime = moduleNamespace({ jsx: noop, jsxs: noop, Fragment: noop });
  const window: Record<string, any> = {
    __station_ai_shared: {
      react: moduleNamespace({
        createContext: noop,
        useState: noop,
        useEffect: noop,
      }),
      'react/jsx-runtime': jsxRuntime,
      'react/jsx-dev-runtime': jsxRuntime,
      '@kontourai/station-sdk': moduleNamespace({ useAgents: () => 'agents' }),
    },
  };
  const sandbox: Record<string, any> = { window, console };
  sandbox.globalThis = sandbox;
  runInNewContext(readFileSync(bundlePath, 'utf8'), sandbox);
  return window;
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

  test(
    'the size cap counts CSS too: tiny JS plus oversized CSS is refused and its output removed',
    async () => {
      const pluginDir = writeDraft(
        "import './big.css';\nexport const components = { pulse: () => 'x' };\n",
      );
      writeFileSync(
        join(pluginDir, 'src', 'big.css'),
        `.a{content:"${'x'.repeat(MAX_DRAFT_BUNDLE_BYTES)}"}\n`,
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

  // S3 verifier G11: esbuild parses package.json files above the plugin root
  // on its own. A malformed one there is quoted in esbuild's error, so the
  // build layer must replace it with a generic message.
  test(
    'a malformed package.json outside the plugin root is reported without its contents',
    async () => {
      const parent = tempDir('station-draft-parent-');
      writeFileSync(
        join(parent, 'package.json'),
        '{ "name": "SENTINEL_PARENT_SECRET", broken',
      );
      const pluginDir = join(parent, 'plugin');
      mkdirSync(join(pluginDir, 'src'), { recursive: true });
      writeFileSync(
        join(pluginDir, 'src', 'index.tsx'),
        "export const components = { pulse: () => 'x' };\n",
      );
      const result = await buildPluginDraft({
        pluginDir,
        outdir: join(tempDir('station-draft-out-'), '1'),
        registrationKey: 'k',
        manifest: manifest(),
      });
      expect(result).toEqual({
        ok: false,
        diagnostics: [
          {
            text: 'A file outside the plugin folder could not be read or parsed while building.',
          },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('SENTINEL_PARENT_SECRET');
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'diagnostic text is bounded and never names the plugin root',
    async () => {
      const long = `missing-${'y'.repeat(2_000)}`;
      const pluginDir = writeDraft('export {};\n');
      // An absolute import makes esbuild quote the host path in its message.
      writeFileSync(
        join(pluginDir, 'src', 'index.tsx'),
        `import a from '${long}';\nimport b from '${join(pluginDir, 'src', 'nope.ts')}';\nexport const components = { pulse: () => a + b };\n`,
      );
      const result = await buildPluginDraft({
        pluginDir,
        outdir: join(tempDir('station-draft-out-'), '1'),
        registrationKey: 'k',
        manifest: manifest(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics.length).toBeGreaterThanOrEqual(2);
      for (const diagnostic of result.diagnostics) {
        expect(diagnostic.text.length).toBeLessThanOrEqual(501);
        expect(diagnostic.text).not.toContain(pluginDir);
      }
      expect(result.diagnostics.some((d) => d.text.endsWith('…'))).toBe(true);
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'a strict-mode plugin loads against the host module namespaces it imports',
    async () => {
      // The host publishes live ES module namespaces (`import * as SDK`), which
      // refuse new properties. A plugin tsconfig with `strict` reaches the
      // shared-external shim through `tsconfigRaw`, so the shim must not
      // assign to them outright.
      const pluginDir = writeDraft(
        "import { useAgents } from '@kontourai/station-sdk';\nimport { jsx } from 'react/jsx-runtime';\nexport const components = { pulse: () => useAgents() + ':' + typeof jsx };\n",
      );
      writeFileSync(
        join(pluginDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      const outdir = join(tempDir('station-draft-out-'), '1');
      const result = await buildPluginDraft({
        pluginDir,
        outdir,
        registrationKey: 'draft_strict:1',
        manifest: manifest(),
      });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      const window = loadBundle(result.bundlePath);
      expect(
        window.__station_ai_plugin_drafts['draft_strict:1'].components.pulse(),
      ).toBe('agents:function');
    },
    BUILD_TEST_TIMEOUT_MS,
  );

  test(
    'every bundled registry plugin loads against the host module namespaces',
    async () => {
      // The fresh-home walkthrough installs these same plugins; a bundle that
      // throws while loading is a page error on every route after install.
      const registryDir = join(workspaceRoot, 'examples/registry');
      const registry = JSON.parse(
        readFileSync(join(registryDir, 'default.json'), 'utf8'),
      ) as { plugins: Array<{ id: string; source: string }> };
      const bundled = registry.plugins.flatMap((plugin) => {
        const pluginDir = resolve(registryDir, plugin.source);
        const pluginManifest = readPluginBuildManifest(pluginDir);
        return pluginManifest.entrypoint
          ? [{ ...plugin, pluginDir, pluginManifest }]
          : [];
      });
      // Pinned independently, so a plugin dropping its bundle cannot quietly
      // shrink this loop. minimal-layout is the one with a strict tsconfig.
      expect(bundled.map((plugin) => plugin.id).sort()).toEqual([
        'coding-starter',
        'demo-layout',
        'getting-started-starter',
        'knowledge-docs-starter',
        'minimal-layout',
      ]);
      for (const { id, pluginDir, pluginManifest } of bundled) {
        const registrationKey = `draft_${id}:1`;
        const result = await buildPluginDraft({
          pluginDir,
          outdir: join(tempDir('station-draft-out-'), id),
          registrationKey,
          manifest: pluginManifest,
        });
        if (!result.ok) {
          throw new Error(`${id}: ${JSON.stringify(result.diagnostics)}`);
        }
        let window: Record<string, any>;
        try {
          window = loadBundle(result.bundlePath);
        } catch (error) {
          throw new Error(`${id} threw while loading: ${error}`);
        }
        expect(
          window.__station_ai_plugin_drafts?.[registrationKey],
          id,
        ).toBeTruthy();
      }
    },
    BUILD_TEST_TIMEOUT_MS * 2,
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
