import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  persistentRunnerPolicyFindings,
  readWorkflowDocuments,
} from '../actionlint-gate.mjs';
import { eligibleLanding } from '../landing-automation.mjs';
import {
  nextRepairState,
  QUALIFICATION_GATE_JOB,
  qualificationConclusion,
  repairState,
  validateRepairPaths,
  validateRepairRun,
} from '../qualification-repair.mjs';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '../qualification-repair.mjs');
const makeTempDir = trackTempDirs();
function fixture() {
  const root = makeTempDir('station-repair-');
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(repo, 'source.txt'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  execFileSync('git', ['init', '--bare', '-q', join(root, 'remote.git')], {
    windowsHide: true,
  });
  git('remote', 'add', 'origin', join(root, 'remote.git'));
  git('push', '-q', 'origin', 'HEAD:main');
  return { root, repo, git, sha };
}
const run = {
  id: 42,
  head_sha: 'a'.repeat(40),
  head_branch: 'main',
  head_repository: { full_name: 'owner/repo' },
  path: '.github/workflows/main-qualification.yml',
  event: 'schedule',
  status: 'completed',
  conclusion: 'failure',
  created_at: '2026-10-02T00:00:00Z',
  run_started_at: '2026-10-02T00:00:00Z',
};

describe('qualification repair lifecycle', () => {
  it('claims one sweep, updates repeated failures, rejects stale success, and requires explicit retry', () => {
    const first = nextRepairState(null, run);
    expect(first.action).toBe('claim');
    const next = { ...run, id: 43, run_started_at: '2026-10-02T06:00:00Z' };
    const repeated = nextRepairState(first.state, next);
    expect(repeated.action).toBe('update');
    expect(repeated.state.episode).toBe(42);
    expect(
      nextRepairState(repeated.state, { ...run, conclusion: 'success' }).action,
    ).toBe('stale');
    expect(
      nextRepairState(repeated.state, { ...next, conclusion: 'success' })
        .action,
    ).toBe('close');
    expect(nextRepairState(repeated.state, next, { retry: true }).action).toBe(
      'claim',
    );
    expect(
      repairState(
        `<!-- station-qualification:${JSON.stringify(repeated.state)} -->`,
      ),
    ).toEqual(repeated.state);
  });
  it('refuses fork evidence and protected or oversized agent proposals', () => {
    expect(() => validateRepairRun(run, 'owner/repo')).not.toThrow();
    for (const change of [
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { head_repository: { full_name: 'fork/repo' } },
      { path: '.github/workflows/ci.yml' },
    ])
      expect(() =>
        validateRepairRun({ ...run, ...change }, 'owner/repo'),
      ).toThrow();
    expect(() => validateRepairPaths(['src-server/fix.ts'])).not.toThrow();
    for (const path of [
      '.github/workflows/ci.yml',
      'scripts/qualification-evidence.mjs',
      '.veritas/authority/x',
      'src-ui/AGENTS.md',
      '../outside',
    ])
      expect(() => validateRepairPaths([path])).toThrow();
    expect(() => validateRepairPaths([])).toThrow();
    expect(() =>
      validateRepairPaths(
        Array.from({ length: 41 }, (_, i) => `src-server/${i}.ts`),
      ),
    ).toThrow();
  });
  it('requires explicit landing intent and the current same-repository head', () => {
    const pr = {
      state: 'open',
      draft: false,
      base: { ref: 'main' },
      head: { sha: run.head_sha, repo: { full_name: 'owner/repo' } },
      labels: [{ name: 'station-autoland' }],
      auto_merge: null,
      mergeable_state: 'clean',
    };
    expect(eligibleLanding(pr, run, 'owner/repo')).toBe(true);
    for (const change of [
      { labels: [] },
      { draft: true },
      { mergeable_state: 'dirty' },
      { auto_merge: {} },
      { head: { sha: 'b'.repeat(40), repo: { full_name: 'owner/repo' } } },
    ])
      expect(eligibleLanding({ ...pr, ...change }, run, 'owner/repo')).toBe(
        false,
      );
  });
  it('refuses candidate checkout in the privileged landing ingress', () => {
    const entry = readWorkflowDocuments().find(
      (item) => item.file === '.github/workflows/landing-automation.yml',
    );
    if (!entry) throw new Error('Landing workflow missing');
    expect(persistentRunnerPolicyFindings([entry])).toEqual([]);
    const document = structuredClone(entry.document) as {
      jobs: { arm: { steps: Array<{ with: { ref: string } }> } };
    };
    document.jobs.arm.steps[0].with.ref = `\${{ github.event.pull_request.head.sha }}`;
    expect(
      persistentRunnerPolicyFindings([{ file: entry.file, document }]),
    ).toContainEqual(
      expect.objectContaining({
        message:
          'landing automation must retain its exact reviewed trusted-base credential topology',
      }),
    );
  });

  it.runIf(process.platform !== 'win32')(
    'arms a late-labelled PR only after current-head CI success',
    async () => {
      const root = makeTempDir('station-landing-label-');
      let green = false;
      const pr = {
        number: 7,
        state: 'open',
        draft: false,
        base: { ref: 'main' },
        head: { sha: run.head_sha, repo: { full_name: 'owner/repo' } },
        labels: [{ name: 'station-autoland' }],
        auto_merge: null,
      };
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(
            req.url?.includes('/actions/')
              ? {
                  workflow_runs: [
                    {
                      ...run,
                      event: 'pull_request_target',
                      conclusion: green ? 'success' : 'failure',
                      created_at: '2026-10-02T06:00:00Z',
                    },
                    {
                      ...run,
                      event: 'pull_request_target',
                      conclusion: 'success',
                    },
                  ],
                }
              : pr,
          ),
        );
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No address');
      const event = join(root, 'event.json');
      writeFileSync(event, JSON.stringify({ pull_request: { number: 7 } }));
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'gh'),
        '#!/bin/sh\nprintf "%s\n" "$*" > "$ARM_MARKER"\n',
      );
      chmodSync(join(bin, 'gh'), 0o755);
      const marker = join(root, 'armed');
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ARM_MARKER: marker,
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      };
      const landing = resolve(import.meta.dirname, '../landing-automation.mjs');
      try {
        await exec(process.execPath, [landing], {
          cwd: root,
          env,
          windowsHide: true,
        });
        expect(() => readFileSync(marker)).toThrow();
        green = true;
        await exec(process.execPath, [landing], {
          cwd: root,
          env,
          windowsHide: true,
        });
        expect(readFileSync(marker, 'utf8')).toBe(
          'pr merge 7 --repo owner/repo --auto\n',
        );
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
  );

  it('judges a run by its qualification gate when the qualified Nightly made it red', () => {
    expect(QUALIFICATION_GATE_JOB).toBe(
      'qualification / Full source qualification',
    );
    const gate = (conclusion: string) => ({
      name: QUALIFICATION_GATE_JOB,
      conclusion,
    });
    const nightlyFailed = {
      name: 'nightly / 3 · Publish native cohort / Promote',
      conclusion: 'failure',
    };
    for (const conclusion of ['failure', 'cancelled', 'timed_out'])
      expect(
        qualificationConclusion({ ...run, conclusion }, [
          gate('success'),
          nightlyFailed,
        ]),
      ).toBe('success');
    // A failed, skipped, missing or ambiguous gate keeps the run's verdict.
    for (const jobs of [
      [gate('failure'), nightlyFailed],
      [gate('skipped')],
      [nightlyFailed],
      [gate('success'), gate('failure')],
      // The Nightly's own full-regression gate is not the qualification gate.
      [
        {
          name: 'nightly / 2 · Full regression gate / Full source qualification',
          conclusion: 'success',
        },
      ],
    ])
      expect(qualificationConclusion(run, jobs)).toBe('failure');
  });

  it('opens no repair episode when only the qualified Nightly failed', async () => {
    const root = makeTempDir('station-repair-nightly-');
    const writes: string[] = [];
    const server = createServer(async (req, res) => {
      for await (const _chunk of req);
      res.setHeader('content-type', 'application/json');
      if (req.method !== 'GET') writes.push(`${req.method} ${req.url}`);
      if (req.url?.includes('/actions/runs/42/jobs')) {
        res.end(
          JSON.stringify({
            total_count: 2,
            jobs: [
              { name: QUALIFICATION_GATE_JOB, conclusion: 'success' },
              {
                name: 'nightly / 3 · Publish CLI to npm nightly',
                conclusion: 'failure',
              },
            ],
          }),
        );
        return;
      }
      if (req.url?.endsWith('/actions/runs/42')) {
        res.end(JSON.stringify(run));
        return;
      }
      if (req.url?.includes('/issues?')) {
        res.end('[]');
        return;
      }
      res.writeHead(500);
      res.end('{}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const event = join(root, 'event.json');
    writeFileSync(event, JSON.stringify({ workflow_run: { id: 42 } }));
    const output = join(root, 'output');
    try {
      await exec(process.execPath, [script, 'prepare'], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_REPOSITORY: 'owner/repo',
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          GITHUB_EVENT_PATH: event,
          GITHUB_OUTPUT: output,
          GITHUB_RUN_ID: '99',
          GITHUB_RUN_ATTEMPT: '1',
        },
        windowsHide: true,
      });
      expect(readFileSync(output, 'utf8')).toBe('claim=false\n');
      expect(writes).toEqual([]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('settles an attempt whose preparation fails after claiming the durable episode', async () => {
    const root = makeTempDir('station-repair-prepare-');
    let body = '';
    const server = createServer(async (req, res) => {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      res.setHeader('content-type', 'application/json');
      if (req.url?.includes('/branches/main')) {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      if (req.url?.includes('/actions/runs/42/jobs')) {
        res.end(
          JSON.stringify({ jobs: [{ name: 'corpus', conclusion: 'failure' }] }),
        );
        return;
      }
      if (req.url?.endsWith('/actions/runs/42')) {
        res.end(JSON.stringify(run));
        return;
      }
      if (req.url?.includes('/issues?')) {
        res.end('[]');
        return;
      }
      if (bytes) body = JSON.parse(bytes).body || body;
      res.end(JSON.stringify({ number: 7, state: 'open', body }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const event = join(root, 'event.json');
    writeFileSync(event, JSON.stringify({ workflow_run: { id: 42 } }));
    const output = join(root, 'output');
    const env = {
      ...process.env,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      GITHUB_EVENT_PATH: event,
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: '99',
      GITHUB_RUN_ATTEMPT: '1',
      REPAIR_ISSUE: '7',
    };
    try {
      await expect(
        exec(process.execPath, [script, 'prepare'], {
          cwd: root,
          env,
          windowsHide: true,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(readFileSync(output, 'utf8')).toContain('claim=true');
      expect(repairState(body)?.repairState).toBe('claimed');
      await exec(process.execPath, [script, 'settle'], {
        cwd: root,
        env,
        windowsHide: true,
      });
      expect(repairState(body)?.repairState).toBe('needs-owner');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it('publishes the actual proposed Git diff to a repair branch and refuses protected changes before push', async () => {
    const { root, repo, git, sha } = fixture();
    const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
    const state = nextRepairState(null, run).state;
    const issue = {
      state: 'open',
      body: `<!-- station-qualification:${JSON.stringify(state)} -->`,
    };
    let failPublication = true;
    const server = createServer(async (req, res) => {
      let bytes = '';
      for await (const chunk of req) bytes += chunk;
      if (bytes) posted.push({ path: req.url || '', body: JSON.parse(bytes) });
      res.setHeader('content-type', 'application/json');
      if (failPublication && req.url?.endsWith('/pulls')) {
        res.writeHead(503);
        res.end('{}');
        return;
      }
      res.end(
        JSON.stringify(
          req.url?.endsWith('/pulls')
            ? { number: 8, html_url: 'https://github.com/owner/repo/pull/8' }
            : issue,
        ),
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const context = {
      issue: 7,
      episode: 42,
      baseSha: sha,
      failedSha: run.head_sha,
      attempt: '99-1',
      branch: 'repair/qualification-42-99-1',
      runUrl: 'https://github.com/owner/repo/actions/runs/42',
    };
    const contextPath = join(root, 'context.json');
    writeFileSync(contextPath, JSON.stringify(context));
    const patch = join(root, 'proposal.patch');
    const env = {
      ...process.env,
      GH_TOKEN: 'fixture-token',
      ISSUE_TOKEN: 'fixture-issue-token',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      REPAIR_CONTEXT: contextPath,
      REPAIR_PATCH: patch,
    };
    try {
      mkdirSync(join(repo, 'src-server'));
      writeFileSync(join(repo, 'src-server/fix.txt'), 'repaired\n');
      git('add', '--intent-to-add', '.');
      writeFileSync(patch, `${git('diff', '--binary', 'HEAD')}\n`);
      git('reset', '-q');
      rmSync(join(repo, 'src-server'), { recursive: true });
      await expect(
        exec(process.execPath, [script, 'publish'], {
          cwd: repo,
          env,
          windowsHide: true,
        }),
      ).rejects.toMatchObject({ code: 1 });
      git('reset', '--hard', sha);
      failPublication = false;
      writeFileSync(
        contextPath,
        JSON.stringify({
          ...context,
          attempt: '100-1',
          branch: 'repair/qualification-42-100-1',
        }),
      );
      await exec(process.execPath, [script, 'publish'], {
        cwd: repo,
        env,
        windowsHide: true,
      });
      const landed = execFileSync(
        'git',
        [
          '--git-dir',
          join(root, 'remote.git'),
          'show',
          'repair/qualification-42-100-1:src-server/fix.txt',
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      expect(landed).toBe('repaired\n');
      expect(
        posted.filter((item) => item.path.endsWith('/pulls')).at(-1)?.body.head,
      ).toBe('repair/qualification-42-100-1');
      git('reset', '--hard', sha);
      mkdirSync(join(repo, '.github'));
      writeFileSync(join(repo, '.github/unsafe.yml'), 'unsafe\n');
      git('add', '--intent-to-add', '.');
      writeFileSync(patch, `${git('diff', '--binary', 'HEAD')}\n`);
      git('reset', '-q');
      rmSync(join(repo, '.github'), { recursive: true });
      const count = posted.length;
      await expect(
        exec(process.execPath, [script, 'publish'], {
          cwd: repo,
          env,
          windowsHide: true,
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(posted).toHaveLength(count);
      expect(
        execFileSync(
          'git',
          [
            '--git-dir',
            join(root, 'remote.git'),
            'rev-parse',
            'repair/qualification-42-99-1',
          ],
          { encoding: 'utf8', windowsHide: true },
        ).trim(),
      ).not.toBe(sha);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
