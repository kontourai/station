import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { buildPlugin } from '../build.js';

const cleanupDirs: string[] = [];
const SUBPROCESS_TEST_TIMEOUT_MS = 15_000;
const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function createPluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-plugin-build-'));
  cleanupDirs.push(root);
  const pluginDir = join(root, 'plugin');
  mkdirSync(pluginDir, { recursive: true });
  return pluginDir;
}

describe('buildPlugin', () => {
  test('rejects manifest.build even when an entrypoint is declared', async () => {
    const pluginDir = createPluginRoot();
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        build: 'echo unsafe',
        entrypoint: 'index.ts',
        name: 'build-plugin',
        version: '1.0.0',
      }),
    );
    writeFileSync(join(pluginDir, 'index.ts'), 'export default {};');

    await expect(buildPlugin(pluginDir)).rejects.toThrow(/manifest\.build/);
  });

  test('rejects entrypoints that escape the plugin root', async () => {
    const pluginDir = createPluginRoot();
    writeFileSync(join(pluginDir, '..', 'outside.ts'), 'export default {};');
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        entrypoint: '../outside.ts',
        name: 'escape-plugin',
        version: '1.0.0',
      }),
    );

    await expect(buildPlugin(pluginDir)).rejects.toThrow(/escapes plugin root/);
  });

  test(
    'rejects symlinked transitive build inputs outside the plugin root',
    async () => {
      const pluginDir = createPluginRoot();
      const outside = join(pluginDir, '..', 'outside.ts');
      writeFileSync(outside, 'export const secret = "outside";');
      symlinkSync(outside, join(pluginDir, 'outside-link.ts'));
      writeFileSync(
        join(pluginDir, 'index.ts'),
        'import { secret } from "./outside-link"; export default secret;',
      );
      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          entrypoint: 'index.ts',
          name: 'symlink-plugin',
          version: '1.0.0',
        }),
      );

      await expect(buildPlugin(pluginDir)).rejects.toThrow(
        /escapes plugin root/,
      );
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  test(
    'bundles a dependency hoisted to the host workspace root (#905)',
    async () => {
      // Shape: <root>/package.json declares workspaces, npm hoisted the
      // plugin's declared dependency to <root>/node_modules — exactly how
      // examples/builder-delivery-viewer resolves @kontourai/surface.
      const pluginDir = createPluginRoot();
      const workspaceRoot = join(pluginDir, '..');
      writeFileSync(
        join(workspaceRoot, 'package.json'),
        JSON.stringify({ name: 'host', workspaces: ['plugin'] }),
      );
      const depDir = join(workspaceRoot, 'node_modules', 'hoisted-dep');
      mkdirSync(depDir, { recursive: true });
      writeFileSync(
        join(depDir, 'package.json'),
        JSON.stringify({
          name: 'hoisted-dep',
          version: '1.0.0',
          main: 'index.js',
        }),
      );
      writeFileSync(join(depDir, 'index.js'), 'module.exports = "hoisted";');
      writeFileSync(
        join(pluginDir, 'index.ts'),
        'import dep from "hoisted-dep"; export default dep;',
      );
      writeFileSync(
        join(pluginDir, 'plugin.json'),
        JSON.stringify({
          entrypoint: 'index.ts',
          name: 'hoisted-dep-plugin',
          version: '1.0.0',
        }),
      );

      await expect(buildPlugin(pluginDir)).resolves.toMatchObject({
        built: true,
      });
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  test.each(['openai-realtime-voice', 'elevenlabs-voice'])(
    'builds the copied %s pack against the host SDK singleton',
    async (packName) => {
      const pluginDir = createPluginRoot();
      cpSync(join(workspaceRoot, 'examples', packName), pluginDir, {
        recursive: true,
      });

      const result = await buildPlugin(pluginDir);
      expect(result).toMatchObject({ built: true });

      const bundle = readFileSync(result.bundlePath as string, 'utf8');
      expect(bundle).toMatch(
        /require\(["']@kontourai\/station-sdk\/voice["']\)/,
      );
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  test('externalizes the supported SDK client entry point', async () => {
    const pluginDir = createPluginRoot();
    writeFileSync(
      join(pluginDir, 'index.ts'),
      'import { listKnowledgeRoots } from "@kontourai/station-sdk/client"; export default listKnowledgeRoots;',
    );
    writePluginManifest(pluginDir, 'sdk-client-plugin');

    const result = await buildPlugin(pluginDir);
    const bundle = readFileSync(result.bundlePath as string, 'utf8');

    expect(bundle).toMatch(
      /require\(["']@kontourai\/station-sdk\/client["']\)/,
    );
  });

  // Nested fixture for workspace-boundary tests: everything — including the
  // "outside the workspace" areas — stays inside one mkdtemp cleanup root, so
  // concurrent runs never touch shared tmp paths.
  function createWorkspaceFixture(): {
    fixtureRoot: string;
    workspaceRoot: string;
    pluginDir: string;
  } {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'station-plugin-ws-'));
    cleanupDirs.push(fixtureRoot);
    const workspaceRoot = join(fixtureRoot, 'workspace');
    const pluginDir = join(workspaceRoot, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(workspaceRoot, 'package.json'),
      JSON.stringify({ name: 'host', workspaces: ['plugin'] }),
    );
    return { fixtureRoot, workspaceRoot, pluginDir };
  }

  function writePluginManifest(pluginDir: string, name: string): void {
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ entrypoint: 'index.ts', name, version: '1.0.0' }),
    );
  }

  function writeDepPackage(depDir: string, name: string, body: string): void {
    mkdirSync(depDir, { recursive: true });
    writeFileSync(
      join(depDir, 'package.json'),
      JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(depDir, 'index.js'), `module.exports = ${body};`);
  }

  test(
    'still rejects node_modules above the host workspace root',
    async () => {
      // A dep dir in an ancestor OUTSIDE the workspace boundary must not
      // become a build input just because it is named node_modules.
      const { fixtureRoot, pluginDir } = createWorkspaceFixture();
      writeDepPackage(
        join(fixtureRoot, 'node_modules', 'outer-dep'),
        'outer-dep',
        '"outer"',
      );
      writeFileSync(
        join(pluginDir, 'index.ts'),
        'import dep from "outer-dep"; export default dep;',
      );
      writePluginManifest(pluginDir, 'outer-dep-plugin');

      await expect(buildPlugin(pluginDir)).rejects.toThrow(
        /escapes plugin root/,
      );
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  test(
    'still rejects a hoisted package that symlinks outside the workspace',
    async () => {
      // realpath containment must hold through node_modules: a link target
      // outside the workspace stays rejected even though the specifier
      // resolves via an allowed node_modules directory.
      const { fixtureRoot, workspaceRoot, pluginDir } =
        createWorkspaceFixture();
      const realTarget = join(fixtureRoot, 'linked-target');
      writeDepPackage(realTarget, 'linked-dep', '"linked"');
      mkdirSync(join(workspaceRoot, 'node_modules'), { recursive: true });
      symlinkSync(
        realTarget,
        join(workspaceRoot, 'node_modules', 'linked-dep'),
      );
      writeFileSync(
        join(pluginDir, 'index.ts'),
        'import dep from "linked-dep"; export default dep;',
      );
      writePluginManifest(pluginDir, 'linked-dep-plugin');

      await expect(buildPlugin(pluginDir)).rejects.toThrow(
        /escapes plugin root/,
      );
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  test(
    'rejects a plugin-level node_modules that is itself a symlink out of the workspace',
    async () => {
      // The review-identified exploit: plugin/node_modules -> outside dir.
      // Without the physical-containment check, realpath would put the link
      // TARGET on the allowlist and bless everything under it.
      const { fixtureRoot, pluginDir } = createWorkspaceFixture();
      const outside = join(fixtureRoot, 'victim-home');
      writeDepPackage(join(outside, 'secret-dep'), 'secret-dep', '"secret"');
      symlinkSync(outside, join(pluginDir, 'node_modules'));
      writeFileSync(
        join(pluginDir, 'index.ts'),
        'import dep from "secret-dep"; export default dep;',
      );
      writePluginManifest(pluginDir, 'linked-modules-plugin');

      await expect(buildPlugin(pluginDir)).rejects.toThrow(
        /escapes plugin root/,
      );
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  test(
    'rejects a workspace-level node_modules that is itself a symlink out of the workspace',
    async () => {
      // Same exploit one level up: <workspace>/node_modules -> outside dir.
      const { fixtureRoot, workspaceRoot, pluginDir } =
        createWorkspaceFixture();
      const outside = join(fixtureRoot, 'victim-store');
      writeDepPackage(join(outside, 'stolen-dep'), 'stolen-dep', '"stolen"');
      symlinkSync(outside, join(workspaceRoot, 'node_modules'));
      writeFileSync(
        join(pluginDir, 'index.ts'),
        'import dep from "stolen-dep"; export default dep;',
      );
      writePluginManifest(pluginDir, 'linked-ws-modules-plugin');

      await expect(buildPlugin(pluginDir)).rejects.toThrow(
        /escapes plugin root/,
      );
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  test('rejects symlinked build output directories outside the plugin root', async () => {
    const pluginDir = createPluginRoot();
    const outsideDist = join(pluginDir, '..', 'outside-dist');
    mkdirSync(outsideDist, { recursive: true });
    symlinkSync(outsideDist, join(pluginDir, 'dist'));
    writeFileSync(join(pluginDir, 'index.ts'), 'export default {};');
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        entrypoint: 'index.ts',
        name: 'output-symlink-plugin',
        version: '1.0.0',
      }),
    );

    await expect(buildPlugin(pluginDir)).rejects.toThrow(
      /output directory escapes plugin root/,
    );
  });
});
