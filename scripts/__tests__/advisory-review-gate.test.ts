import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { isGeneratedPath } from '../advisory-review-gate.mjs';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '../advisory-review-gate.mjs');
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

type World = {
  pr?: Record<string, unknown>;
  files?: string[];
  reviews?: Array<{ body: string }>;
  artifacts?: Array<{ expired: boolean }>;
  fail?: string;
};

const makeTempDir = trackTempDirs();
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    state: 'open',
    auto_merge: null,
    labels: [{ name: 'advisory-review' }],
    head: { sha: HEAD, repo: { full_name: 'kontourai/station' } },
    base: { sha: 'c'.repeat(40) },
    ...overrides,
  };
}

/** Runs the real gate as a child process against a loopback GitHub API. */
async function runGate(
  world: World,
  env: Record<string, string> = {},
): Promise<{
  code: number;
  outputs: Record<string, string>;
  requests: string[];
  stderr: string;
}> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    requests.push(url);
    res.setHeader('content-type', 'application/json');
    if (world.fail && url.includes(world.fail)) {
      res.writeHead(503);
      res.end('{}');
      return;
    }
    if (url.includes('/files'))
      res.end(
        JSON.stringify((world.files ?? []).map((filename) => ({ filename }))),
      );
    else if (url.includes('/reviews'))
      res.end(JSON.stringify(world.reviews ?? []));
    else if (url.includes('/actions/artifacts'))
      res.end(JSON.stringify({ artifacts: world.artifacts ?? [] }));
    else if (url.includes('/pulls/7'))
      res.end(JSON.stringify(world.pr ?? pullRequest()));
    else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const directory = makeTempDir('advisory-gate-');
  const outputFile = join(directory, 'output');
  writeFileSync(outputFile, '');
  let code = 0;
  let stderr = '';
  try {
    await exec(process.execPath, [script], {
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_REPOSITORY: 'kontourai/station',
        GITHUB_OUTPUT: outputFile,
        EVENT_NAME: 'workflow_run',
        EVENT_HEAD_SHA: HEAD,
        PULL_REQUEST: '7',
        ...env,
      },
    });
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    code = failure.code ?? 1;
    stderr = failure.stderr ?? '';
  }
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [
        line.slice(0, line.indexOf('=')),
        line.slice(line.indexOf('=') + 1),
      ]),
  );
  return { code, outputs, requests, stderr };
}

const source = ['src-server/index.ts'];

