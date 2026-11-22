import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { readWorkflowDocuments } from '../actionlint-gate.mjs';
import {
  classifyCancellation,
  failingLines,
  renderTrackerBody,
  summarizeRunFailure,
  TRACKER_MARKER,
} from '../main-health-comment-policy.mjs';
import {
  cronIntervalMs,
  decideOverdue,
  isOverdueBody,
  OVERDUE_FLOOR_MS,
  overdueLimitMs,
  readWatchedSchedules,
  renderOverdueBody,
  scheduleEffectiveSince,
  watchedWorkflowNames,
  workflowSchedule,
} from '../main-health-schedules.mjs';

/**
 * Owner decision: a scheduled workflow's failure must reach a person as an
 * issue, not only as a red run on the Actions tab, and not running at all is
 * a failure too. `main-health.yml` is the one reporter (one tracker per
 * workflow, updated in place, closed by the next green or the next run).
 * These tests hold every scheduled workflow to it and execute its job
 * conditions and scripts verbatim against a stateful fake GitHub.
 */

const root = new URL('../..', import.meta.url);
const MAIN_HEALTH = '.github/workflows/main-health.yml';
const HOUR = 3_600_000;

/**
 * Scheduled workflows that report through something other than main-health,
 * each with the reason. A new scheduled workflow fails this suite until it is
 * watched by main-health or added here, and an entry for a workflow that is
 * gone or no longer scheduled fails it too, so the list cannot rot.
 */
const REPORTED_ELSEWHERE: Record<string, string> = {
  '.github/workflows/main-qualification.yml':
    'qualification-repair.yml opens the "Main qualification repair" episode issue for a red run and qualification-health.yml files "Main qualification health" for staleness; both belong to the qualification cadence owner',
};

