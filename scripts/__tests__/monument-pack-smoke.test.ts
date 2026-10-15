/**
 * The `@kontourai/monument` consumer smoke (#3565), run as the child process
 * the publish workflow and the owner run, against the real package and
 * against tarballs tampered from it. Each rejection is paired with the clean
 * control, which is what binds a non-zero exit to the planted fault rather
 * than to a broken harness. The tampered tarballs start from the real one, so
 * their shape is what `pnpm pack` writes.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  checkConsumerManifest,
  checkPublishConfigParity,
  checkShippedImports,
  checkTarballListing,
  packMonument,
} from '../monument-pack-smoke.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'monument-pack-smoke.mjs');
const CASE_TIMEOUT = 120_000;

const scratch = trackTempDirs({ lifetime: 'file' })(
  'monument-pack-smoke-test-',
);

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function tar(args: string[], cwd: string) {
  const result = spawnSync('tar', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
}

describe('monument pack smoke: checks', () => {
  const GOOD_LISTING = [
    'package/package.json',
    'package/README.md',
    'package/CONTEXT.md',
    'package/LICENSE',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/testing/index.js',
  ];

  it('accepts the shipped file set and names every other kind of file', () => {
    expect(checkTarballListing(GOOD_LISTING)).toEqual([]);
    const bad = checkTarballListing([
      ...GOOD_LISTING,
      'package/dist/__tests__/memory.test.js',
      'package/dist/memory.js.map',
      'package/src/index.ts',
      'package/tsconfig.build.json',
      'other/package.json',
    ]);
    expect(bad).toEqual([
      'tarball ships a test: dist/__tests__/memory.test.js',
      'tarball ships an unexpected file: dist/memory.js.map',
      'tarball ships an unexpected file: src/index.ts',
      'tarball ships an unexpected file: tsconfig.build.json',
      'tarball entry outside package/: other/package.json',
    ]);
  });

  const entry = (name: string) => ({
    types: `./dist/${name}.d.ts`,
    default: `./dist/${name}.js`,
  });
  const GOOD_MANIFEST = {
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports: {
      '.': entry('index'),
      './sqlite': entry('sqlite'),
      './adapter': entry('adapter'),
      './testing': entry('testing/index'),
    },
  };

  it('refuses a consumer manifest that points at TypeScript source, drops an entry or declares a dependency', () => {
    const present = () => true;
    expect(checkConsumerManifest(GOOD_MANIFEST, present)).toEqual([]);
    expect(
      checkConsumerManifest(
        {
          ...GOOD_MANIFEST,
          exports: { ...GOOD_MANIFEST.exports, '.': './src/index.ts' },
        },
        present,
      ),
    ).toEqual([
      'exports[.] must be a ./dist/*.js file, got ./src/index.ts (a published entry point may not be TypeScript source)',
    ]);
    const { './adapter': _dropped, ...fewer } = GOOD_MANIFEST.exports;
    expect(
      checkConsumerManifest({ ...GOOD_MANIFEST, exports: fewer }, present),
    ).toEqual(['exports is missing the ./adapter entry point']);
    expect(
      checkConsumerManifest(
        {
          ...GOOD_MANIFEST,
          dependencies: { '@kontourai/station-shared': '*' },
        },
        present,
      ),
    ).toEqual([
      'dependencies declares @kontourai/station-shared; the package must have none',
    ]);
    expect(
      checkConsumerManifest(
        GOOD_MANIFEST,
        (path) => path !== './dist/sqlite.js',
      ),
    ).toEqual([
      'exports[./sqlite].default names a missing file: ./dist/sqlite.js',
    ]);
  });

  it('requires publishConfig.exports to name the entry points exports does', () => {
    const exportsMap = {
      '.': '',
      './sqlite': '',
      './adapter': '',
      './testing': '',
    };
    expect(
      checkPublishConfigParity({
        exports: exportsMap,
        publishConfig: { exports: exportsMap },
      }),
    ).toEqual([]);
    expect(
      checkPublishConfigParity({
        exports: { ...exportsMap, './extra': '' },
        publishConfig: { exports: exportsMap },
      }),
    ).toEqual([
      'exports (., ./adapter, ./extra, ./sqlite, ./testing) and publishConfig.exports (., ./adapter, ./sqlite, ./testing) name different entry points',
      'exports declares ./extra; add it to ENTRY_POINTS in scripts/monument-pack-smoke.mjs so the smoke covers it',
    ]);
    expect(
      checkPublishConfigParity({ exports: exportsMap, publishConfig: {} }),
    ).toHaveLength(1);
  });

  it('refuses a shipped module that imports Station, a package or a file outside dist', () => {
    const clean = {
      path: 'dist/sqlite.js',
      text: "import { DatabaseSync } from 'node:sqlite';\nexport * from './step.js';\n",
    };
    expect(checkShippedImports([clean])).toEqual([]);
    const failures = checkShippedImports([
      {
        path: 'dist/sqlite.js',
        text: "import '@kontourai/station-shared';\nimport 'left-pad';\nimport '../outside.js';\nexport type * from '@kontourai/station';\n",
      },
    ]);
    expect(failures).toEqual([
      'dist/sqlite.js:1 imports @kontourai/station-shared (a Station package); only node: builtins and dist/ files may ship',
      'dist/sqlite.js:2 imports left-pad; only node: builtins and dist/ files may ship',
      'dist/sqlite.js:3 imports ../outside.js, outside dist/',
      'dist/sqlite.js:4 imports @kontourai/station (a Station package); only node: builtins and dist/ files may ship',
    ]);
  });
});

describe.skipIf(process.platform === 'win32')(
  'monument pack smoke: tarballs',
  () => {
    let good = '';
    const extracted = join(scratch, 'extracted');

    beforeAll(() => {
      const destination = join(scratch, 'good');
      mkdirSync(destination);
      // Builds packages/monument/dist (see SHARED_OUTPUT_VITEST_FILES).
      good = packMonument({ repoRoot: REPO, destination });
      mkdirSync(extracted);
      tar(['-xzf', good, '-C', extracted], REPO);
    }, CASE_TIMEOUT);

    /** The real tarball with `change` applied to its extracted tree. */
    function tamper(name: string, change: (packageDir: string) => void) {
      const copy = join(scratch, name);
      cpSync(extracted, copy, { recursive: true });
      change(join(copy, 'package'));
      const archive = join(scratch, `${name}.tgz`);
      tar(['-czf', archive, '-C', copy, 'package'], REPO);
      return archive;
    }

    const rewriteManifest = (
      packageDir: string,
      change: (manifest: Record<string, any>) => void,
    ) => {
      const path = join(packageDir, 'package.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      change(manifest);
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    };

    it('passes the real package: all four entry points import under plain node and type-check', {
      timeout: CASE_TIMEOUT,
    }, () => {
      // The control for every rejection below.
      const result = run(['--tarball', good]);
      expect(result.output).toContain('OK: @kontourai/monument consumer smoke');
      expect(result.status).toBe(0);
    });

    it('fails when the exports map points back at src/*.ts, and plain node says why', {
      timeout: CASE_TIMEOUT,
    }, () => {
      // The pre-publish-prep shape: TypeScript source shipped under exports.
      const archive = tamper('typescript-exports', (packageDir) => {
        cpSync(
          join(REPO, 'packages', 'monument', 'src'),
          join(packageDir, 'src'),
          {
            recursive: true,
            filter: (path) => !path.includes('__tests__'),
          },
        );
        rewriteManifest(packageDir, (manifest) => {
          manifest.main = './src/index.ts';
          manifest.types = './src/index.ts';
          manifest.exports = {
            '.': './src/index.ts',
            './sqlite': './src/sqlite.ts',
            './adapter': './src/adapter.ts',
            './testing': './src/testing/index.ts',
          };
        });
      });
      const result = run(['--tarball', archive]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        'exports[.] must be a ./dist/*.js file, got ./src/index.ts',
      );
      // The runtime step is not a restatement of the manifest check: it fails
      // on its own, in the Node that a consumer runs.
      expect(result.output).toContain('plain node import failed');
      expect(result.output).toContain(
        'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING',
      );
      expect(result.output).toContain('tarball ships an unexpected file: src/');
    });

    it('fails when exports name compiled files that are not in the tarball', {
      timeout: CASE_TIMEOUT,
    }, () => {
      const archive = tamper('missing-dist', (packageDir) => {
        rmSync(join(packageDir, 'dist', 'sqlite.js'));
      });
      const result = run(['--tarball', archive]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        'exports[./sqlite].default names a missing file: ./dist/sqlite.js',
      );
      expect(result.output).toContain('plain node import failed');
    });

    it('fails when declarations are missing, though plain node still imports', {
      timeout: CASE_TIMEOUT,
    }, () => {
      const archive = tamper('no-declarations', (packageDir) => {
        rmSync(join(packageDir, 'dist', 'index.d.ts'));
      });
      const result = run(['--tarball', archive]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        'types names a missing file: ./dist/index.d.ts',
      );
      expect(result.output).not.toContain('plain node import failed');
      expect(result.output).toContain('type declarations do not resolve');
    });

    it('fails on a shipped test and on a Station import in shipped code', {
      timeout: CASE_TIMEOUT,
    }, () => {
      const archive = tamper('leaks', (packageDir) => {
        mkdirSync(join(packageDir, 'dist', '__tests__'));
        writeFileSync(
          join(packageDir, 'dist', '__tests__', 'memory.test.js'),
          'export {};\n',
        );
        writeFileSync(
          join(packageDir, 'dist', 'leak.js'),
          "import '@kontourai/station-shared';\n",
        );
      });
      const result = run(['--tarball', archive]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        'tarball ships a test: dist/__tests__/memory.test.js',
      );
      expect(result.output).toContain(
        'dist/leak.js:1 imports @kontourai/station-shared (a Station package)',
      );
    });

    it('rejects what `npm pack` makes of the package, which ignores publishConfig.exports', {
      timeout: CASE_TIMEOUT,
    }, () => {
      const destination = join(scratch, 'npm-pack');
      mkdirSync(destination);
      const packed = spawnSync(
        'npm',
        ['pack', '--pack-destination', destination, '--silent'],
        {
          cwd: join(REPO, 'packages', 'monument'),
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      expect(packed.status, packed.stderr).toBe(0);
      const archive = join(
        destination,
        packed.stdout.trim().split('\n').at(-1)!,
      );
      const result = run(['--tarball', archive]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        'a published entry point may not be TypeScript source',
      );
    });

    it('skips while the package is private, smokes once it is not, and refuses unknown arguments', {
      timeout: CASE_TIMEOUT,
    }, () => {
      const manifest = JSON.parse(
        readFileSync(
          join(REPO, 'packages', 'monument', 'package.json'),
          'utf8',
        ),
      );
      // The workflow runs this flag on every publish dispatch. Flipping
      // `private` is the owner's step (#3565); this follows it either way.
      const gated = run(['--if-publishable', '--tarball', good]);
      expect(gated.status, gated.output).toBe(0);
      expect(gated.output).toContain(
        manifest.private === true ? 'SKIP:' : 'OK:',
      );
      expect(run(['--bogus']).status).toBe(2);
    });
  },
);