describe('advisory review gate (child process)', () => {
  it('admits a labelled pull request with reviewable source and no prior review', async () => {
    const result = await runGate({ files: source });
    expect(result.code).toBe(0);
    expect(result.outputs).toMatchObject({
      admit: 'true',
      reason: 'requested',
      same_repository: 'true',
      head_repository: 'kontourai/station',
      number: '7',
      head_sha: HEAD,
    });
  });

  it('skips an armed pull request nobody requested, without reading files or reviews', async () => {
    const result = await runGate({
      pr: pullRequest({ auto_merge: { merge_method: 'squash' }, labels: [] }),
      files: source,
    });
    expect(result.outputs).toMatchObject({
      admit: 'false',
      reason: 'not-requested',
    });
    expect(result.requests.some((url) => url.includes('/files'))).toBe(false);
  });

  it('admits when the advisory-review label requests it', async () => {
    const result = await runGate({
      pr: pullRequest({ labels: [{ name: 'advisory-review' }] }),
      files: source,
    });
    expect(result.outputs.admit).toBe('true');
  });

  it('does not treat unrelated labels as a request', async () => {
    const result = await runGate({
      pr: pullRequest({ labels: [{ name: 'bug' }] }),
      files: source,
    });
    expect(result.outputs.reason).toBe('not-requested');
  });

  it('admits a manual dispatch without arming or a label', async () => {
    const result = await runGate(
      { pr: pullRequest({ labels: [] }), files: source },
      { EVENT_NAME: 'workflow_dispatch', EVENT_HEAD_SHA: '' },
    );
    expect(result.outputs).toMatchObject({ admit: 'true', head_sha: HEAD });
  });

  it('skips a head the pull request has moved past', async () => {
    const result = await runGate({
      pr: pullRequest({
        head: { sha: OTHER_HEAD, repo: { full_name: 'kontourai/station' } },
      }),
      files: source,
    });
    expect(result.outputs).toMatchObject({
      admit: 'false',
      reason: 'superseded-head',
    });
  });

  it('skips a closed pull request', async () => {
    const result = await runGate({
      pr: pullRequest({ state: 'closed' }),
      files: source,
    });
    expect(result.outputs.reason).toBe('closed');
  });

  it('skips a diff of only generated output and lockfiles', async () => {
    const result = await runGate({
      files: [
        'docs/learn/review-ledger/notes/x.json',
        'docs/learn/review-ledger/ledger.json',
        'pnpm-lock.yaml',
        'src-desktop/Cargo.lock',
        'docs/reference/openapi.json',
        'packages/basis-pane/src/task-basis-mcp-app.generated.ts',
      ],
    });
    expect(result.outputs).toMatchObject({
      admit: 'false',
      reason: 'generated-only',
    });
  });

  it('reviews a diff that mixes generated output with one source file', async () => {
    const result = await runGate({
      files: [
        'docs/learn/review-ledger/ledger.json',
        'scripts/real-change.mjs',
      ],
    });
    expect(result.outputs.admit).toBe('true');
  });

  it('skips when a review comment for this exact head already exists', async () => {
    const result = await runGate({
      files: source,
      reviews: [{ body: `x\n<!-- flow-agents:codex-pr-review:${HEAD} -->` }],
    });
    expect(result.outputs).toMatchObject({
      admit: 'false',
      reason: 'already-reviewed',
    });
  });

  it('is not satisfied by a review of a different head', async () => {
    const result = await runGate({
      files: source,
      reviews: [{ body: `<!-- flow-agents:codex-pr-review:${OTHER_HEAD} -->` }],
    });
    expect(result.outputs.admit).toBe('true');
  });

  it('skips when a retained result artifact exists for the head, ignoring expired ones', async () => {
    const retained = await runGate({
      files: source,
      artifacts: [{ expired: false }],
    });
    expect(retained.outputs.reason).toBe('already-reviewed');
    const expired = await runGate({
      files: source,
      artifacts: [{ expired: true }],
    });
    expect(expired.outputs.admit).toBe('true');
  });

  it('reports a fork head so the credentialed job stays out', async () => {
    const result = await runGate({
      files: source,
      pr: pullRequest({
        head: { sha: HEAD, repo: { full_name: 'someone/station' } },
      }),
    });
    expect(result.outputs).toMatchObject({
      admit: 'true',
      same_repository: 'false',
      head_repository: 'someone/station',
    });
  });

  it('fails closed with a nonzero exit and no admission when the API is unavailable', async () => {
    const result = await runGate({ files: source, fail: '/files' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('advisory review gate failed');
    expect(result.outputs.admit).toBeUndefined();
  });

  it('rejects a malformed pull request number before any request', async () => {
    const result = await runGate({ files: source }, { PULL_REQUEST: '7; rm' });
    expect(result.code).not.toBe(0);
    expect(result.requests).toEqual([]);
  });
});

describe('generated path list', () => {
  it('matches generators and lockfiles but not near misses', () => {
    for (const file of [
      'docs/learn/review-ledger/records/AGENTS.md.json',
      'pnpm-lock.yaml',
      'packages/sdk/package-lock.json',
      'src-desktop/Cargo.lock',
      'docs/reference/metrics.md',
      'src-server/tools/station-docs-content.ts',
      'a/b.generated.ts',
    ])
      expect(isGeneratedPath(file), file).toBe(true);
    for (const file of [
      'docs/learn/review-ledger-notes.md',
      'docs/learn/atlas.js',
      'docs/guides/testing.md',
      'package.json',
      'scripts/generate-openapi.ts',
      'src-server/tools/station-docs.ts',
      '',
    ])
      expect(isGeneratedPath(file), file).toBe(false);
  });
});