type Step = {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { if?: string; permissions?: unknown; steps: Step[] };
type WorkflowDocument = {
  name?: string;
  on?: Record<string, unknown> & {
    schedule?: { cron: string }[];
    workflow_run?: { workflows?: string[]; branches?: string[] };
  };
  permissions?: unknown;
  jobs: Record<string, Job>;
};

function documents() {
  return readWorkflowDocuments() as { file: string; document: unknown }[];
}

function mainHealth() {
  return documents().find(({ file }) => file === MAIN_HEALTH)
    ?.document as WorkflowDocument;
}

function scheduled() {
  return documents().filter(({ document }) => {
    const on = (document as WorkflowDocument | null)?.on;
    return Boolean(on && typeof on === 'object' && 'schedule' in on);
  });
}

/**
 * Evaluates a GitHub Actions `if:` made only of `github.*` properties, string
 * literals, ==, !=, && and || (the subset ci-workflow-contract.test.ts
 * evaluates). Anything richer is refused, never guessed.
 */
function evaluateGithubIf(expression: string, github: unknown) {
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

/** Resolves a step's `${{ github.x.y }}` env values the way the runner does. */
function resolveEnv(env: Record<string, string> | undefined, github: unknown) {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const match = /^\$\{\{\s*github((?:\.[A-Za-z_]+)+)\s*\}\}$/.exec(value);
    if (!match) throw new Error(`unsupported env expression: ${value}`);
    let current: unknown = github;
    for (const part of match[1].slice(1).split('.'))
      current = (current as Record<string, unknown> | undefined)?.[part];
    resolved[key] = current == null ? '' : String(current);
  }
  return resolved;
}

type Issue = {
  creator?: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  closed_at?: string | null;
  state_reason?: string | null;
  labels: string[];
  comments: { id: number; body: string; user: { type: string } }[];
};

/** Real-shaped `listJobsForWorkflowRun` entries. */
function job(
  id: number,
  name: string,
  conclusion: string,
  steps: [string, string][] = [],
) {
  return {
    id,
    run_id: 900,
    name,
    status: 'completed',
    conclusion,
    steps: steps.map(([stepName, stepConclusion], index) => ({
      name: stepName,
      status: 'completed',
      conclusion: stepConclusion,
      number: index + 1,
    })),
  };
}

/** Real-shaped `checks.listAnnotations` entries (a job id is its check-run id). */
function annotation(message: string, level = 'failure') {
  return {
    path: '.github',
    start_line: 1,
    end_line: 1,
    annotation_level: level,
    title: '',
    message,
    raw_details: '',
  };
}

/**
 * Cancellation annotations copied verbatim from real runs
 * (`gh api repos/kontourai/station/check-runs/<job id>/annotations`).
 */
const REAL_CANCELS = {
  person: {
    // Nightly run 39698506810, job 119580381450.
    message: 'The run was canceled by @briananderson1222.',
    cause: 'person',
  },
  superseded: {
    // PR: iOS build run 43974005046, job 133673171610.
    message:
      'Canceling since a higher priority waiting request for build-ios-PR: iOS build-5109 exists',
    cause: 'superseded',
  },
  supersededSmoke: {
    // Main: Container smoke run 43966051735, job 133647347507.
    message:
      'Canceling since a higher priority waiting request for container-smoke-refs/heads/main exists',
    cause: 'superseded',
  },
  notAcquiredNightly: {
    // Nightly run 43863134706, job 133326067954 ("Verify providers and
    // finalize"); same text in run 42242672641, job 128025480568.
    message:
      'The job was not acquired by Runner of type hosted even after multiple attempts',
    cause: 'infrastructure',
  },
  notAcquiredIos: {
    // PR: iOS build runs 43482394075 (job 132082610236), 43256092915 (job
    // 131315779715) and 42258632933 (job 128034355160): identical text.
    message:
      'The job was not acquired by Runner of type hosted even after multiple attempts',
    cause: 'infrastructure',
  },
  runnerLost: {
    // Main: Container smoke run 42050153692, job 127324215144.
    message:
      'The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.',
    cause: 'infrastructure',
  },
} as const;

/**
 * A stateful stand-in for the Octokit surface main-health calls. Issues and
 * comments persist across calls, so "the second failure updates the first
 * issue" is observed, not asserted on a mock's arguments.
 */
function fakeGithub({
  labelExists = true,
  labelError = false,
}: {
  labelExists?: boolean;
  labelError?: boolean;
} = {}) {
  const issues: Issue[] = [];
  let nextComment = 1;
  let run: {
    jobs: ReturnType<typeof job>[];
    annotations: Record<number, ReturnType<typeof annotation>[]>;
    failJobs?: boolean;
  } = { jobs: [], annotations: {} };
  const scheduledRuns: Record<
    string,
    {
      created_at: string;
      html_url: string;
      status?: string;
      conclusion?: string;
    } | null
  > = {};
  const fileHistory: Record<
    string,
    { sha: string; date: string; text: string }[]
  > = {};
  const historyOf = (path: string) => {
    const file = path.replace('.github/workflows/', '');
    return (
      fileHistory[file] ?? [
        {
          sha: `base-${file}`,
          date: '2026-09-01T00:00:00Z',
          text: readFileSync(new URL(path, root), 'utf8'),
        },
      ]
    );
  };
  // The fake's own clock for closed_at; tests move it to replay a day.
  const clock = { now: () => Date.now() };
  const failingRuns = new Set<string>();
  // Lets a test run another job between this job's read and its first write.
  const interleave: { beforeUpdate?: () => Promise<unknown> } = {};
  const otherRuns: {
    id: number;
    workflow_id: number;
    head_branch: string;
    created_at: string;
  }[] = [];
  const writes: string[] = [];
  const calls: string[] = [];
  const find = (number: number) => {
    const issue = issues.find((candidate) => candidate.number === number);
    if (!issue) throw new Error(`no issue ${number}`);
    return issue;
  };
  const view = ({
    comments: _comments,
    labels,
    creator: _creator,
    ...issue
  }: Issue) => ({
    ...issue,
    labels: labels.map((name) => ({ name })),
  });
  const listJobs = async () => {
    if (run.failJobs) throw new Error('HTTP 502 from listJobsForWorkflowRun');
    return { data: run.jobs };
  };
  const listComments = async ({ issue_number }: { issue_number: number }) => ({
    data: find(issue_number).comments.map((comment) => ({ ...comment })),
  });
  const github = {
    rest: {
      actions: {
        listJobsForWorkflowRun: listJobs,
        listWorkflowRuns: async ({
          workflow_id,
          event,
          branch,
        }: {
          workflow_id: string | number;
          event?: string;
          branch?: string;
        }) => {
          calls.push('listWorkflowRuns');
          if (failingRuns.has(String(workflow_id)))
            throw Object.assign(new Error('Server Error'), { status: 502 });
          if (event === 'schedule') {
            const last = scheduledRuns[String(workflow_id)];
            return { data: { workflow_runs: last ? [last] : [] } };
          }
          return {
            data: {
              workflow_runs: otherRuns.filter(
                (other) =>
                  other.workflow_id === workflow_id &&
                  other.head_branch === branch,
              ),
            },
          };
        },
      },
      repos: {
        // Each workflow file's history, newest first; by default one commit
        // from 2026-09-01 holding the file as it is now.
        listCommits: async ({ path }: { path: string }) => ({
          data: historyOf(path).map((entry) => ({
            sha: entry.sha,
            commit: { committer: { date: entry.date } },
          })),
        }),
        getContent: async ({ path, ref }: { path: string; ref: string }) => {
          const entry = historyOf(path).find(
            (candidate) => candidate.sha === ref,
          );
          if (!entry)
            throw Object.assign(new Error('Not Found'), { status: 404 });
          return {
            data: {
              content: Buffer.from(entry.text).toString('base64'),
              encoding: 'base64',
            },
          };
        },
      },
      checks: {
        listAnnotations: async ({
          check_run_id,
        }: {
          check_run_id: number;
        }) => ({
          data: run.annotations[check_run_id] ?? [],
        }),
      },
      issues: {
        getLabel: async ({ name }: { name: string }) => {
          calls.push('getLabel');
          if (labelError)
            throw Object.assign(new Error('Server Error'), { status: 502 });
          if (!labelExists || name !== 'ci:red')
            throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: { name } };
        },
        // The one consistent read: issues the workflow bot opened. A scan
        // without the creator filter would read every issue in the repo.
        listForRepo: async ({
          creator,
          state,
        }: {
          creator?: string;
          state: string;
        }) => {
          calls.push('listForRepo');
          if (creator !== 'github-actions[bot]')
            throw new Error('unbounded listForRepo: filter by the bot creator');
          return {
            data: issues
              .filter((issue) => state === 'all' || issue.state === state)
              .filter((issue) => (issue.creator ?? creator) === creator)
              .map(view),
          };
        },
        listComments,
        create: async ({
          title,
          body,
          labels,
        }: {
          title: string;
          body: string;
          labels: string[];
        }) => {
          writes.push('create');
          if (!labelExists && labels.includes('ci:red'))
            throw new Error('would create an unreconciled label');
          issues.push({
            number: 100 + issues.length,
            title,
            body,
            state: 'open',
            labels: [...labels],
            comments: [],
          });
        },
        update: async ({
          issue_number,
          state,
          state_reason,
          body,
        }: {
          issue_number: number;
          state?: 'open' | 'closed';
          state_reason?: string;
          body?: string;
        }) => {
          const hook = interleave.beforeUpdate;
          interleave.beforeUpdate = undefined;
          if (hook) await hook();
          writes.push(`update:${state ?? 'body'}`);
          const issue = find(issue_number);
          if (state) {
            issue.state = state;
            issue.state_reason =
              state === 'closed' ? (state_reason ?? 'completed') : null;
            issue.closed_at =
              state === 'closed' ? new Date(clock.now()).toISOString() : null;
          }
          if (body !== undefined) issue.body = body;
        },
        addLabels: async ({
          issue_number,
          labels,
        }: {
          issue_number: number;
          labels: string[];
        }) => {
          writes.push('addLabels');
          if (!labelExists && labels.includes('ci:red'))
            throw new Error('would create an unreconciled label');
          const issue = find(issue_number);
          issue.labels = [...new Set([...issue.labels, ...labels])];
        },
        addAssignees: async () => {
          writes.push('addAssignees');
        },
        createComment: async ({
          issue_number,
          body,
        }: {
          issue_number: number;
          body: string;
        }) => {
          writes.push('createComment');
          find(issue_number).comments.push({
            id: nextComment++,
            body,
            user: { type: 'Bot' },
          });
        },
        updateComment: async ({
          comment_id,
          body,
        }: {
          comment_id: number;
          body: string;
        }) => {
          writes.push('updateComment');
          for (const issue of issues)
            for (const comment of issue.comments)
              if (comment.id === comment_id) comment.body = body;
        },
      },
    },
    paginate: async (
      method: (params: never) => Promise<{ data: unknown[] }>,
      params: never,
    ) => (await method(params)).data,
  };
  return {
    github,
    issues,
    writes,
    calls,
    scheduledRuns,
    fileHistory,
    otherRuns,
    interleave,
    clock,
    failingRuns,
    setRun(next: typeof run) {
      run = next;
    },
  };
}

/** The `github` expression context a workflow_run of `name` would produce. */
function workflowRunEvent(
  name: string,
  conclusion: string,
  overrides: Record<string, unknown> = {},
) {
  const id = 900 + Math.floor(Math.random() * 1000);
  return {
    repository: 'kontourai/station',
    event_name: 'workflow_run',
    event: {
      repository: { default_branch: 'main' },
      workflow_run: {
        id,
        name,
        conclusion,
        event: 'schedule',
        head_branch: 'main',
        head_sha: 'c'.repeat(40),
        html_url: `https://github.com/kontourai/station/actions/runs/${id}`,
        head_repository: { full_name: 'kontourai/station' },
        ...overrides,
      },
    },
  };
}

/**
 * Runs main-health for one workflow_run event: evaluates each job's `if`, and
 * for each job that would start (optionally only `only`), executes its
 * github-script step verbatim with env resolved from the step's own
 * declarations.
 */
