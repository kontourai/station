/**
 * The `@kontourai/monument` consumer smoke (#3565), run as the child process
 * the publish workflow and the owner run, against the real package and
 * against tarballs tampered from it. Each rejection is paired with the clean
 * control, which is what binds a non-zero exit to the planted fault rather
 * than to a broken harness. The tampered tarballs start from the real one, so
 * their shape is what `pnpm pack` writes.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  checkConsumerManifest,
  checkPublishConfigParity,
  checkShippedImports,
  checkTarballListing,
  packMonument,
  plainEnvironment,
  run as runStep,
  smokePackage,
} from '../monument-pack-smoke.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'monument-pack-smoke.mjs');
const CASE_TIMEOUT = 120_000;

const scratch = trackTempDirs({ lifetime: 'file' })(
  'monument-pack-smoke-test-',
);

async function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = await runStep(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    env,
    timeoutMs: CASE_TIMEOUT,
  });
  return {
    status: result.ok ? result.status : result.status || 1,
    output: `${result.stdout}${result.stderr}${result.ok ? '' : `\n${result.describe()}`}`,
  };
}

function readFixturePid(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!/^[1-9]\d*$/.test(text)) return undefined;
  const pid = Number(text);
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid
    ? pid
    : undefined;
}

function killFixturePid(path: string, errors: unknown[]) {
  try {
    const pid = readFixturePid(path);
    if (pid !== undefined) process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(error);
  }
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
        (path: string) => path !== './dist/sqlite.js',
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

describe('monument pack smoke: the public gate', () => {
  const WORKFLOW = join(REPO, '.github', 'workflows', 'publish-packages.yml');
  const manifestDir = trackTempDirs({ lifetime: 'file' })('monument-gate-');
  const gate = (manifest: string, env: NodeJS.ProcessEnv = process.env) => {
    const path = join(manifestDir, 'package.json');
    writeFileSync(path, manifest);
    return run(['--is-public', '--manifest', path], env);
  };

  it('reports private as public=false and anything else as public=true', async () => {
    for (const [manifest, expected] of [
      ['{"name":"x","private":true}', 'false'],
      // The preflight skips any truthy `private`, so the gate does too.
      ['{"name":"x","private":"true"}', 'false'],
      ['{"name":"x","private":1}', 'false'],
      ['{"name":"x","private":false}', 'true'],
      ['{"name":"x"}', 'true'],
    ] as const) {
      const result = await gate(manifest);
      expect(result.status, `${manifest}: ${result.output}`).toBe(0);
      expect(result.output.trim(), manifest).toBe(`public=${expected}`);
    }
  });

  it('fails closed on a manifest it cannot read, with no output line', async () => {
    for (const manifest of ['{', '', '[]', 'null', '"private"']) {
      const result = await gate(manifest);
      expect(result.status, manifest).toBe(1);
      expect(result.output).toContain('FAIL: cannot read');
      expect(result.output).not.toContain('public=');
    }
    const missing = await run([
      '--is-public',
      '--manifest',
      join(manifestDir, 'none'),
    ]);
    expect(missing.status).toBe(1);
  });

  it('appends the line to GITHUB_OUTPUT', async () => {
    const output = join(manifestDir, 'github-output');
    writeFileSync(output, 'earlier=1\n');
    const result = await gate('{"name":"x"}', {
      ...process.env,
      GITHUB_OUTPUT: output,
    });
    expect(result.status, result.output).toBe(0);
    expect(readFileSync(output, 'utf8')).toBe('earlier=1\npublic=true\n');
  });

  it('gates the build and the smoke in the workflow on a dispatch AND a public package', () => {
    const workflow = parse(readFileSync(WORKFLOW, 'utf8'));
    const steps: Array<Record<string, any>> = workflow.jobs.publish.steps;
    const index = (name: string) => steps.findIndex((s) => s.name === name);
    const gateStep = steps[index('Is Monument public?')];
    const build = steps[index('Build Monument')];
    const smoke = steps[index('Smoke the Monument tarball')];
    expect(gateStep.id).toBe('monument');
    expect(gateStep.run).toBe(
      'node scripts/monument-pack-smoke.mjs --is-public',
    );
    expect(gateStep.if).toBeUndefined();
    // The gate precedes what it gates, and what it gates precedes the publish.
    const changesets = steps.findIndex((s) => s.id === 'changesets');
    expect(index('Is Monument public?')).toBeLessThan(index('Build Monument'));
    expect(index('Build Monument')).toBeLessThan(
      index('Smoke the Monument tarball'),
    );
    expect(index('Smoke the Monument tarball')).toBeLessThan(changesets);

    // Evaluate each `if` the way Actions does for `a == 'b' && c == 'd'`.
    const runs = (condition: string, context: Record<string, string>) =>
      condition.split(' && ').every((clause) => {
        const [left, right] = clause.split(' == ');
        expect(right).toMatch(/^'(true|false)'$/);
        const value = context[left.trim()];
        return value !== undefined && value === right.slice(1, -1);
      });
    const state = (publishRun: string, isPublic: string) => ({
      'env.PUBLISH_RUN': publishRun,
      'steps.monument.outputs.public': isPublic,
    });
    for (const step of [build, smoke]) {
      // private: skipped, on a dispatch and on a push
      expect(runs(step.if, state('true', 'false'))).toBe(false);
      expect(runs(step.if, state('false', 'false'))).toBe(false);
      // public: runs on a dispatch, not on a push (the version PR)
      expect(runs(step.if, state('true', 'true'))).toBe(true);
      expect(runs(step.if, state('false', 'true'))).toBe(false);
    }
    // The gate step never ran (unset output) leaves both skipped.
    expect(runs(build.if, { 'env.PUBLISH_RUN': 'true' })).toBe(false);
  });
});

describe('monument pack smoke: bounds and credentials', () => {
  it('kills a hung step at its bound and reports it as a timeout, never a pass', async () => {
    const started = Date.now();
    const step = await runStep(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 400 },
    );
    expect(step.ok).toBe(false);
    expect(step.timedOut).toBe(true);
    expect(step.describe()).toContain(
      'timed out after 400 ms and owned tree was settled',
    );
    expect(Date.now() - started).toBeLessThan(30_000);
    // The control: the same helper passes a step that finishes.
    const fine = await runStep(process.execPath, ['-e', '0'], {
      timeoutMs: 30_000,
    });
    expect(fine.ok).toBe(true);
    expect(fine.timedOut).toBe(false);
  });

  it('settles a timed-out launcher and its live descendant before returning', async ({
    task,
  }) => {
    const launcherPath = join(scratch, 'timeout-launcher.pid');
    const descendantPath = join(scratch, 'timeout-descendant.pid');
    const heartbeat = join(scratch, 'timeout-heartbeat');
    const descendant = `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(descendantPath)}, String(process.pid));
      setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'x'), 25);`;
    const launcher = `const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(launcherPath)}, String(process.pid));
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
        { stdio: 'inherit', windowsHide: true });
      setInterval(() => {}, 1000);`;
    const pids: number[] = [];
    const cleanupErrors: unknown[] = [];
    try {
      const step = await runStep(process.execPath, ['-e', launcher], {
        timeoutMs: Math.min(10_000, Math.floor(task.timeout / 6)),
      });
      for (const path of [launcherPath, descendantPath]) {
        const pid = readFixturePid(path);
        if (pid === undefined)
          throw new Error(`fixture did not publish a complete PID: ${path}`);
        pids.push(pid);
      }
      expect(step.ok).toBe(false);
      expect(step.timedOut).toBe(true);
      const stopped = readFileSync(heartbeat, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(
        readFileSync(heartbeat, 'utf8'),
        'descendant output must stop before the step returns',
      ).toBe(stopped);
      for (const pid of pids) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          alive = false;
        }
        expect(alive, `owned process ${pid} must be gone`).toBe(false);
      }
    } finally {
      // The pre-fix negative leaves a live descendant; own that cleanup too.
      for (const path of [launcherPath, descendantPath])
        killFixturePid(path, cleanupErrors);
    }
    expect(cleanupErrors, 'owned negative-control cleanup').toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'an interrupt during timeout settlement remains terminal',
    async ({ task }) => {
      const continued = join(scratch, 'continued-after-timeout-interrupt');
      const target = `process.on('SIGTERM', () => {
      process.kill(process.ppid, 'SIGTERM');
      setTimeout(() => process.exit(0), 100);
    }); setInterval(() => {}, 1000);`;
      const driver = `import {run} from ${JSON.stringify(new URL('../monument-pack-smoke.mjs', import.meta.url).href)};
      import {writeFileSync} from 'node:fs';
      try { await run(process.execPath, ['-e', ${JSON.stringify(target)}], {timeoutMs:1000});
        writeFileSync(${JSON.stringify(continued)}, 'continued');process.exitCode=2;
      } catch(error) {console.log(error.code);process.exitCode=1;}`;
      const result = await runStep(
        process.execPath,
        ['--input-type=module', '--eval', driver],
        { timeoutMs: task.timeout / 2 },
      );
      expect(result.status, result.describe()).toBe(1);
      expect(result.stdout).toContain('MONUMENT_PROCESS_INTERRUPTED');
      expect(
        existsSync(continued),
        'interruption must stop continuation even after timeout',
      ).toBe(false);
    },
  );

  it('never turns an incomplete fixture PID record into a process-group signal', () => {
    const path = join(scratch, 'incomplete-fixture.pid');
    const errors: unknown[] = [];
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      for (const text of [
        '',
        ' ',
        '0',
        '-2',
        '1.5',
        '1',
        String(process.pid),
        '9007199254740992',
      ]) {
        writeFileSync(path, text);
        killFixturePid(path, errors);
      }
      killFixturePid(join(scratch, 'missing-fixture.pid'), errors);
      expect(kill).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
      writeFileSync(path, '12345');
      killFixturePid(path, errors);
      expect(kill).toHaveBeenCalledExactlyOnceWith(12345, 'SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('removes publish credentials and loaders, and keeps ordinary variables', () => {
    const env = plainEnvironment({
      PATH: '/bin',
      HOME: '/home/x',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'u',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't',
      NODE_AUTH_TOKEN: 'n',
      NPM_ID_TOKEN: 'i',
      NPM_TOKEN: 'x',
      GITHUB_TOKEN: 'g',
      'npm_config_//registry.npmjs.org/:_authToken': 'a',
      npm_config__authToken: 'a',
      NPM_CONFIG__AUTH: 'a',
      NODE_OPTIONS: '--import tsx',
      NODE_PATH: '/x',
      TSX_TSCONFIG_PATH: '/x',
      npm_config_registry: 'https://registry.npmjs.org',
    });
    expect(Object.keys(env).sort()).toEqual([
      'HOME',
      'PATH',
      'STATION_TYPECHECK_INCREMENTAL',
      'npm_config_registry',
    ]);
  });
});

describe.skipIf(process.platform === 'win32')(
  'monument pack smoke: tarballs',
  () => {
    let good = '';
    const extracted = join(scratch, 'extracted');

    beforeAll(async () => {
      const destination = join(scratch, 'good');
      mkdirSync(destination);
      // Builds packages/monument/dist (see SHARED_OUTPUT_VITEST_FILES).
      good = await packMonument({ repoRoot: REPO, destination });
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
    }, async () => {
      // The control for every rejection below.
      const result = await run(['--tarball', good]);
      expect(result.output).toContain('OK: @kontourai/monument consumer smoke');
      expect(result.status).toBe(0);
    });

    it('an interrupt settles the consumer tree and never launches the typecheck', async ({
      task,
    }) => {
      const marker = join(scratch, 'cancel-consumer-ready');
      const descendantPid = join(scratch, 'cancel-descendant.pid');
      const compiled = join(scratch, 'cancel-typecheck-launched');
      const fakeRoot = join(scratch, 'cancel-host');
      mkdirSync(join(fakeRoot, 'node_modules', '@types'), { recursive: true });
      mkdirSync(join(fakeRoot, 'scripts'));
      writeFileSync(
        join(fakeRoot, 'scripts', 'tsc-slot.mjs'),
        `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(compiled)}, 'launched');`,
      );
      const ordinaryFailure = tamper('ordinary-consumer-failure', (dir) => {
        const path = join(dir, 'dist', 'index.js');
        writeFileSync(
          path,
          `throw new Error('ordinary consumer refusal');\n${readFileSync(path, 'utf8')}`,
        );
      });
      const failures = await smokePackage({
        repoRoot: fakeRoot,
        tarball: ordinaryFailure,
        spec: undefined,
      });
      expect(failures.join('\n')).toContain('plain node import failed');
      expect(
        existsSync(compiled),
        'ordinary failure still runs typecheck',
      ).toBe(true);
      rmSync(compiled);
      const descendant = `require('node:fs').writeFileSync(${JSON.stringify(descendantPid)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const archive = tamper('interrupted-consumer', (dir) => {
        const path = join(dir, 'dist', 'index.js');
        writeFileSync(
          path,
          `import {writeFileSync as ready} from 'node:fs';
          import {spawn as startChild} from 'node:child_process';
          startChild(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit',windowsHide:true});
          ready(${JSON.stringify(marker)}, String(process.pid));
          await new Promise(() => {});\n${readFileSync(path, 'utf8')}`,
        );
      });
      const driver = `import {smokePackage} from ${JSON.stringify(new URL('../monument-pack-smoke.mjs', import.meta.url).href)};
        try { const failures = await smokePackage({repoRoot:${JSON.stringify(fakeRoot)},tarball:${JSON.stringify(archive)}});
          console.error(failures.join('\\n')); process.exitCode=failures.length?1:0;
        } catch(error) { console.error(error.message);process.exitCode=1; }`;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '--eval', driver],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      void closed.catch(() => {});
      const cleanupErrors: unknown[] = [];
      try {
        await vi.waitFor(
          () => {
            expect(readFixturePid(marker)).toBeDefined();
            expect(readFixturePid(descendantPid)).toBeDefined();
          },
          { timeout: task.timeout / 3 },
        );
        child.kill('SIGTERM');
        expect(await closed, stderr).not.toBe(0);
        expect(
          existsSync(compiled),
          'typecheck must not launch after interruption',
        ).toBe(false);
        expect(stderr).toContain('interrupted after owned tree settlement');
        const pid = readFixturePid(descendantPid);
        if (pid === undefined)
          throw new Error('descendant PID was not complete');
        expect(() => process.kill(pid, 0)).toThrowError(
          expect.objectContaining({ code: 'ESRCH' }),
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        await closed;
        for (const path of [marker, descendantPid])
          killFixturePid(path, cleanupErrors);
      }
      expect(cleanupErrors, 'interrupt-fixture cleanup').toEqual([]);
    });

    it('keeps publish credentials out of the packed code and the type-check', {
      timeout: CASE_TIMEOUT,
    }, async () => {
      // The consumer script fails if any of these reach it.
      const result = await run(['--tarball', good], {
        ...process.env,
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake',
        NODE_AUTH_TOKEN: 'fake',
        NPM_ID_TOKEN: 'fake',
        'npm_config_//registry.npmjs.org/:_authToken': 'fake',
      });
      expect(result.output).toContain('OK: @kontourai/monument consumer smoke');
      expect(result.status).toBe(0);
    });

    it('fails when the exports map points back at src/*.ts, and plain node says why', {
      timeout: CASE_TIMEOUT,
    }, async () => {
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
      const result = await run(['--tarball', archive]);
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
    }, async () => {
      const archive = tamper('missing-dist', (packageDir) => {
        rmSync(join(packageDir, 'dist', 'sqlite.js'));
      });
      const result = await run(['--tarball', archive]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        'exports[./sqlite].default names a missing file: ./dist/sqlite.js',
      );
      expect(result.output).toContain('plain node import failed');
    });

    it('fails when declarations are missing, though plain node still imports', {
      timeout: CASE_TIMEOUT,
    }, async () => {
      const archive = tamper('no-declarations', (packageDir) => {
        rmSync(join(packageDir, 'dist', 'index.d.ts'));
      });
      const result = await run(['--tarball', archive]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        'types names a missing file: ./dist/index.d.ts',
      );
      expect(result.output).not.toContain('plain node import failed');
      expect(result.output).toContain('type declarations do not resolve');
    });

    it('fails on a shipped test and on a Station import in shipped code', {
      timeout: CASE_TIMEOUT,
    }, async () => {
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
      const result = await run(['--tarball', archive]);
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
    }, async () => {
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
      const result = await run(['--tarball', archive]);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        'a published entry point may not be TypeScript source',
      );
    });

    it('skips while the package is private, smokes once it is not, and refuses unknown arguments', {
      timeout: CASE_TIMEOUT,
    }, async () => {
      const manifest = JSON.parse(
        readFileSync(
          join(REPO, 'packages', 'monument', 'package.json'),
          'utf8',
        ),
      );
      // The workflow runs this flag on every publish dispatch. Flipping
      // `private` is the owner's step (#3565); this follows it either way.
      const gated = await run(['--if-publishable', '--tarball', good]);
      expect(gated.status, gated.output).toBe(0);
      expect(gated.output).toContain(manifest.private ? 'SKIP:' : 'OK:');
      expect((await run(['--bogus'])).status).toBe(2);
    });
  },
);
