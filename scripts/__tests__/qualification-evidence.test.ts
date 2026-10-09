import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  QUALIFICATION_JOBS,
  qualificationVerdict,
  reusableRun,
} from '../qualification-evidence.mjs';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '../qualification-evidence.mjs');
const makeTempDir = trackTempDirs();
function checkout() {
  const root = makeTempDir('station-qualification-');
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, 'source'), 'real source');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return { root, sha: git('rev-parse', 'HEAD') };
}
function needs(
  result = 'success',
): Record<string, { result: string; outputs: Record<string, string> }> {
  return Object.fromEntries(
    ['resolve', ...QUALIFICATION_JOBS].map((id) => [
      id,
      { result, outputs: {} },
    ]),
  );
}
const run = {
  id: 42,
  head_sha: 'a'.repeat(40),
  head_repository: { full_name: 'owner/repo' },
  head_branch: 'main',
  path: '.github/workflows/main-qualification.yml',
  event: 'schedule',
  status: 'completed',
  conclusion: 'success',
  updated_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
};

describe('source qualification evidence', () => {
  it('rejects missing, failed, cancelled or unexpected jobs and permits only validated reuse skips', () => {
    expect(qualificationVerdict(needs(), '')).toBe(true);
    for (const id of QUALIFICATION_JOBS)
      for (const result of ['failure', 'cancelled', 'skipped']) {
        const data = needs();
        data[id].result = result;
        expect(qualificationVerdict(data, '')).toBe(false);
      }
    const missing = needs();
    delete missing.static;
    expect(qualificationVerdict(missing, '')).toBe(false);
    expect(
      qualificationVerdict(
        { ...needs(), unexpected: { result: 'success' } },
        '',
      ),
    ).toBe(false);
    const reused = needs('skipped');
    reused.resolve = { result: 'success', outputs: { reuse_run: '42' } };
    expect(qualificationVerdict(reused, '42')).toBe(true);
    expect(qualificationVerdict(reused, '43')).toBe(false);
    reused.ordinary.result = 'failure';
    expect(qualificationVerdict(reused, '42')).toBe(false);
  });
  it('binds reusable evidence to exact source, canonical workflow, repository and original age', () => {
    const options = {
      source: run.head_sha,
      repository: 'owner/repo',
      currentRun: 99,
      now: Date.now(),
    };
    expect(reusableRun(run, options)).toBe(true);
    for (const change of [
      { head_sha: 'b'.repeat(40) },
      { head_branch: 'feature' },
      { event: 'pull_request' },
      { path: '.github/workflows/other.yml' },
      { conclusion: 'failure' },
      { id: 99 },
      { head_repository: { full_name: 'fork/repo' } },
      { updated_at: new Date(Date.now() - 25 * 3600_000).toISOString() },
    ])
      expect(reusableRun({ ...run, ...change }, options)).toBe(false);
  });
  it('executes the real CLI and refuses a different checkout or incomplete qualification without emitting a receipt', async () => {
    const { root, sha } = checkout();
    const env = {
      ...process.env,
      SOURCE_SHA: sha,
      NEEDS: JSON.stringify(needs()),
    };
    await exec(process.execPath, [script, 'attest'], {
      cwd: root,
      env,
      windowsHide: true,
    });
    expect(
      JSON.parse(readFileSync(join(root, 'source-qualification.json'), 'utf8'))
        .sourceSha,
    ).toBe(sha);
    rmSync(join(root, 'source-qualification.json'));
    await expect(
      exec(process.execPath, [script, 'attest'], {
        cwd: root,
        env: { ...env, SOURCE_SHA: 'f'.repeat(40) },
        windowsHide: true,
      }),
    ).rejects.toMatchObject({ code: 1 });
    await expect(
      exec(process.execPath, [script, 'attest'], {
        cwd: root,
        env: { ...env, NEEDS: '{}' },
        windowsHide: true,
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(() =>
      readFileSync(join(root, 'source-qualification.json')),
    ).toThrow();
  });
  it('uses real Actions HTTP responses and falls back to fresh execution on expired, incomplete or unavailable evidence', async () => {
    const { root, sha } = checkout();
    let mode = 'valid';
    const observed: string[] = [];
    const server = createServer((req, res) => {
      observed.push(req.url || '');
      res.setHeader('content-type', 'application/json');
      if (mode === 'unavailable') {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      if (req.url?.includes('/jobs'))
        res.end(
          JSON.stringify({
            jobs: [
              {
                name: 'qualification / Full source qualification',
                completed_at:
                  mode === 'live-expired'
                    ? new Date(Date.now() - 25 * 3600000).toISOString()
                    : new Date(
                        Date.now() -
                          (mode === 'retry-after-green' &&
                          req.url?.includes('/42/')
                            ? 10_000
                            : 0),
                      ).toISOString(),
                conclusion:
                  mode === 'red-gate' ||
                  (mode === 'retry-after-green' && req.url?.includes('/41/'))
                    ? 'failure'
                    : 'success',
              },
              ...Array.from({ length: mode === 'missing' ? 3 : 4 }, (_, i) => ({
                name: `qualification / Ordinary corpus ${i}`,
                conclusion: 'success',
              })),
            ],
          }),
        );
      else if (req.url?.includes('/artifacts'))
        res.end(
          JSON.stringify({
            artifacts: [
              {
                name: `source-qualification-${sha}-42`,
                expired: mode === 'expired',
              },
            ],
          }),
        );
      else
        res.end(
          JSON.stringify({
            workflow_runs: [
              ...(mode === 'retry-after-green'
                ? [
                    {
                      ...run,
                      id: 41,
                      head_sha: sha,
                      created_at: new Date(Date.now() - 100_000).toISOString(),
                      run_attempt: 2,
                      conclusion: 'failure',
                    },
                  ]
                : []),
              {
                ...run,
                head_sha: sha,
                // A red run whose gate passed: only Main qualification, which
                // also publishes the Nightly, may be judged by its gate.
                ...(mode.startsWith('live-')
                  ? { status: 'in_progress', conclusion: null }
                  : {}),
                ...(mode.startsWith('red-') ? { conclusion: 'failure' } : {}),
                ...(mode === 'red-other-workflow'
                  ? { path: '.github/workflows/nightly.yml' }
                  : {}),
              },
            ],
          }),
        );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const output = join(root, 'output');
    const env = {
      ...process.env,
      SOURCE_SHA: sha,
      ALLOW_REUSE: 'true',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_RUN_ID: '99',
      GITHUB_OUTPUT: output,
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
    };
    try {
      for (mode of [
        'valid',
        'live-valid',
        'live-expired',
        'retry-after-green',
        'missing',
        'expired',
        'unavailable',
        'red-publication',
        'red-gate',
        'red-other-workflow',
      ]) {
        writeFileSync(output, '');
        await exec(process.execPath, [script, 'resolve'], {
          cwd: root,
          env,
          windowsHide: true,
        });
        expect(readFileSync(output, 'utf8')).toBe(
          `reuse_run=${['valid', 'live-valid', 'red-publication', 'red-other-workflow'].includes(mode) ? '42' : ''}\n`,
        );
      }
      expect(observed.some((url) => url.includes(`head_sha=${sha}`))).toBe(
        true,
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
