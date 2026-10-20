import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { execFileSyncBounded } from '../lib/bounded-capture.mjs';

const exec = promisify(execFile);
const script = resolve(import.meta.dirname, '../merge-queue-dequeue.mjs');
const makeTempDir = trackTempDirs();
const AUTHOR = 'station-automation[bot]';
const GROUP_SHA = 'c'.repeat(40);
const OTHER_GROUP_SHA = 'd'.repeat(40);

type Call = {
  method: string;
  path: string;
  body?: { body?: string; query?: string; variables?: { id?: string } };
};
type Comment = {
  id: number;
  node_id?: string;
  user: { login: string };
  body: string;
};

/**
 * A loopback GitHub serving exactly the shapes the dequeue script reads:
 * GraphQL timeline, Actions runs and artifacts, check runs and annotations,
 * the pull request and its issue comments. Every request is recorded.
 */
async function fakeGitHub(state: {
  removals: Array<{ createdAt: string; reason: string }>;
  head?: { oid: string; committedDate: string };
  pr?: Record<string, unknown>;
  comments?: Comment[];
  /** Failing checks with long annotations, to exceed the body limit. */
  noisyChecks?: number;
}) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    const path = (req.url ?? '').replace('/repos/owner/repo/', '/');
    calls.push({
      method: req.method ?? 'GET',
      path,
      ...(bytes ? { body: JSON.parse(bytes) } : {}),
    });
    res.setHeader('content-type', 'application/json');
    const send = (value: unknown) => res.end(JSON.stringify(value));
    if (path === '/graphql' && bytes.includes('minimizeComment'))
      return send({
        data: { minimizeComment: { minimizedComment: { isMinimized: true } } },
      });
    if (path === '/graphql')
      return send({
        data: {
          repository: {
            pullRequest: {
              commits: { nodes: state.head ? [{ commit: state.head }] : [] },
              timelineItems: { nodes: state.removals },
            },
          },
        },
      });
    if (path.startsWith('/actions/runs?'))
      return send({
        workflow_runs: [
          {
            id: 501,
            head_branch: `gh-readonly-queue/main/pr-7-${'a'.repeat(40)}`,
            head_sha: GROUP_SHA,
            created_at: new Date(Date.now() - 20 * 60_000).toISOString(),
          },
          {
            id: 502,
            head_branch: `gh-readonly-queue/main/pr-8-${'a'.repeat(40)}`,
            head_sha: OTHER_GROUP_SHA,
            created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
          },
        ],
      });
    if (
      path.startsWith(`/commits/${GROUP_SHA}/check-runs`) &&
      state.noisyChecks
    )
      return send({
        check_runs: Array.from({ length: state.noisyChecks }, (_, i) => ({
          id: 100 + i,
          name: `noisy check ${i}`,
          conclusion: 'failure',
          details_url: 'https://github.com/owner/repo/actions/runs/501/job/1',
        })),
      });
    if (/^\/check-runs\/1[0-9]{2}\/annotations/.test(path))
      return send(
        Array.from({ length: 8 }, (_, i) => ({
          annotation_level: 'failure',
          path: `src/${'deep/'.repeat(80)}file${i}.test.ts`,
          title: 'T'.repeat(400),
          message: 'M'.repeat(2_000),
        })),
      );
    if (path.startsWith(`/commits/${GROUP_SHA}/check-runs`))
      return send({
        check_runs: [
          {
            id: 11,
            name: 'fast-checks shard 2',
            conclusion: 'failure',
            html_url: 'https://github.com/owner/repo/actions/runs/501/job/11',
            details_url:
              'https://github.com/owner/repo/actions/runs/501/job/11',
          },
          {
            id: 12,
            name: 'Windows PR portable floor',
            conclusion: 'success',
            details_url:
              'https://github.com/owner/repo/actions/runs/503/job/12',
          },
        ],
      });
    if (path.startsWith('/check-runs/11/annotations'))
      return send([
        {
          annotation_level: 'failure',
          path: 'src-ui/Row.test.tsx',
          title: 'row geometry @everyone',
          message: 'AssertionError: actions wrapped under the row',
        },
        {
          annotation_level: 'failure',
          path: '.github',
          message: 'Process completed with exit code 1.',
        },
      ]);
    if (path.startsWith('/actions/runs/501/artifacts'))
      return send({
        artifacts: [
          {
            id: 901,
            name: 'fast-checks-vitest-reports-2-501-1',
            size_in_bytes: 4096,
            expired: false,
          },
          { id: 902, name: 'expired', size_in_bytes: 1, expired: true },
        ],
      });
    if (path === '/pulls/7') return send(state.pr ?? {});
    if (path.startsWith('/issues/7/comments') && req.method === 'GET')
      return send(state.comments ?? []);
    if (req.method === 'POST' || req.method === 'PATCH') return send({ id: 1 });
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return {
    calls,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

function writes(calls: Call[]) {
  return calls.filter(
    (call) => call.method !== 'GET' && call.path !== '/graphql',
  );
}
function minimized(calls: Call[]) {
  return calls
    .filter((call) => call.body?.query?.includes('minimizeComment'))
    .map((call) => call.body?.variables?.id);
}

/** A base checkout whose origin holds main and a pull-request head. */
function repositories(prContent: string) {
  const root = makeTempDir('station-dequeue-');
  const remote = join(root, 'remote.git');
  const work = join(root, 'author');
  const checkout = join(root, 'checkout');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  execFileSync('git', ['init', '--bare', '-q', remote], { windowsHide: true });
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'config', 'user.name', 'Fixture');
  git(work, 'config', 'user.email', 'fixture@example.test');
  writeFileSync(join(work, 'a.txt'), 'base\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'base');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(work, prContent === 'clean' ? 'b.txt' : 'a.txt'), 'pr\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'pr');
  const head = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  git(work, 'checkout', '-q', 'main');
  writeFileSync(join(work, 'a.txt'), 'main moved\n');
  git(work, 'commit', '-qam', 'main moved');
  git(work, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', remote, checkout);
  return { root, checkout, head };
}

async function run(
  api: { url: string },
  {
    cwd,
    reason,
    bin,
    policyScript = script,
  }: { cwd: string; reason?: string; bin?: string; policyScript?: string },
) {
  const event = join(cwd, '..', `event-${Math.random()}.json`);
  writeFileSync(
    event,
    JSON.stringify({ action: 'dequeued', pull_request: { number: 7 }, reason }),
  );
  return exec(process.execPath, [policyScript], {
    cwd,
    env: {
      ...process.env,
      PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH,
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_API_URL: api.url,
      GITHUB_GRAPHQL_URL: `${api.url}/graphql`,
      GH_TOKEN: 'app-token',
      ACTIONS_TOKEN: 'actions-token',
      COMMENT_AUTHOR: AUTHOR,
    },
    windowsHide: true,
  });
}

function fakeGh(root: string) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$0.calls"\n',
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { bin, calls: () => readFileSync(join(bin, 'gh.calls'), 'utf8') };
}

