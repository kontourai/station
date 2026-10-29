import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { execFileSyncBounded } from '../lib/bounded-capture.mjs';

const temps = trackTempDirs();
const script = resolve(import.meta.dirname, '../pr-delivery-plan.mjs');

function fixture(path: string) {
  const root = temps('delivery-plan-');
  const git = (...args: string[]) =>
    execFileSyncBounded('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(root, 'no-global-config'),
        GIT_CONFIG_NOSYSTEM: '1',
      },
    }).trim();
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(root, 'base'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), 'changed');
  git('add', '.');
  git('commit', '-qm', 'candidate');
  return { root, base, head: git('rev-parse', 'HEAD') };
}

async function run(
  f: ReturnType<typeof fixture>,
  base = f.base,
  options: {
    state?: string;
    trustedFork?: boolean;
    moved?: boolean;
    fork?: boolean;
    failed?: boolean;
    baseRef?: string;
  } = {},
) {
  const output = join(f.root, 'outputs');
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    if (options.failed) {
      res.writeHead(503);
      res.end('{}');
      return;
    }
    res.end(
      JSON.stringify({
        number: 7,
        state: options.state ?? 'open',
        base: {
          ref: options.baseRef ?? 'main',
          repo: { full_name: 'owner/station' },
        },
        head: {
          sha: options.moved ? 'c'.repeat(40) : f.head,
          repo: {
            full_name:
              options.fork || options.trustedFork
                ? 'foreign/station'
                : 'owner/station',
          },
        },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing API fixture address');
  let result: { status: number; stderr: string; stdout: string };
  try {
    const child = await promisify(execFile)(
      process.execPath,
      [script, base, f.head],
      {
        cwd: f.root,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: 'owner/station',
          PR_NUMBER: '7',
          PR_HEAD_REPOSITORY: options.trustedFork
            ? 'foreign/station'
            : 'owner/station',
          GH_TOKEN: 'fixture',
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
        },
      },
    );
    result = { status: 0, stderr: child.stderr, stdout: child.stdout };
  } catch (error) {
    const failure = error as { code: number; stderr: string; stdout: string };
    result = {
      status: failure.code,
      stderr: failure.stderr,
      stdout: failure.stdout,
    };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
  return { result, output };
}

describe('delivery planning through the real Git CLI', () => {
  test.each([
    ['install.sh', ['install', 'portable', 'ecosystem']],
    ['src-desktop/src/lib.rs', ['native', 'desktop']],
    ['pnpm-lock.yaml', ['portable', 'desktop']],
    ['docs/unrelated.md', []],
    [
      '.github/workflows/delivery-validation.yml',
      ['install', 'portable', 'native', 'desktop', 'ecosystem'],
    ],
    [
      'scripts/pr-delivery-paths.json',
      ['install', 'portable', 'native', 'desktop', 'ecosystem'],
    ],
  ])(
    'routes %s without losing the remaining families',
    async (path, expected) => {
      const { result, output } = await run(fixture(path));
      expect(result.status, result.stderr).toBe(0);
      const selected = readFileSync(output, 'utf8')
        .trim()
        .split('\n')
        .filter((line) => line.endsWith('=true'))
        .map((line) => line.split('=')[0]);
      expect(selected.sort()).toEqual([...expected].sort());
    },
  );

  test('rejects a missing Git base rather than emitting an empty successful plan', async () => {
    const { result } = await run(fixture('install.sh'), 'a'.repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('git diff');
  });

  test('rejects non-SHA input before invoking Git', async () => {
    const { result } = await run(fixture('install.sh'), '--help');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exact base and head SHAs');
  });
  test.each([
    { state: 'closed' },
    { moved: true },
    { fork: true },
    { baseRef: 'other' },
  ])(
    'does not admit optional work when live PR ownership is ineligible: %j',
    async (options) => {
      const { result, output } = await run(
        fixture('install.sh'),
        undefined,
        options,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).not.toContain('=true');
    },
  );
  test('an unavailable authenticated owner read emits no successful admission', async () => {
    const { result, output } = await run(fixture('install.sh'), undefined, {
      failed: true,
    });
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(output, 'utf8')).toThrow();
  });
  test('preserves optional coverage for an authenticated fork whose repository matches the event owner', async () => {
    const { result, output } = await run(fixture('install.sh'), undefined, {
      trustedFork: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8')).toContain('install=true');
  });
});
