/**
 * S3 security review, fix round 2: a FIFO in a plugin folder must never hold
 * a build open or block a thread.
 *
 * - A FIFO entrypoint, or a FIFO a source file imports, used to make esbuild's
 *   read wait forever; in the server that held one of the global draft build
 *   slots for good. Both now fail promptly with a diagnostic that names the
 *   importer, not the refused path.
 * - A FIFO named tsconfig.json used to be opened synchronously after an
 *   lstat, blocking the calling thread (the server's event loop). That read
 *   runs here in a child process with a hard timeout, because a regression
 *   would block this test's own thread and hang the suite instead of failing.
 *
 * Real FIFOs need `mkfifo`, so this file spawns processes and is classified
 * process-heavy in `scripts/vitest-resource-manifest.mjs`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildPluginDraft } from '../build.js';

const BUILD_TEST_TIMEOUT_MS = 30_000;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function mkfifo(path: string) {
  execFileSync('mkfifo', [path], { windowsHide: true, timeout: 10_000 });
}

function pluginFolder(): string {
  const dir = tempDir('station-fifo-plugin-');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      name: 'fifo',
      version: '1.0.0',
      entrypoint: './src/index.tsx',
    }),
  );
  return dir;
}

const manifest = {
  name: 'fifo',
  version: '1.0.0',
  entrypoint: './src/index.tsx',
};

describe.skipIf(process.platform === 'win32')(
  'FIFOs in a plugin folder',
  () => {
    test(
      'a FIFO entrypoint fails promptly with a diagnostic',
      async () => {
        const dir = pluginFolder();
        mkfifo(join(dir, 'src', 'index.tsx'));
        const started = Date.now();
        const result = await buildPluginDraft({
          pluginDir: dir,
          outdir: join(tempDir('station-fifo-out-'), '1'),
          registrationKey: 'k',
          manifest,
        });
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.diagnostics[0].text).toContain('not a regular file');
      },
      BUILD_TEST_TIMEOUT_MS,
    );

    test(
      'a FIFO import fails promptly and names the importing file',
      async () => {
        // Under node_modules, which the pre-build sweep skips, so this reaches
        // the onLoad check on every loaded file.
        const dir = pluginFolder();
        writeFileSync(
          join(dir, 'src', 'index.tsx'),
          "import value from 'piped';\nexport const components = { pulse: () => value };\n",
        );
        const pkg = join(dir, 'node_modules', 'piped');
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
          join(pkg, 'package.json'),
          JSON.stringify({ name: 'piped', main: 'index.js' }),
        );
        mkfifo(join(pkg, 'index.js'));
        const result = await buildPluginDraft({
          pluginDir: dir,
          outdir: join(tempDir('station-fifo-out-'), '1'),
          registrationKey: 'k',
          manifest,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.diagnostics[0]).toMatchObject({
          text: expect.stringContaining('not a regular file'),
          file: 'src/index.tsx',
          line: 1,
        });
      },
      BUILD_TEST_TIMEOUT_MS,
    );

    test(
      'a FIFO among the sources is refused by the pre-build sweep, naming it',
      async () => {
        const dir = pluginFolder();
        writeFileSync(join(dir, 'src', 'index.tsx'), 'export {};\n');
        mkfifo(join(dir, 'src', 'pipe.ts'));
        const result = await buildPluginDraft({
          pluginDir: dir,
          outdir: join(tempDir('station-fifo-out-'), '1'),
          registrationKey: 'k',
          manifest,
        });
        expect(result).toMatchObject({
          ok: false,
          diagnostics: [{ file: 'src/pipe.ts' }],
        });
      },
      BUILD_TEST_TIMEOUT_MS,
    );

    test('a FIFO named tsconfig.json is not opened in a way that blocks', () => {
      const dir = pluginFolder();
      mkfifo(join(dir, 'tsconfig.json'));
      const moduleUrl = new URL('../plugin-tsconfig.ts', import.meta.url).href;
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `const { pluginTsconfig } = await import(${JSON.stringify(moduleUrl)});
         process.stdout.write(JSON.stringify(pluginTsconfig(${JSON.stringify(dir)})));`,
        ],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      );
      expect(child.error?.message, 'child timed out (thread blocked)').toBe(
        undefined,
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        tsconfigRaw: { compilerOptions: {} },
        droppedExtends: [],
      });
    });
  },
);