const recent = () => new Date(Date.now() - 60_000).toISOString();

describe.runIf(process.platform !== 'win32')(
  'merge-queue dequeue report',
  () => {
    it('names the failing check, its test annotations and artifacts, once per removal', async () => {
      const cwd = makeTempDir('station-dequeue-failure-');
      const removedAt = recent();
      const api = await fakeGitHub({
        removals: [{ createdAt: removedAt, reason: 'failed_checks' }],
        comments: [
          // Another account's marker is not this app's report.
          {
            id: 3,
            user: { login: 'someone' },
            body: '<!-- station-merge-queue-dequeue x -->',
          },
        ],
      });
      try {
        const { stdout } = await run(api, { cwd });
        expect(stdout).toContain('dequeue: reported-failure');
        const posted = writes(api.calls);
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({
          method: 'POST',
          path: '/issues/7/comments',
        });
        const body = posted[0].body?.body ?? '';
        expect(
          body.startsWith(
            `<!-- station-merge-queue-dequeue failure:${removedAt} -->`,
          ),
        ).toBe(true);
        expect(body).toContain('fast-checks shard 2');
        expect(body).toContain('src-ui/Row.test.tsx :: row geometry @everyone');
        expect(body).toContain('AssertionError: actions wrapped under the row');
        // Untrusted names stay inside a literal block, so the mention is inert.
        expect(body).toMatch(/```text\n[^`]*@everyone[^`]*\n```/);
        expect(body).not.toContain('Process completed with exit code');
        expect(body).not.toContain('Windows PR portable floor');
        expect(body).toContain(
          'https://github.com/owner/repo/actions/runs/501/artifacts/901',
        );
        expect(body).not.toContain('/artifacts/902');
        expect(body).not.toContain('d'.repeat(12));
      } finally {
        await api.close();
      }
    });

    it('posts a new report for a new removal, minimizes its earlier one, and skips a removal already reported', async () => {
      const cwd = makeTempDir('station-dequeue-update-');
      const removedAt = recent();
      const comments: Comment[] = [
        {
          id: 44,
          node_id: 'IC_old',
          user: { login: AUTHOR },
          body: '<!-- station-merge-queue-dequeue failure:2026-01-01T00:00:00Z -->\nold',
        },
      ];
      const api = await fakeGitHub({
        removals: [{ createdAt: removedAt, reason: 'failed_checks' }],
        comments,
      });
      try {
        await run(api, { cwd });
        // A new comment notifies the owner; an edit would be silent.
        const posted = writes(api.calls);
        expect(posted).toEqual([
          expect.objectContaining({
            method: 'POST',
            path: '/issues/7/comments',
          }),
        ]);
        expect(minimized(api.calls)).toEqual(['IC_old']);
        comments.push({
          id: 45,
          node_id: 'IC_new',
          user: { login: AUTHOR },
          body: posted[0].body?.body ?? '',
        });
        api.calls.length = 0;
        const { stdout } = await run(api, { cwd });
        expect(stdout).toContain('already reported');
        expect(writes(api.calls)).toEqual([]);
        expect(minimized(api.calls)).toEqual([]);
      } finally {
        await api.close();
      }
    });

    it("ignores a forged marker in another account's comment, even for this exact removal", async () => {
      const cwd = makeTempDir('station-dequeue-forged-');
      const removedAt = recent();
      const api = await fakeGitHub({
        removals: [{ createdAt: removedAt, reason: 'failed_checks' }],
        comments: [
          {
            id: 9,
            node_id: 'IC_forged',
            user: { login: 'someone' },
            body: `<!-- station-merge-queue-dequeue failure:${removedAt} -->\nnothing to see`,
          },
        ],
      });
      try {
        const { stdout } = await run(api, { cwd });
        expect(stdout).toContain('posted the removal report');
        expect(writes(api.calls)).toEqual([
          expect.objectContaining({
            method: 'POST',
            path: '/issues/7/comments',
          }),
        ]);
        expect(minimized(api.calls)).toEqual([]);
      } finally {
        await api.close();
      }
    });

    it("keeps a report of many noisy checks under GitHub's comment limit, marking truncation", async () => {
      const cwd = makeTempDir('station-dequeue-noisy-');
      const api = await fakeGitHub({
        removals: [{ createdAt: recent(), reason: 'failed_checks' }],
        noisyChecks: 12,
      });
      try {
        await run(api, { cwd });
        const body = writes(api.calls)[0]?.body?.body ?? '';
        expect(body.length).toBeGreaterThan(30_000);
        expect(body.length).toBeLessThan(65_536);
        // Every shown check keeps its own section and says it was cut.
        for (let i = 0; i < 10; i++) expect(body).toContain(`noisy check ${i}`);
        expect(
          body.match(/Truncated to fit the comment size limit/g),
        ).toHaveLength(10);
        expect(body).toContain('2 more failing check(s) omitted.');
      } finally {
        await api.close();
      }
    });

    it('keeps the arm job off dequeue events and runs the dequeue job only for them', () => {
      const workflow = load(
        readFileSync(
          resolve(
            import.meta.dirname,
            '../../.github/workflows/landing-automation.yml',
          ),
          'utf8',
        ),
      ) as { jobs: Record<string, { if: string }> };
      const sameRepo = (action: string, label?: string) => ({
        event_name: 'pull_request_target',
        repository: 'owner/repo',
        event: {
          action,
          ...(label ? { label: { name: label } } : {}),
          pull_request: { head: { repo: { full_name: 'owner/repo' } } },
        },
      });
      expect(evaluate(workflow.jobs.arm.if, sameRepo('dequeued'))).toBe(false);
      expect(evaluate(workflow.jobs.arm.if, sameRepo('reopened'))).toBe(true);
      expect(
        evaluate(workflow.jobs.arm.if, sameRepo('labeled', 'station-autoland')),
      ).toBe(true);
      expect(evaluate(workflow.jobs.dequeue.if, sameRepo('dequeued'))).toBe(
        true,
      );
      expect(evaluate(workflow.jobs.dequeue.if, sameRepo('reopened'))).toBe(
        false,
      );
    });

    it('loads the trusted workflow helper when a PR event base predates that helper', async () => {
      const directory = makeTempDir('station-dequeue-policy-revision-');
      const cwd = join(directory, 'repository');
      mkdirSync(cwd);
      const git = (...args: string[]) =>
        execFileSyncBounded('git', args, {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        }).trim();
      git('init', '-q', '-b', 'main');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@example.test');
      writeFileSync(join(cwd, 'base.txt'), 'event base\n');
      git('add', '.');
      git('commit', '-qm', 'event base');
      const eventBase = git('rev-parse', 'HEAD');
      mkdirSync(join(cwd, 'scripts', 'lib'), { recursive: true });
      for (const path of [
        'merge-queue-dequeue.mjs',
        'qualification-evidence.mjs',
        'lib/module-entry.mjs',
      ]) {
        writeFileSync(
          join(cwd, 'scripts', path),
          readFileSync(resolve(import.meta.dirname, '..', path)),
        );
      }
      git('add', '.');
      git('commit', '-qm', 'trusted policy helper');
      const workflowSha = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'candidate', eventBase);
      mkdirSync(join(cwd, 'scripts'), { recursive: true });
      writeFileSync(
        join(cwd, 'scripts', 'merge-queue-dequeue.mjs'),
        "throw new Error('candidate code executed');\n",
      );
      git('add', '.');
      git('commit', '-qm', 'untrusted candidate helper');
      const candidateSha = git('rev-parse', 'HEAD');
      const workflow = load(
        readFileSync(
          resolve(
            import.meta.dirname,
            '../../.github/workflows/landing-automation.yml',
          ),
          'utf8',
        ),
      ) as {
        jobs: Record<
          string,
          { steps: Array<{ uses?: string; with?: { ref?: string } }> }
        >;
      };
      const api = await fakeGitHub({
        removals: [{ createdAt: recent(), reason: 'merged' }],
      });
      try {
        for (const baseSha of [eventBase, workflowSha]) {
          const context = {
            workflow_sha: workflowSha,
            sha: workflowSha,
            event: {
              pull_request: {
                base: { sha: baseSha },
                head: { sha: candidateSha },
              },
            },
          };
          for (const job of ['arm', 'dequeue']) {
            const checkout = workflow.jobs[job].steps.find((step) =>
              step.uses?.startsWith('actions/checkout@'),
            );
            expect(checkout?.with?.ref).toBeTruthy();
            const ref = String(evaluate(checkout?.with?.ref ?? '', context));
            expect(ref).toBe(workflowSha);
            git('checkout', '-q', '--detach', ref);
          }
          const result = await run(api, {
            cwd,
            policyScript: join(cwd, 'scripts', 'merge-queue-dequeue.mjs'),
          });
          expect(result.stdout).toContain('dequeue: ignored');
          expect(git('rev-parse', 'HEAD')).toBe(workflowSha);
        }
        expect(api.calls.map((call) => call.path)).toEqual([
          '/graphql',
          '/graphql',
        ]);
      } finally {
        await api.close();
      }
    });

    it('lists the files that really conflict with main and does not re-arm', async () => {
      const { root, checkout, head } = repositories('conflict');
      const gh = fakeGh(root);
      const api = await fakeGitHub({
        removals: [{ createdAt: recent(), reason: 'merge_conflict' }],
        head: {
          oid: head,
          committedDate: new Date(Date.now() - 3_600_000).toISOString(),
        },
        pr: autolandPr(head),
      });
      try {
        const { stdout } = await run(api, { cwd: checkout, bin: gh.bin });
        expect(stdout).toContain('dequeue: reported-conflict');
        const body = writes(api.calls)[0]?.body?.body ?? '';
        expect(body).toContain('conflicts with main');
        expect(body).toMatch(/```text\na\.txt\n```/);
        expect(gh.calls).toThrow();
      } finally {
        await api.close();
      }
    });

    it('re-arms an opted-in PR that merges cleanly with main, silently and once per head', async () => {
      const { root, checkout, head } = repositories('clean');
      const gh = fakeGh(root);
      const committedDate = new Date(Date.now() - 3_600_000).toISOString();
      const first = { createdAt: recent(), reason: 'merge_conflict' };
      const api = await fakeGitHub({
        removals: [first],
        head: { oid: head, committedDate },
        pr: autolandPr(head),
      });
      try {
        const { stdout } = await run(api, { cwd: checkout, bin: gh.bin });
        expect(stdout).toContain('dequeue: rearmed');
        expect(gh.calls()).toBe(
          `pr merge 7 --repo owner/repo --auto --match-head-commit ${head}\n`,
        );
        expect(writes(api.calls)).toEqual([]);
      } finally {
        await api.close();
      }
      // The same head removed for a conflict again: report, never re-arm twice.
      const again = await fakeGitHub({
        removals: [
          {
            createdAt: new Date(Date.now() - 600_000).toISOString(),
            reason: 'merge_conflict',
          },
          first,
        ],
        head: { oid: head, committedDate },
        pr: autolandPr(head),
      });
      try {
        const { stdout } = await run(again, { cwd: checkout, bin: gh.bin });
        expect(stdout).toContain('dequeue: reported-repeated');
        expect(gh.calls()).toBe(
          `pr merge 7 --repo owner/repo --auto --match-head-commit ${head}\n`,
        );
        expect(writes(again.calls)[0]?.body?.body).toContain('at most once');
      } finally {
        await again.close();
      }
    });

    it('does not re-arm a clean PR without the station-autoland label', async () => {
      const { root, checkout, head } = repositories('clean');
      const gh = fakeGh(root);
      const api = await fakeGitHub({
        removals: [{ createdAt: recent(), reason: 'merge_conflict' }],
        head: {
          oid: head,
          committedDate: new Date(Date.now() - 3_600_000).toISOString(),
        },
        pr: { ...autolandPr(head), labels: [] },
      });
      try {
        const { stdout } = await run(api, { cwd: checkout, bin: gh.bin });
        expect(stdout).toContain('dequeue: reported-clean');
        expect(gh.calls).toThrow();
        expect(writes(api.calls)[0]?.body?.body).toContain('merges cleanly');
      } finally {
        await api.close();
      }
    });

    it('ignores a removal by merge, and a stale removal from an earlier dequeue', async () => {
      const cwd = makeTempDir('station-dequeue-ignore-');
      for (const removal of [
        { createdAt: recent(), reason: 'merged' },
        {
          createdAt: new Date(Date.now() - 3_600_000).toISOString(),
          reason: 'failed_checks',
        },
      ]) {
        const api = await fakeGitHub({ removals: [removal] });
        try {
          const { stdout } = await run(api, { cwd });
          expect(stdout).toContain('dequeue: ignored');
          expect(api.calls.map((call) => call.path)).toEqual(['/graphql']);
        } finally {
          await api.close();
        }
      }
    });
  },
);

function autolandPr(head: string) {
  return {
    number: 7,
    state: 'open',
    draft: false,
    base: { ref: 'main' },
    head: { sha: head, repo: { full_name: 'owner/repo' } },
    labels: [{ name: 'station-autoland' }],
    auto_merge: null,
  };
}

/**
 * Evaluates a GitHub Actions `if:` expression made only of `github.*`
 * properties, string literals, ==, !=, && and || (what landing automation
 * uses). Anything else is refused, so a richer expression fails loudly.
 */
function evaluate(expression: string, github: Record<string, unknown>) {
  const body = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const stripped = body
    .replace(/'[^']*'/g, '')
    .replace(/github(?:\.[A-Za-z_]+)+/g, '')
    .replace(/==|!=|&&|\|\||[()\s]/g, '');
  if (stripped) throw new Error(`unsupported expression syntax: ${stripped}`);
  const js = body
    .replace(
      /github((?:\.[A-Za-z_]+)+)/g,
      (_m, path: string) => `github${path.replaceAll('.', '?.')}`,
    )
    .replace(/==/g, '===')
    .replace(/!===/g, '!==');
  return new Function('github', `return (${js});`)(github) as boolean;
}
