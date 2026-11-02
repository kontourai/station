import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { admitPullRequest } from '../pr-source-admission.mjs';

const temp = trackTempDirs();
const base = 'b'.repeat(40);
const head = 'a'.repeat(40);
const merge = 'd'.repeat(40);
const repository = 'kontourai/station';

type Mergeable = boolean | null;

/** A GitHub API double shaped like the REST responses the real check reads. */
async function withGithub<T>(
  mergeable: Mergeable | (() => Mergeable),
  run: (url: string, requests: () => number) => Promise<T>,
  options: { failPulls?: boolean } = {},
) {
  let pullReads = 0;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/git/ref/heads/main')) {
      response.end(
        JSON.stringify({
          ref: 'refs/heads/main',
          object: { type: 'commit', sha: base },
        }),
      );
    } else if (request.url?.endsWith('/pulls/42')) {
      pullReads++;
      if (options.failPulls) {
        response.writeHead(503);
        response.end();
        return;
      }
      const value = typeof mergeable === 'function' ? mergeable() : mergeable;
      response.end(
        JSON.stringify({
          number: 42,
          state: 'open',
          mergeable: value,
          merge_commit_sha: value === true ? merge : null,
          base: {
            ref: 'main',
            sha: base,
            repo: { full_name: repository, id: 1 },
          },
          head: {
            ref: 'feature',
            sha: head,
            repo: { full_name: repository, id: 1 },
          },
        }),
      );
    } else if (request.url?.endsWith(`/git/commits/${merge}`)) {
      response.end(
        JSON.stringify({
          sha: merge,
          parents: [{ sha: base }, { sha: head }],
        }),
      );
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('missing address');
    return await run(`http://127.0.0.1:${address.port}`, () => pullReads);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function environment(
  url: string,
  overrides: Record<string, string> = {},
  event: Record<string, unknown> = {},
) {
  const eventPath = join(temp('pr-admission-event-'), 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 42,
        base: { ref: 'main', repo: { full_name: repository } },
        head: { sha: head, repo: { full_name: repository } },
        ...event,
      },
    }),
  );
  return {
    ...process.env,
    GITHUB_REPOSITORY: repository,
    GITHUB_API_URL: url,
    GITHUB_EVENT_NAME: 'pull_request_target',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_PATH: eventPath,
    ...overrides,
  };
}

const noWait = { sleep: async () => {}, retryMs: 0 };

test('a confirmed conflict is deferred on the first observation', async () => {
  await withGithub(false, async (url, reads) => {
    expect(
      await admitPullRequest({ env: environment(url), ...noWait }),
    ).toEqual({ admitted: false, reason: 'conflict', base });
    // Two reads of one observation, never a retry loop over a conflict.
    expect(reads()).toBe(2);
  });
});

test('a mergeable candidate is admitted', async () => {
  await withGithub(true, async (url) => {
    expect(
      await admitPullRequest({ env: environment(url), ...noWait }),
    ).toEqual({ admitted: true, reason: 'mergeable' });
  });
});

test('mergeability still being computed retries, then admits rather than blocks', async () => {
  await withGithub(null, async (url, reads) => {
    const result = await admitPullRequest({
      env: environment(url),
      attempts: 3,
      ...noWait,
    });
    expect(result).toEqual({
      admitted: true,
      reason: 'inconclusive: mergeability-unknown',
    });
    expect(reads()).toBe(6);
  });
});

test('a conflict that appears after GitHub finishes computing is still deferred', async () => {
  let calls = 0;
  await withGithub(
    () => (++calls <= 4 ? null : false),
    async (url) => {
      expect(
        await admitPullRequest({ env: environment(url), ...noWait }),
      ).toMatchObject({ admitted: false, reason: 'conflict' });
    },
  );
});

test('an unavailable API admits the run instead of blocking feedback', async () => {
  await withGithub(
    false,
    async (url) => {
      expect(
        await admitPullRequest({
          env: environment(url),
          attempts: 2,
          ...noWait,
        }),
      ).toMatchObject({ admitted: true });
    },
    { failPulls: true },
  );
});

test.each([
  ['wrong event', { GITHUB_EVENT_NAME: 'workflow_dispatch' }, {}],
  ['wrong ref', { GITHUB_REF: 'refs/heads/feature' }, {}],
  [
    'foreign head repository',
    {},
    { head: { sha: head, repo: { full_name: 'other/repo' } } },
  ],
  [
    'non-main base',
    {},
    { base: { ref: 'dev', repo: { full_name: repository } } },
  ],
  [
    'malformed head',
    {},
    { head: { sha: 'zz', repo: { full_name: repository } } },
  ],
])('an untrusted event is refused: %s', async (_name, overrides, event) => {
  await withGithub(true, async (url) => {
    await expect(
      admitPullRequest({ env: environment(url, overrides, event), ...noWait }),
    ).rejects.toThrow('untrusted PR admission event');
  });
});

test.each([
  ['conflict', false, 1, 'admitted=false'],
  ['mergeable', true, 0, 'admitted=true'],
] as const)(
  'the CLI exits with the admission verdict: %s',
  async (_name, mergeable, expected, output) => {
    await withGithub(mergeable, async (url) => {
      const outputPath = join(temp('pr-admission-output-'), 'output');
      writeFileSync(outputPath, '');
      const child = spawn(
        process.execPath,
        ['scripts/pr-source-admission.mjs'],
        {
          windowsHide: true,
          timeout: 20000,
          stdio: 'ignore',
          env: { ...environment(url), GITHUB_OUTPUT: outputPath },
        },
      );
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      expect(code).toBe(expected);
      expect(readFileSync(outputPath, 'utf8')).toContain(output);
    });
  },
);