async function runMainHealth(
  fake: ReturnType<typeof fakeGithub>,
  github: ReturnType<typeof workflowRunEvent>,
  { only, now }: { only?: string[]; now?: number } = {},
) {
  const document = mainHealth();
  const started: string[] = [];
  const core = { info: vi.fn(), warning: vi.fn() };
  for (const [jobName, definition] of Object.entries(document.jobs)) {
    if (only && !only.includes(jobName)) continue;
    if (!evaluateGithubIf(String(definition.if), github)) continue;
    started.push(jobName);
    const step = definition.steps.find(
      (candidate) => typeof candidate.with?.script === 'string',
    ) as Step;
    // vm.compileFunction with the main loader hosts the step's dynamic
    // import(), so the script runs as written.
    const fn = vm.compileFunction(
      `return async function (github, context, process, core) {\n${String(step.with?.script)}\n};`,
      [],
      { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    )();
    const realNow = Date.now;
    if (now !== undefined) Date.now = () => now;
    try {
      await fn(
        fake.github,
        {
          repo: { owner: 'kontourai', repo: 'station' },
          payload: { workflow_run: github.event.workflow_run },
        },
        {
          env: {
            GITHUB_WORKSPACE: pathToFileURL(root.pathname).href.replace(
              /\/$/,
              '',
            ),
            ...resolveEnv(step.env, github),
          },
        },
        core,
      );
    } finally {
      Date.now = realNow;
    }
  }
  return { started, core };
}

const RED_SWEEP = {
  jobs: [
    job(11, 'sweep', 'failure', [
      ['Set up job', 'success'],
      ['Scan dated TODOs', 'failure'],
    ]),
  ],
  annotations: {
    11: [
      annotation('dated TODO expired: src-server/foo.ts:12 (2026-10-01)'),
      annotation('Process completed with exit code 1.'),
      annotation('Node.js 20 is deprecated', 'warning'),
    ],
  },
};
const GREEN_SWEEP = {
  jobs: [job(12, 'sweep', 'success', [['Scan dated TODOs', 'success']])],
  annotations: {},
};
const REPORT = ['report-failure', 'close-after-success'];

/** A tracker body as Main: Health wrote it before the tracker marker (#4037's shape). */
const legacyBody = (workflowName: string) =>
  [
    'A required workflow failed on main.',
    '',
    `Workflow: ${workflowName}`,
    'Run: https://github.com/kontourai/station/actions/runs/39804813824',
    `Head SHA: ${'d'.repeat(40)}`,
  ].join('\n');

describe('scheduled workflow failure reporting', () => {
  it('watches every scheduled workflow from main-health or names who reports it instead', () => {
    const watched = new Set(mainHealth().on?.workflow_run?.workflows);
    const unreported = scheduled()
      .filter(({ file }) => !(file in REPORTED_ELSEWHERE))
      .filter(
        ({ document }) =>
          !watched.has(String((document as WorkflowDocument).name)),
      )
      .map(({ file }) => file);
    expect(unreported).toEqual([]);
    // An allowlist entry must name a workflow that exists, is still
    // scheduled, and that main-health does not also watch.
    for (const file of Object.keys(REPORTED_ELSEWHERE)) {
      expect(existsSync(new URL(file, root)), `${file} does not exist`).toBe(
        true,
      );
      const entry = scheduled().find((candidate) => candidate.file === file);
      expect(
        entry,
        `${file} is no longer scheduled; drop its entry`,
      ).toBeDefined();
      const document = entry?.document as WorkflowDocument | undefined;
      expect(watched.has(String(document?.name))).toBe(false);
      expect(REPORTED_ELSEWHERE[file].length).toBeGreaterThan(40);
    }
  });

  it('reports failed, timed-out, startup-failed and cancelled main runs, and closes only on success', () => {
    const jobs = mainHealth().jobs;
    const reports = (conclusion: string, overrides = {}) =>
      evaluateGithubIf(
        String(jobs['report-failure'].if),
        workflowRunEvent('Repo: Dated TODO sweep', conclusion, overrides),
      );
    const closes = (conclusion: string) =>
      evaluateGithubIf(
        String(jobs['close-after-success'].if),
        workflowRunEvent('Repo: Dated TODO sweep', conclusion),
      );
    for (const conclusion of [
      'failure',
      'timed_out',
      'startup_failure',
      'cancelled',
    ]) {
      expect(reports(conclusion), conclusion).toBe(true);
      expect(closes(conclusion), conclusion).toBe(false);
    }
    for (const conclusion of ['success', 'skipped', 'neutral'])
      expect(reports(conclusion), conclusion).toBe(false);
    expect(closes('success')).toBe(true);
    expect(reports('failure', { head_branch: 'feature' })).toBe(false);
    expect(
      reports('failure', { head_repository: { full_name: 'fork/station' } }),
    ).toBe(false);
  });

  it('never gives a write-scoped job in the reporter or the smoke a checkout of anything but the default branch', () => {
    // Scoped to the two workflows this change touches. Repo-wide the rule
    // does not hold by design: release, Nightly and TestFlight jobs hold
    // write scopes and check out the exact source they build.
    // A job holding a write scope must not check out (and so run) the code
    // of the commit it was triggered by or reports on.
    const touched = [MAIN_HEALTH, '.github/workflows/container-smoke.yml'];
    for (const file of touched) {
      const document = documents().find((entry) => entry.file === file)
        ?.document as WorkflowDocument;
      const workflowPermissions = document.permissions as
        | Record<string, string>
        | undefined;
      for (const [name, definition] of Object.entries(document.jobs)) {
        const permissions = (definition.permissions ??
          workflowPermissions ??
          {}) as Record<string, string>;
        const writes = Object.entries(permissions).filter(
          ([, level]) => level === 'write',
        );
        if (writes.length === 0) continue;
        for (const step of definition.steps) {
          if (!step.uses?.startsWith('actions/checkout@')) continue;
          expect(step.with?.ref, `${file}#${name} writes ${writes[0][0]}`).toBe(
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
            '${{ github.event.repository.default_branch }}',
          );
          expect(step.with?.['persist-credentials']).toBe(false);
        }
      }
    }
  });

  it('grants issue writes only to the reporter, which runs no code from the reported run', () => {
    const document = mainHealth();
    expect(Object.keys(document.on ?? {})).toEqual(['workflow_run']);
    expect(document.permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'read',
      issues: 'write',
    });
    for (const [name, definition] of Object.entries(document.jobs)) {
      expect(definition.permissions, name).toBeUndefined();
      for (const step of definition.steps) {
        if (!step.uses?.startsWith('actions/checkout@')) continue;
        expect(step.with?.ref).toBe(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
          '${{ github.event.repository.default_branch }}',
        );
        expect(step.with?.['persist-credentials']).toBe(false);
      }
    }
  });

  it('opens one tracker on the first red run, updates it on the second, and closes it on green', async () => {
    const fake = fakeGithub();
    fake.setRun(RED_SWEEP);
    const first = workflowRunEvent('Repo: Dated TODO sweep', 'failure');
    await runMainHealth(fake, first, { only: REPORT });

    expect(fake.issues).toHaveLength(1);
    const [tracker] = fake.issues;
    expect(tracker.title).toBe('Main pipeline red: Repo: Dated TODO sweep');
    expect(tracker.labels).toEqual(['bug', 'P1', 'ci:red']);
    expect(tracker.body).toContain(`Run: ${first.event.workflow_run.html_url}`);
    expect(tracker.body).toContain(`Head SHA: ${'c'.repeat(40)}`);
    expect(tracker.body).toContain('Trigger: schedule');
    expect(tracker.body).toContain('- sweep > Scan dated TODOs (failure)');
    expect(tracker.body).toContain(
      'sweep: dated TODO expired: src-server/foo.ts:12 (2026-10-01)',
    );
    expect(tracker.body).not.toContain('Node.js 20 is deprecated');

    const second = workflowRunEvent('Repo: Dated TODO sweep', 'failure', {
      head_sha: 'd'.repeat(40),
    });
    await runMainHealth(fake, second, { only: REPORT });
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].body).toContain(
      `Run: ${second.event.workflow_run.html_url}`,
    );
    expect(fake.issues[0].comments).toHaveLength(1);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      {
        only: REPORT,
      },
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].comments).toHaveLength(1);
    expect(fake.writes.filter((write) => write === 'create')).toHaveLength(1);

    fake.setRun(GREEN_SWEEP);
    const { started } = await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'success'),
      { only: REPORT },
    );
    expect(started).toEqual(['close-after-success']);
    expect(fake.issues[0].state).toBe('closed');
    expect(fake.issues[0].comments.at(-1)?.body).toContain(
      'Closed after a successful run on main.',
    );

    fake.setRun(RED_SWEEP);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      {
        only: REPORT,
      },
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].state).toBe('open');
  });

  it('closes before it comments: a failed close leaves no closing comment on an open tracker', async () => {
    const fake = fakeGithub();
    fake.setRun(RED_SWEEP);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      { only: REPORT },
    );
    expect(fake.issues[0].state).toBe('open');
    const commentsBefore = fake.issues[0].comments.length;

    fake.setRun(GREEN_SWEEP);
    fake.interleave.beforeUpdate = async () => {
      throw Object.assign(new Error('HTTP 502'), { status: 502 });
    };
    await expect(
      runMainHealth(
        fake,
        workflowRunEvent('Repo: Dated TODO sweep', 'success'),
        { only: REPORT },
      ),
    ).rejects.toThrow(/HTTP 502/);
    expect(fake.issues[0].state).toBe('open');
    expect(fake.issues[0].comments).toHaveLength(commentsBefore);
    expect(
      fake.issues[0].comments.some((comment) =>
        comment.body.includes('Closed after a successful run'),
      ),
    ).toBe(false);
  });

  it('keeps one tracker per workflow', async () => {
    const fake = fakeGithub();
    fake.setRun(RED_SWEEP);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      {
        only: REPORT,
      },
    );
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Starved PR report', 'failure'),
      {
        only: REPORT,
      },
    );
    expect(fake.issues.map((issue) => issue.title)).toEqual([
      'Main pipeline red: Repo: Dated TODO sweep',
      'Main pipeline red: Repo: Starved PR report',
    ]);
  });

  it('finds an unlabelled tracker by its title and never scans every issue', async () => {
    // Trackers opened before `ci:red` existed carry only bug and P1.
    const fake = fakeGithub();
    fake.issues.push({
      number: 4037,
      title: 'Main pipeline red: Repo: Dated TODO sweep',
      body: legacyBody('Repo: Dated TODO sweep'),
      state: 'open',
      labels: ['bug', 'P1'],
      comments: [],
    });
    fake.setRun(RED_SWEEP);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      {
        only: REPORT,
      },
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].labels).toEqual(['bug', 'P1', 'ci:red']);
    // One consistent listing, whatever the issue count.
    expect(fake.calls.filter((call) => call === 'listForRepo')).toHaveLength(1);
  });

  it('converges on the oldest of several open trackers, closing the others once', async () => {
    // #3403 and #4037 are both open for Main: Container smoke today.
    const fake = fakeGithub();
    for (const number of [4037, 3403])
      fake.issues.push({
        number,
        title: 'Main pipeline red: Main: Container smoke',
        body: legacyBody('Main: Container smoke'),
        state: 'open',
        labels: ['bug', 'P1'],
        comments: [],
      });
    fake.setRun({
      jobs: [job(51, 'smoke', 'failure', [['Build', 'failure']])],
      annotations: {},
    });
    await runMainHealth(
      fake,
      workflowRunEvent('Main: Container smoke', 'failure'),
      {
        only: REPORT,
      },
    );
    const byNumber = (number: number) =>
      fake.issues.find((issue) => issue.number === number);
    expect(byNumber(3403)?.state).toBe('open');
    expect(byNumber(3403)?.body).toContain('- smoke > Build (failure)');
    expect(byNumber(4037)?.state).toBe('closed');
    expect(byNumber(4037)?.comments.map((comment) => comment.body)).toEqual([
      'Duplicate of #3403: Main: Health keeps one tracker per workflow and reports there.',
    ]);
    await runMainHealth(
      fake,
      workflowRunEvent('Main: Container smoke', 'failure'),
      {
        only: REPORT,
      },
    );
    expect(byNumber(4037)?.comments).toHaveLength(1);
    expect(fake.issues).toHaveLength(2);
  });

  it('never reopens a tracker closed as a duplicate', async () => {
    const fake = fakeGithub();
    fake.issues.push(
      {
        number: 3403,
        title: 'Main pipeline red: Main: Container smoke',
        body: legacyBody('Main: Container smoke'),
        state: 'closed',
        state_reason: 'completed',
        labels: ['bug', 'P1'],
        comments: [],
      },
      {
        number: 4037,
        title: 'Main pipeline red: Main: Container smoke',
        body: legacyBody('Main: Container smoke'),
        state: 'closed',
        state_reason: 'duplicate',
        labels: ['bug', 'P1'],
        comments: [],
      },
    );
    fake.setRun({
      jobs: [job(81, 'smoke', 'failure', [['Build', 'failure']])],
      annotations: {},
    });
    await runMainHealth(
      fake,
      workflowRunEvent('Main: Container smoke', 'failure'),
      {
        only: REPORT,
      },
    );
    const byNumber = (number: number) =>
      fake.issues.find((issue) => issue.number === number);
    expect(byNumber(3403)?.state).toBe('open');
    expect(byNumber(4037)?.state).toBe('closed');
  });

  it('neither reuses nor closes a bot issue a person renamed to a tracker title', async () => {
    const fake = fakeGithub();
    fake.issues.push(
      {
        number: 3403,
        title: 'Main pipeline red: Main: Container smoke',
        body: legacyBody('Main: Container smoke'),
        state: 'open',
        labels: ['bug', 'P1'],
        comments: [],
      },
      {
        number: 4963,
        title: 'Main pipeline red: Main: Container smoke',
        body: 'Backlog policy findings\n\n- 21 actionable P1',
        state: 'open',
        labels: [],
        comments: [],
      },
    );
    fake.setRun({
      jobs: [job(82, 'smoke', 'failure', [['Build', 'failure']])],
      annotations: {},
    });
    await runMainHealth(
      fake,
      workflowRunEvent('Main: Container smoke', 'failure'),
      {
        only: REPORT,
      },
    );
    const byNumber = (number: number) =>
      fake.issues.find((issue) => issue.number === number);
    expect(byNumber(4963)?.state).toBe('open');
    expect(byNumber(4963)?.comments).toEqual([]);
    expect(byNumber(4963)?.body).toContain('Backlog policy findings');
    expect(byNumber(3403)?.body).toContain('- smoke > Build (failure)');
  });

  it('leaves a renamed tracker alone and opens a fresh one', async () => {
    const fake = fakeGithub();
    fake.issues.push({
      number: 77,
      title: 'Dated TODO sweep is red (renamed by a person)',
      body: 'old',
      state: 'open',
      labels: ['bug', 'P1'],
      comments: [],
    });
    fake.setRun(RED_SWEEP);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      {
        only: REPORT,
      },
    );
    expect(fake.issues.map((issue) => [issue.number, issue.state])).toEqual([
      [77, 'open'],
      [101, 'open'],
    ]);
  });

  it('opens and updates trackers unlabelled while ci:red does not exist yet', async () => {
    const fake = fakeGithub({ labelExists: false });
    fake.setRun(RED_SWEEP);
    const { core } = await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      { only: REPORT },
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].labels).toEqual(['bug', 'P1']);
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining('label ci:red does not exist yet'),
    );
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      {
        only: REPORT,
      },
    );
    expect(fake.issues).toHaveLength(1);
  });

  it('opens the tracker with the base labels when the label API fails, and says so', async () => {
    const fake = fakeGithub({ labelError: true });
    fake.setRun(RED_SWEEP);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      {
        only: REPORT,
      },
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].labels).toEqual(['bug', 'P1']);
    expect(fake.issues[0].body).toContain('Label ci:red could not be checked');
  });

  it.each([
    ['a person', REAL_CANCELS.person.message],
    [
      'a newer iOS run in its concurrency group',
      REAL_CANCELS.superseded.message,
    ],
    [
      'a newer smoke in its concurrency group',
      REAL_CANCELS.supersededSmoke.message,
    ],
  ])('writes nothing when %s cancelled the run', async (_who, message) => {
    const fake = fakeGithub();
    fake.setRun({
      jobs: [
        job(21, 'Exact full-diff classification', 'success'),
        job(22, 'smoke', 'cancelled'),
      ],
      annotations: {
        22: [annotation(message), annotation('The operation was canceled.')],
      },
    });
    const { started } = await runMainHealth(
      fake,
      workflowRunEvent('Main: Container smoke', 'cancelled'),
      { only: REPORT },
    );
    expect(started).toEqual(['report-failure']);
    expect(fake.writes).toEqual([]);
    expect(fake.issues).toEqual([]);
  });

  it.each([
    [
      'Nightly verifier never acquired a runner',
      REAL_CANCELS.notAcquiredNightly.message,
    ],
    ['iOS build never acquired a runner', REAL_CANCELS.notAcquiredIos.message],
    ['the fleet runner was lost', REAL_CANCELS.runnerLost.message],
  ])('reports a run GitHub cancelled: %s', async (_case, message) => {
    const fake = fakeGithub();
    fake.setRun({
      jobs: [job(31, 'smoke', 'cancelled')],
      annotations: {
        31: [
          annotation(message),
          annotation(
            'Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times.',
            'notice',
          ),
        ],
      },
    });
    await runMainHealth(
      fake,
      workflowRunEvent('Main: Container smoke', 'cancelled'),
      {
        only: REPORT,
      },
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].title).toBe(
      'Main pipeline red: Main: Container smoke',
    );
    expect(fake.issues[0].body).toContain('GitHub cancelled it');
    expect(fake.issues[0].body).toContain('- smoke (cancelled)');
  });

  it('reports a cancel whose cause it does not recognise, and says so', async () => {
    // An API cancel by automation leaves no annotation at all (Main:
    // Qualification run 43982701666, job 133702919995).
    const fake = fakeGithub();
    fake.setRun({ jobs: [job(41, 'report', 'cancelled')], annotations: {} });
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Starved PR report', 'cancelled'),
      {
        only: REPORT,
      },
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].body).toContain('the cause was not recognised');
  });

  // Real pair: Main: Qualification health run 43099494704 (cancelled, zero
  // jobs, no annotation) and 43099513706, created 7 s later on main.
  const SUPERSEDED_PENDING = {
    id: 43099494704,
    workflow_id: 375855583,
    head_branch: 'main',
    created_at: '2026-11-11T21:01:24Z',
  };
  const NEWER = {
    id: 43099513706,
    workflow_id: 375855583,
    head_branch: 'main',
    created_at: '2026-11-11T21:01:31Z',
  };

  it('writes nothing for a pending run a newer run replaced in its workflow-level group', async () => {
    const fake = fakeGithub();
    fake.otherRuns.push(NEWER, SUPERSEDED_PENDING);
    fake.setRun({ jobs: [], annotations: {} });
    await runMainHealth(
      fake,
      workflowRunEvent('Main: Qualification health', 'cancelled', {
        ...SUPERSEDED_PENDING,
        event: 'workflow_run',
      }),
      { only: REPORT },
    );
    expect(fake.writes).toEqual([]);
  });

  it('reports a cancel with jobs and no recognised annotation even when a newer run exists', async () => {
    // Only a run that never got a job was replaced while pending; a run whose
    // jobs started and were cancelled without a recognised cause is reported.
    const fake = fakeGithub();
    fake.otherRuns.push(NEWER, SUPERSEDED_PENDING);
    fake.setRun({ jobs: [job(91, 'health', 'cancelled')], annotations: {} });
    await runMainHealth(
      fake,
      workflowRunEvent('Main: Qualification health', 'cancelled', {
        ...SUPERSEDED_PENDING,
        event: 'workflow_run',
      }),
      { only: REPORT },
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].body).toContain('the cause was not recognised');
  });

  it('reports a job-less unannotated cancel with no newer run', async () => {
    const fake = fakeGithub();
    fake.otherRuns.push(SUPERSEDED_PENDING);
    fake.setRun({ jobs: [], annotations: {} });
    await runMainHealth(
      fake,
      workflowRunEvent('Main: Qualification health', 'cancelled', {
        ...SUPERSEDED_PENDING,
        event: 'workflow_run',
      }),
      { only: REPORT },
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].body).toContain('the cause was not recognised');
  });

  it('renders hostile job names and annotation text as inert literal blocks', () => {
    const hostile = [
      '```',
      '# Heading from a log',
      'ping @briananderson1222 and @kontourai/maintainers',
      '[click](https://example.invalid/phish) ![img](https://example.invalid/x.png)',
      '````js',
      '<!-- main-health-state: {"lead":"x"} -->',
    ].join('\n');
    const body = renderTrackerBody({
      workflowName: 'Repo: Dated TODO sweep',
      runUrl: 'https://github.com/kontourai/station/actions/runs/1',
      headSha: 'c'.repeat(40),
      event: 'schedule',
      conclusion: 'failure',
      failures: summarizeRunFailure([
        job(
          61,
          '```\n# @briananderson1222 [x](https://example.invalid)',
          'failure',
          [['```evil @here```', 'failure']],
        ),
      ]),
      lines: failingLines([{ ...annotation(hostile), job: 'sweep' }]),
    });
    const lines = body.split('\n');
    const fences = lines.flatMap((line, index) =>
      /^```/.test(line) ? [index] : [],
    );
    // Exactly two blocks (Failing, First failing lines), each opened and
    // closed by this renderer, and no other run of three backticks anywhere.
    expect(fences).toHaveLength(4);
    expect(body.match(/```/g)).toHaveLength(4);
    const inside = (index: number) =>
      (index > fences[0] && index < fences[1]) ||
      (index > fences[2] && index < fences[3]);
    lines.forEach((line, index) => {
      if (inside(index) || fences.includes(index) || line === TRACKER_MARKER)
        return;
      expect(line, `line ${index} renders live markup`).not.toMatch(
        /@\w|\]\(|^#|<!--/,
      );
    });
    expect(body).toContain('sweep: ping @briananderson1222');
  });

  it('classifies every real cancellation text it was built from', () => {
    for (const { message, cause } of Object.values(REAL_CANCELS))
      expect(classifyCancellation([annotation(message)]), message).toBe(cause);
    expect(
      classifyCancellation([annotation('The operation was canceled.')]),
    ).toBe('unknown');
  });

  it('still opens the tracker when the run details cannot be read, then fails visibly', async () => {
    const fake = fakeGithub();
    fake.setRun({ jobs: [], annotations: {}, failJobs: true });
    await expect(
      runMainHealth(fake, workflowRunEvent('Repo: Backlog policy', 'failure'), {
        only: REPORT,
      }),
    ).rejects.toThrow(/Tracker written without run details: HTTP 502/);
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].body).toContain(
      'Run details unavailable (open the run above):\n```text\nHTTP 502 from listJobsForWorkflowRun\n```',
    );
  });

  it('reports an unreadable cancel rather than guessing it was a person', async () => {
    const fake = fakeGithub();
    fake.setRun({ jobs: [], annotations: {}, failJobs: true });
    await expect(
      runMainHealth(
        fake,
        workflowRunEvent('Main: Container smoke', 'cancelled'),
        {
          only: REPORT,
        },
      ),
    ).rejects.toThrow(/HTTP 502/);
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].body).toContain('the cause was not recognised');
  });
});

