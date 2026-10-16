import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const exec = promisify(execFile);
const makeTempDir = trackTempDirs();
const head = 'a'.repeat(40);
const old = 'b'.repeat(40);
const repository = 'kontourai/station';
const script = resolve(import.meta.dirname, '../pr-ci-supersession.mjs');

function run(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    run_attempt: 1,
    status: 'in_progress',
    event: 'pull_request_target',
    path: '.github/workflows/ci.yml',
    head_sha: old,
    head_branch: 'feature',
    head_repository: { full_name: repository },
    pull_requests: [{ number: 7 }],
    ...overrides,
  };
}

async function exercise({
  runs = [run(1)],
  changedHead = false,
  failure = false,
  completed = false,
  fork = false,
} = {}) {
  const cancelled: number[] = [];
  let reads = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname.endsWith('/pulls/7')) {
      reads++;
      if (failure && reads > 1) {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      res.end(
        JSON.stringify({
          state: 'open',
          base: { ref: 'main' },
          head: {
            sha: changedHead && reads > 1 ? old : head,
            ref: 'feature',
            repo: { full_name: fork ? 'someone/station' : repository },
          },
        }),
      );
    } else if (url.pathname.endsWith('/actions/runs')) {
      res.end(
        JSON.stringify({
          workflow_runs:
            url.searchParams.get('status') === 'in_progress' ? runs : [],
        }),
      );
    } else if (/\/actions\/runs\/\d+\/cancel$/.test(url.pathname)) {
      expect(req.method).toBe('POST');
      cancelled.push(Number(url.pathname.split('/').at(-2)));
      res.writeHead(202);
      res.end('{}');
    } else if (/\/actions\/runs\/\d+$/.test(url.pathname)) {
      const item = runs.find(
        (r) => r.id === Number(url.pathname.split('/').at(-1)),
      );
      res.end(
        JSON.stringify({
          ...item,
          ...(completed ? { status: 'completed' } : {}),
        }),
      );
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const event = join(makeTempDir('pr-ci-supersession-'), 'event.json');
  // A late event names the old head. Only the live REST head authorizes effects.
  writeFileSync(
    event,
    JSON.stringify({
      workflow_run: { head_sha: old, pull_requests: [{ number: 7 }] },
    }),
  );
  let code = 0;
  try {
    await exec(process.execPath, [script], {
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: repository,
        GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
    });
  } catch (error) {
    code = (error as { code: number }).code;
  } finally {
    await new Promise<void>((ok, reject) =>
      server.close((error) => (error ? reject(error) : ok())),
    );
  }
  return { code, cancelled };
}

describe('obsolete PR CI cancellation through the GitHub API', () => {
  it('cancels obsolete verification while retaining the current head and unrelated work', async () => {
    const result = await exercise({
      runs: [
        run(1),
        run(2, { head_sha: head }),
        run(3, { event: 'merge_group' }),
        run(4, { event: 'workflow_dispatch' }),
        run(5, { path: '.github/workflows/nightly.yml' }),
        run(6, { head_repository: { full_name: 'someone/station' } }),
        run(7, { pull_requests: [{ number: 8 }] }),
        run(8, { head_branch: 'another-feature' }),
        run(9, { path: '.github/workflows/build-ios.yml' }),
      ],
    });
    expect(result).toEqual({ code: 0, cancelled: [1, 9] });
  });

  it.each([{ changedHead: true }, { completed: true }, { fork: true }])(
    'leaves work alone when its cancellation authority disappears: %j',
    async (world) => {
      expect(await exercise(world)).toEqual({ code: 0, cancelled: [] });
    },
  );

  it('refuses cancellation when the live-head read fails', async () => {
    expect(await exercise({ failure: true })).toEqual({
      code: 1,
      cancelled: [],
    });
  });
});
