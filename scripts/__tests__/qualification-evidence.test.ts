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
  run_attempt: 1,
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
  it('uses current-attempt Actions proof independently of recognized optional-delivery parent states', async () => {
    const { root, sha } = checkout();
    let mode = 'valid';
    const observed: string[] = [];
    const names = [
      'resolve',
      'Static and app builds',
      'Ordinary corpus 1-2 of 8',
      'Ordinary corpus 3-4 of 8',
      'Ordinary corpus 5-6 of 8',
      'Ordinary corpus 7-8 of 8',
      'Process-heavy corpus 1 of 2',
      'Process-heavy corpus 2 of 2',
      'Exclusive corpora',
      'Mobile Playwright (Android viewport)',
      'Full source qualification',
    ];
    const parent = (id = 42) => ({
      ...run,
      id,
      head_sha: sha,
      ...(mode.startsWith('live-')
        ? { status: 'in_progress', conclusion: null }
        : {}),
      ...([
        'pending-valid',
        'queued-valid',
        'waiting-valid',
        'requested-valid',
        'nightly-pending',
        'pending-other',
      ].includes(mode)
        ? {
            status:
              mode === 'nightly-pending' || mode === 'pending-other'
                ? 'pending'
                : mode.split('-')[0],
            conclusion: null,
          }
        : {}),
      ...(mode.startsWith('red-') || mode === 'failed-other'
        ? { conclusion: 'failure' }
        : {}),
      ...(mode === 'red-nightly' || mode === 'nightly-pending'
        ? { path: '.github/workflows/nightly.yml' }
        : {}),
      ...(mode === 'pending-other' || mode === 'failed-other'
        ? {
            path: '.github/workflows/publish-release.yml',
            event: 'workflow_dispatch',
          }
        : {}),
      ...(mode === 'unknown-status'
        ? { status: 'future-state', conclusion: null }
        : {}),
      ...(mode === 'prior-attempt'
        ? { run_attempt: 2, status: 'queued', conclusion: null }
        : {}),
      ...(mode === 'wrong-parent-source' ? { head_sha: 'b'.repeat(40) } : {}),
      ...(mode === 'wrong-parent-repo'
        ? { head_repository: { full_name: 'foreign/repo' } }
        : {}),
      ...(mode === 'wrong-parent-ref' ? { head_branch: 'feature' } : {}),
      ...(mode === 'retry-after-green' && id === 41
        ? { conclusion: 'failure', run_attempt: 2 }
        : {}),
    });
    const server = createServer((req, res) => {
      observed.push(req.url || '');
      res.setHeader('content-type', 'application/json');
      if (mode === 'unavailable') {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      const id = path.includes('/41/') ? 41 : 42;
      if (path.endsWith('/jobs')) {
        let jobs = names.map((name, index) => ({
          id: id * 100 + index,
          name: `qualification / ${name}`,
          run_id: id,
          run_attempt:
            mode === 'prior-attempt' || mode === 'wrong-job-attempt'
              ? 1
              : parent(id).run_attempt,
          head_sha: sha,
          status: 'completed',
          conclusion: 'success',
          completed_at: new Date(
            Date.now() -
              (mode === 'live-expired'
                ? 25 * 3600000
                : mode === 'retry-after-green' && id === 42
                  ? 10000
                  : 0),
          ).toISOString(),
        }));
        if (mode === 'missing' || mode === 'missing-phase')
          jobs = jobs.filter(
            (job) =>
              !job.name.endsWith(
                mode === 'missing'
                  ? 'Ordinary corpus 7-8 of 8'
                  : 'Static and app builds',
              ),
          );
        if (mode === 'missing-gate')
          jobs = jobs.filter(
            (job) => !job.name.endsWith('Full source qualification'),
          );
        if (mode === 'wrong-job-source') jobs[0].head_sha = 'b'.repeat(40);
        if (mode === 'wrong-job-run') jobs[0].run_id = 999;
        if (mode === 'wrong-job-attempt') jobs[0].run_attempt = 2;
        if (mode === 'failed-phase') jobs[1].conclusion = 'failure';
        if (mode === 'incomplete-phase') jobs[1].status = 'queued';
        if (mode === 'duplicate-phase') jobs.push({ ...jobs[1], id: 9999 });
        const gate = jobs.find((job) =>
          job.name.endsWith('Full source qualification'),
        );
        if (
          gate &&
          (mode === 'red-gate' || (mode === 'retry-after-green' && id === 41))
        )
          gate.conclusion = 'failure';
        if (gate && mode === 'cancelled-gate') gate.conclusion = 'cancelled';
        if (gate && mode === 'incomplete-gate') gate.status = 'in_progress';
        res.end(JSON.stringify({ jobs }));
      } else if (path.endsWith('/artifacts'))
        res.end(
          JSON.stringify({
            artifacts:
              mode === 'missing-artifact'
                ? []
                : [
                    {
                      name: `source-qualification-${sha}-42`,
                      expired: mode === 'expired',
                    },
                  ],
          }),
        );
      else if (/\/runs\/\d+$/.test(path))
        res.end(
          JSON.stringify({
            ...parent(),
            ...(mode === 'attempt-advanced'
              ? { run_attempt: 2, status: 'queued', conclusion: null }
              : {}),
            ...(mode === 'wrong-final-repo'
              ? { head_repository: { full_name: 'foreign/repo' } }
              : {}),
          }),
        );
      else
        res.end(
          JSON.stringify({
            workflow_runs: [
              ...(mode === 'retry-after-green' ? [parent(41)] : []),
              parent(),
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
    const successes = [
      'valid',
      'live-valid',
      'pending-valid',
      'queued-valid',
      'waiting-valid',
      'requested-valid',
      'nightly-pending',
      'red-publication',
      'red-nightly',
    ];
    try {
      for (mode of [
        ...successes,
        'live-expired',
        'retry-after-green',
        'missing',
        'missing-phase',
        'failed-phase',
        'incomplete-phase',
        'duplicate-phase',
        'missing-gate',
        'expired',
        'missing-artifact',
        'unavailable',
        'red-gate',
        'cancelled-gate',
        'incomplete-gate',
        'pending-other',
        'failed-other',
        'unknown-status',
        'prior-attempt',
        'wrong-job-source',
        'wrong-job-run',
        'wrong-job-attempt',
        'attempt-advanced',
        'wrong-parent-source',
        'wrong-parent-repo',
        'wrong-parent-ref',
        'wrong-final-repo',
      ]) {
        writeFileSync(output, '');
        await exec(process.execPath, [script, 'resolve'], {
          cwd: root,
          env,
          windowsHide: true,
        });
        expect(readFileSync(output, 'utf8'), mode).toBe(
          `reuse_run=${successes.includes(mode) ? '42' : ''}\n`,
        );
      }
      expect(observed.some((url) => url.includes(`head_sha=${sha}`))).toBe(
        true,
      );
      expect(observed.some((url) => url.includes('/42/attempts/2/jobs'))).toBe(
        true,
      );
      expect(observed.some((url) => /\/42\/jobs(?:\?|$)/.test(url))).toBe(
        false,
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