describe('scheduled workflows that stop running', () => {
  it('reads each watched schedule from the workflow file itself', () => {
    const watched = new Set(mainHealth().on?.workflow_run?.workflows);
    // The text reader agrees with the YAML parser on the watched list and on
    // every scheduled workflow's name and crons.
    expect(
      watchedWorkflowNames(readFileSync(new URL(MAIN_HEALTH, root), 'utf8')),
    ).toEqual([...watched]);
    for (const { file, document } of scheduled()) {
      const parsed = document as WorkflowDocument;
      const text = readFileSync(new URL(file, root), 'utf8');
      expect(workflowSchedule(text), file).toEqual({
        name: parsed.name,
        crons: (parsed.on?.schedule ?? []).map((entry) => entry.cron),
      });
    }
    const schedules = readWatchedSchedules(root.href);
    expect(schedules.map(({ name }) => name).sort()).toEqual(
      scheduled()
        .map(({ document }) => String((document as WorkflowDocument).name))
        .filter((name) => watched.has(name))
        .sort(),
    );
  });

  it('watches the duplicate sweep, whose six-hourly cron gets the 20 h tolerance', () => {
    const sweep = readWatchedSchedules(root.href).find(
      ({ name }) => name === 'Repo: Duplicate sweep',
    );
    expect(sweep?.file).toBe('pr-duplicate-sweep.yml');
    expect(sweep?.crons).toEqual(['27 */6 * * *']);
    expect(overdueLimitMs(cronIntervalMs(sweep?.crons ?? []))).toBe(20 * HOUR);
    expect(Object.keys(REPORTED_ELSEWHERE)).not.toContain(
      '.github/workflows/pr-duplicate-sweep.yml',
    );
  });

  it('derives the interval from cron and tolerates the measured sparsity', () => {
    expect(cronIntervalMs(['47 * * * *'])).toBe(HOUR);
    expect(cronIntervalMs(['23 2,8,14,20 * * *'])).toBe(6 * HOUR);
    expect(cronIntervalMs(['7 */6 * * *'])).toBe(6 * HOUR);
    expect(cronIntervalMs(['30 7 * * *'])).toBe(24 * HOUR);
    expect(cronIntervalMs(['41 4 * * 1'])).toBe(168 * HOUR);
    expect(OVERDUE_FLOOR_MS).toBe(20 * HOUR);
    // Largest gaps measured 2026-10-17..11-16 stay inside the tolerance.
    expect(overdueLimitMs(HOUR)).toBeGreaterThan(10.8 * HOUR);
    expect(overdueLimitMs(6 * HOUR)).toBeGreaterThan(15.8 * HOUR);
    expect(overdueLimitMs(24 * HOUR)).toBeGreaterThan(28.6 * HOUR);
    expect(overdueLimitMs(168 * HOUR)).toBeGreaterThan(170.3 * HOUR);
  });

  it('says when the schedule last ran and what the tolerance is', () => {
    const body = renderOverdueBody({
      workflowName: 'Repo: Starved PR report',
      file: 'starved-pr-report.yml',
      crons: ['17 * * * *'],
      intervalMs: HOUR,
      limitMs: overdueLimitMs(HOUR),
      lastRunAt: '2026-11-15T10:17:00Z',
      lastRunUrl: 'https://github.com/kontourai/station/actions/runs/2',
    });
    expect(isOverdueBody(body)).toBe(true);
    expect(body).toContain(
      'Repo: Starved PR report has not run on its schedule since 2026-11-15T10:17:00Z.',
    );
    expect(body).toContain('Overdue after: 20 h without a scheduled run');
  });

  it('decides on time, late within tolerance, overdue, never ran, and a changed cron', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const at = (hoursAgo: number) =>
      new Date(now - hoursAgo * HOUR).toISOString();
    const hourly = cronIntervalMs(['17 * * * *']);
    const daily = cronIntervalMs(['0 10 * * *']);
    expect(
      decideOverdue({ intervalMs: hourly, lastRunAt: at(1), now }).overdue,
    ).toBe(false);
    expect(
      decideOverdue({ intervalMs: hourly, lastRunAt: at(10.8), now }).overdue,
    ).toBe(false);
    expect(
      decideOverdue({ intervalMs: hourly, lastRunAt: at(21), now }).overdue,
    ).toBe(true);
    expect(
      decideOverdue({ intervalMs: daily, lastRunAt: at(30), now }).overdue,
    ).toBe(false);
    expect(
      decideOverdue({ intervalMs: daily, lastRunAt: at(49), now }).overdue,
    ).toBe(true);
    // Never ran: measured from when the schedule took effect.
    expect(
      decideOverdue({
        intervalMs: daily,
        lastRunAt: null,
        scheduleChangedAt: at(5),
        now,
      }),
    ).toMatchObject({ overdue: false, neverRan: true });
    expect(
      decideOverdue({
        intervalMs: daily,
        lastRunAt: null,
        scheduleChangedAt: at(72),
        now,
      }),
    ).toMatchObject({ overdue: true, neverRan: true });
    expect(
      decideOverdue({ intervalMs: daily, lastRunAt: null, now }).overdue,
    ).toBe(true);
    // A weekly cron changed to hourly: 30 h without a run is now overdue.
    const weekly = cronIntervalMs(['41 4 * * 1']);
    expect(
      decideOverdue({ intervalMs: weekly, lastRunAt: at(30), now }).overdue,
    ).toBe(false);
    expect(
      decideOverdue({
        intervalMs: cronIntervalMs(['41 * * * *']),
        lastRunAt: at(30),
        now,
      }).overdue,
    ).toBe(true);
    // ...but not while the change itself is younger than the new tolerance.
    expect(
      decideOverdue({
        intervalMs: cronIntervalMs(['41 * * * *']),
        lastRunAt: at(30),
        scheduleChangedAt: at(2),
        now,
      }).overdue,
    ).toBe(false);
  });

  it('gives a cron that just landed one full tolerance, and ignores edits that leave the cron alone', async () => {
    // The duplicate sweep's file predates its cron change but its cron lands now:
    // the first Main: Health run after landing must not call it never-run.
    const now = Date.parse('2026-11-16T12:00:00Z');
    const current = readFileSync(
      new URL('.github/workflows/pr-duplicate-sweep.yml', root),
      'utf8',
    );
    const withoutCron = current.replace(
      /^ {2}schedule:\n {4}- cron: .*\n/m,
      '',
    );
    expect(withoutCron).not.toEqual(current);
    const hoursAgo = (hours: number) =>
      new Date(now - hours * HOUR).toISOString();
    const cases = [
      {
        name: 'cron added an hour ago',
        history: [
          { sha: 'c2', date: hoursAgo(1), text: current },
          { sha: 'c1', date: hoursAgo(2000), text: withoutCron },
        ],
        expected: [],
      },
      {
        name: 'cron added 21 hours ago',
        history: [
          { sha: 'c2', date: hoursAgo(21), text: current },
          { sha: 'c1', date: hoursAgo(2000), text: withoutCron },
        ],
        expected: ['Main pipeline red: Repo: Duplicate sweep'],
      },
      {
        // A comment edit an hour ago must not postpone a 21-hour-old cron.
        name: 'unrelated edit after the cron',
        history: [
          { sha: 'c3', date: hoursAgo(1), text: `${current}\n# a comment\n` },
          { sha: 'c2', date: hoursAgo(21), text: current },
          { sha: 'c1', date: hoursAgo(2000), text: withoutCron },
        ],
        expected: ['Main pipeline red: Repo: Duplicate sweep'],
      },
    ];
    for (const { name, history, expected } of cases) {
      const fake = fakeGithub();
      for (const { file } of readWatchedSchedules(root.href))
        fake.scheduledRuns[file] = {
          created_at: new Date(now - HOUR).toISOString(),
          html_url: 'https://github.com/kontourai/station/actions/runs/5',
          status: 'completed',
          conclusion: 'success',
        };
      fake.scheduledRuns['pr-duplicate-sweep.yml'] = null;
      fake.fileHistory['pr-duplicate-sweep.yml'] = history;
      await runMainHealth(fake, workflowRunEvent('Nightly', 'success'), {
        only: ['overdue-schedules'],
        now,
      });
      expect(
        fake.issues.map((issue) => issue.title),
        name,
      ).toEqual(expected);
    }
  });

  it('dates a schedule from the oldest commit that still has the current cron lines', () => {
    expect(
      scheduleEffectiveSince(
        ['0 1 * * *'],
        [
          { date: '2026-11-16T00:00:00Z', crons: ['0 1 * * *'] },
          { date: '2026-11-10T00:00:00Z', crons: ['0 1 * * *'] },
          { date: '2026-11-01T00:00:00Z', crons: ['0 2 * * *'] },
          { date: '2026-10-01T00:00:00Z', crons: ['0 1 * * *'] },
        ],
      ),
    ).toBe('2026-11-10T00:00:00Z');
    expect(scheduleEffectiveSince(['0 1 * * *'], [])).toBeNull();
  });

  it('checks every schedule even when one check fails, then fails once naming it', async () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const fake = fakeGithub();
    for (const { file } of readWatchedSchedules(root.href))
      fake.scheduledRuns[file] = {
        created_at: new Date(now - HOUR).toISOString(),
        html_url: 'https://github.com/kontourai/station/actions/runs/8',
        status: 'completed',
        conclusion: 'success',
      };
    // The first file in the loop fails; a later one is overdue.
    fake.failingRuns.add('backlog-priority-policy.yml');
    fake.scheduledRuns['starved-pr-report.yml'] = {
      created_at: '2026-11-15T10:17:00Z',
      html_url: 'https://github.com/kontourai/station/actions/runs/9',
      status: 'completed',
      conclusion: 'success',
    };
    await expect(
      runMainHealth(fake, workflowRunEvent('Nightly', 'success'), {
        only: ['overdue-schedules'],
        now,
      }),
    ).rejects.toThrow(
      /Could not check 1 schedule\(s\): Repo: Backlog policy \(backlog-priority-policy\.yml\): Server Error/,
    );
    expect(fake.issues.map((issue) => issue.title)).toEqual([
      'Main pipeline red: Repo: Starved PR report',
    ]);
  });

  it('reports its own red through one tracker of its own', async () => {
    const document = mainHealth();
    const own = document.jobs['report-own-failure'] as Job & {
      needs?: string[];
    };
    expect(own.if).toBe('${{ failure() }}');
    expect(own.needs).toEqual([
      'report-failure',
      'close-after-success',
      'overdue-schedules',
    ]);
    expect(
      own.steps.some((step) => step.uses?.startsWith('actions/checkout@')),
    ).toBe(false);
    const fake = fakeGithub();
    const script = String(own.steps[0].with?.script);
    const run = vm.compileFunction(
      `return async function (github, context) {\n${script}\n};`,
      [],
    )();
    const context = {
      repo: { owner: 'kontourai', repo: 'station' },
      serverUrl: 'https://github.com',
      runId: 42,
      payload: {
        workflow_run: {
          html_url: 'https://github.com/kontourai/station/actions/runs/41',
        },
      },
    };
    await run(fake.github, context);
    await run(fake.github, { ...context, runId: 43 });
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].title).toBe('Main: Health could not run');
    expect(fake.issues[0].body).toContain('actions/runs/43');
  });

  it("keeps a flapping workflow's tracker open until a green has held for a day, and reopens quietly", async () => {
    const t0 = Date.parse('2026-11-16T00:00:00Z');
    const at = (hours: number) => new Date(t0 + hours * HOUR).toISOString();
    const fake = fakeGithub();
    const event = (conclusion: string, hours: number, id: number) =>
      workflowRunEvent('Repo: Dated TODO sweep', conclusion, {
        id,
        workflow_id: 55,
        created_at: at(hours),
        updated_at: at(hours),
      });
    const record = (id: number, conclusion: string, hours: number) =>
      fake.otherRuns.push({
        id,
        workflow_id: 55,
        head_branch: 'main',
        conclusion,
        created_at: at(hours),
        updated_at: at(hours),
      } as never);
    // Red, then green an hour later: still the same red episode.
    record(1, 'failure', 0);
    fake.setRun(RED_SWEEP);
    await runMainHealth(fake, event('failure', 0, 1), { only: REPORT });
    record(2, 'success', 1);
    fake.setRun(GREEN_SWEEP);
    await runMainHealth(fake, event('success', 1, 2), { only: REPORT });
    expect(fake.issues[0].state).toBe('open');
    // Green 25 h after the last red: it held, so the tracker closes.
    record(3, 'success', 25);
    fake.clock.now = () => t0 + 25 * HOUR;
    await runMainHealth(fake, event('success', 25, 3), { only: REPORT });
    expect(fake.issues[0].state).toBe('closed');
    const comments = fake.issues[0].comments.length;
    // Red again two hours after the close: reopened without an announcement.
    record(4, 'failure', 27);
    fake.setRun(RED_SWEEP);
    const realNow = Date.now;
    Date.now = () => t0 + 27 * HOUR;
    try {
      await runMainHealth(fake, event('failure', 27, 4), { only: REPORT });
    } finally {
      Date.now = realNow;
    }
    expect(fake.issues[0].state).toBe('open');
    expect(fake.issues[0].comments).toHaveLength(comments);
    expect(
      fake.issues[0].comments
        .slice(comments)
        .some((comment) =>
          comment.body.startsWith('The workflow failed again on main.'),
        ),
    ).toBe(false);
  });

  it("clears a stopped schedule's tracker only with a successful scheduled run", async () => {
    // Main: Qualification health's cron stopped 30 h ago, but its
    // workflow_run-triggered runs keep going green; a push or a dispatch of
    // a push-triggered workflow is the same case.
    const now = Date.parse('2026-11-16T12:00:00Z');
    const fake = fakeGithub();
    for (const { file } of readWatchedSchedules(root.href))
      fake.scheduledRuns[file] = {
        created_at: new Date(now - HOUR).toISOString(),
        html_url: 'https://github.com/kontourai/station/actions/runs/6',
        status: 'completed',
        conclusion: 'success',
      };
    fake.scheduledRuns['qualification-health.yml'] = {
      created_at: new Date(now - 30 * HOUR).toISOString(),
      html_url: 'https://github.com/kontourai/station/actions/runs/7',
      status: 'completed',
      conclusion: 'success',
    };
    await runMainHealth(fake, workflowRunEvent('Nightly', 'success'), {
      only: ['overdue-schedules'],
      now,
    });
    const tracker = fake.issues.find((issue) =>
      issue.title.endsWith('Main: Qualification health'),
    );
    expect(isOverdueBody(tracker?.body)).toBe(true);
    fake.setRun({ jobs: [job(71, 'health', 'success')], annotations: {} });
    for (const event of [
      'workflow_run',
      'workflow_run',
      'workflow_dispatch',
      'push',
    ])
      await runMainHealth(
        fake,
        workflowRunEvent('Main: Qualification health', 'success', { event }),
        { only: REPORT },
      );
    expect(tracker?.state).toBe('open');
    expect(tracker?.comments).toEqual([]);
    await runMainHealth(
      fake,
      workflowRunEvent('Main: Qualification health', 'success', {
        event: 'schedule',
      }),
      { only: REPORT },
    );
    expect(tracker?.state).toBe('closed');
    expect(tracker?.comments).toHaveLength(1);
  });

  it('opens one tracker for an overdue schedule, stays quiet while it stays overdue, and clears on the next run', async () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const fake = fakeGithub();
    const recent = {
      created_at: new Date(now - 2 * HOUR).toISOString(),
      html_url: 'https://github.com/kontourai/station/actions/runs/1',
      status: 'completed',
      conclusion: 'success',
    };
    for (const { file } of readWatchedSchedules(root.href))
      fake.scheduledRuns[file] = recent;
    fake.scheduledRuns['starved-pr-report.yml'] = {
      created_at: '2026-11-15T10:17:00Z',
      html_url: 'https://github.com/kontourai/station/actions/runs/2',
    };
    fake.scheduledRuns['dated-todo-sweep.yml'] = null;
    const trigger = workflowRunEvent('Nightly', 'success');

    const { started } = await runMainHealth(fake, trigger, {
      only: ['overdue-schedules'],
      now,
    });
    expect(started).toEqual(['overdue-schedules']);
    expect(fake.issues.map((issue) => issue.title).sort()).toEqual([
      'Main pipeline red: Repo: Dated TODO sweep',
      'Main pipeline red: Repo: Starved PR report',
    ]);
    const starved = fake.issues.find((issue) =>
      issue.title.endsWith('Starved PR report'),
    );
    expect(isOverdueBody(starved?.body)).toBe(true);
    expect(starved?.body).toContain(
      'has not run on its schedule since 2026-11-15T10:17:00Z',
    );
    const dated = fake.issues.find((issue) =>
      issue.title.endsWith('Dated TODO sweep'),
    );
    expect(dated?.body).toContain('has never run on its schedule');

    const writes = fake.writes.length;
    await runMainHealth(fake, trigger, {
      only: ['overdue-schedules'],
      now: now + HOUR,
    });
    expect(fake.writes.length).toBe(writes);

    fake.scheduledRuns['starved-pr-report.yml'] = recent;
    await runMainHealth(fake, trigger, { only: ['overdue-schedules'], now });
    expect(starved?.state).toBe('closed');
    expect(starved?.comments.at(-1)?.body).toContain(
      'Ran on its schedule again',
    );
    expect(dated?.state).toBe('open');
  });

  it("leaves a resumed schedule's red run to the failure reporter instead of closing its tracker", async () => {
    // The stopped schedule resumes with a failing run. The overdue job and
    // the reporter run in different concurrency groups; whichever order they
    // interleave in, the tracker must end open with the failure.
    const now = Date.parse('2026-11-16T12:00:00Z');
    for (const order of [
      'overdue-first',
      'reporter-first',
      'interleaved',
    ] as const) {
      const fake = fakeGithub();
      const ok = {
        created_at: new Date(now - HOUR).toISOString(),
        html_url: 'https://github.com/kontourai/station/actions/runs/3',
        status: 'completed',
        conclusion: 'success',
      };
      for (const { file } of readWatchedSchedules(root.href))
        fake.scheduledRuns[file] = ok;
      fake.scheduledRuns['dated-todo-sweep.yml'] = null;
      await runMainHealth(fake, workflowRunEvent('Nightly', 'success'), {
        only: ['overdue-schedules'],
        now,
      });
      const tracker = fake.issues.find((issue) =>
        issue.title.endsWith('Dated TODO sweep'),
      );
      expect(isOverdueBody(tracker?.body)).toBe(true);
      // It resumes, red.
      fake.scheduledRuns['dated-todo-sweep.yml'] = {
        created_at: new Date(now - 0.5 * HOUR).toISOString(),
        html_url: 'https://github.com/kontourai/station/actions/runs/4',
        status: 'completed',
        conclusion: 'failure',
      };
      fake.setRun(RED_SWEEP);
      const overdue = () =>
        runMainHealth(fake, workflowRunEvent('Nightly', 'success'), {
          only: ['overdue-schedules'],
          now,
        });
      const reporter = () =>
        runMainHealth(
          fake,
          workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
          {
            only: REPORT,
          },
        );
      if (order === 'overdue-first') {
        await overdue();
        await reporter();
      } else if (order === 'interleaved') {
        // The reporter has read the tracker as open; the overdue job then
        // runs to completion before the reporter's first write.
        fake.interleave.beforeUpdate = overdue;
        await reporter();
      } else {
        await reporter();
        await overdue();
      }
      expect(tracker?.state, order).toBe('open');
      expect(tracker?.body, order).toContain(
        '- sweep > Scan dated TODOs (failure)',
      );
    }
  });

  it('never clears a tracker it did not open', async () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const fake = fakeGithub();
    for (const { file } of readWatchedSchedules(root.href))
      fake.scheduledRuns[file] = {
        created_at: new Date(now - HOUR).toISOString(),
        html_url: 'https://github.com/kontourai/station/actions/runs/3',
      };
    fake.setRun(RED_SWEEP);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
      {
        only: REPORT,
      },
    );
    await runMainHealth(fake, workflowRunEvent('Nightly', 'success'), {
      only: ['overdue-schedules'],
      now,
    });
    expect(fake.issues[0].state).toBe('open');
  });
});
