import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { readWorkflowDocuments } from '../actionlint-gate.mjs';

/**
 * Owner decision: a scheduled workflow's failure must reach a person as an
 * issue, not only as a red run on the Actions tab. `main-health.yml` is the
 * one reporter (one tracker per workflow, updated in place, closed by the
 * next green). These tests hold every scheduled workflow to it and execute
 * its job conditions and scripts verbatim against a stateful fake GitHub.
 */

const root = new URL('../..', import.meta.url);
const MAIN_HEALTH = '.github/workflows/main-health.yml';

/**
 * Scheduled workflows that report through something other than main-health,
 * each with the reason. A new scheduled workflow fails this suite until it is
 * watched by main-health or added here with a justification.
 */
const REPORTED_ELSEWHERE: Record<string, string> = {
  '.github/workflows/pr-duplicate-sweep.yml':
    'audit verdict remove: scheduled runs never pass --apply, so their only output is a log line nobody reads (latest sampled run: "no superseded candidates"); reporting its failures would page for a job with no consumer',
  '.github/workflows/main-qualification.yml':
    'qualification-repair.yml opens the "Main qualification repair" episode issue for a red run and qualification-health.yml files "Main qualification health" for staleness; both belong to the qualification cadence owner',
};

/**
 * The scheduled set, pinned literally rather than derived, so adding or
 * removing a schedule is a visible edit here as well as in the workflow.
 */
const SCHEDULED_WORKFLOWS = [
  '.github/workflows/backlog-priority-policy.yml',
  '.github/workflows/ci-throughput-health.yml',
  '.github/workflows/dated-todo-sweep.yml',
  '.github/workflows/dependency-advisory.yml',
  '.github/workflows/docs-freshness-sweep.yml',
  '.github/workflows/fresh-home-walkthrough.yml',
  '.github/workflows/ios-rust-cache-warm.yml',
  '.github/workflows/main-qualification.yml',
  '.github/workflows/nightly-gallery.yml',
  '.github/workflows/nightly.yml',
  '.github/workflows/pr-duplicate-sweep.yml',
  '.github/workflows/qualification-health.yml',
  '.github/workflows/security-analysis.yml',
  '.github/workflows/starved-pr-report.yml',
];

type Step = {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  if?: string;
  permissions?: unknown;
  steps: Step[];
};
type WorkflowDocument = {
  name?: string;
  on?: Record<string, unknown> & {
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
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
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
 * A stateful stand-in for the Octokit surface main-health calls. Issues and
 * comments persist across calls, so "the second failure updates the first
 * issue" is observed, not asserted on a mock's arguments.
 */
function fakeGithub() {
  const issues: Issue[] = [];
  let nextComment = 1;
  let run: {
    jobs: ReturnType<typeof job>[];
    annotations: Record<number, ReturnType<typeof annotation>[]>;
    failJobs?: boolean;
  } = { jobs: [], annotations: {} };
  const writes: string[] = [];
  const find = (number: number) => {
    const issue = issues.find((candidate) => candidate.number === number);
    if (!issue) throw new Error(`no issue ${number}`);
    return issue;
  };
  const listForRepo = async ({ state }: { state: string }) => ({
    data: issues
      .filter((issue) => state === 'all' || issue.state === state)
      .map(({ comments: _comments, ...issue }) => ({ ...issue })),
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
      actions: { listJobsForWorkflowRun: listJobs },
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
        listForRepo,
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
          body,
        }: {
          issue_number: number;
          state?: 'open' | 'closed';
          body?: string;
        }) => {
          writes.push(`update:${state ?? 'body'}`);
          const issue = find(issue_number);
          if (state) issue.state = state;
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
 * for each job that would start, executes its github-script step verbatim with
 * env resolved from the step's own declarations.
 */
async function runMainHealth(
  fake: ReturnType<typeof fakeGithub>,
  github: ReturnType<typeof workflowRunEvent>,
) {
  const document = mainHealth();
  const started: string[] = [];
  const core = { info: vi.fn(), warning: vi.fn() };
  for (const [jobName, definition] of Object.entries(document.jobs)) {
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

describe('scheduled workflow failure reporting', () => {
  it('watches every scheduled workflow from main-health or names who reports it instead', () => {
    const scheduledFiles = scheduled()
      .map(({ file }) => file)
      .sort();
    expect(scheduledFiles).toEqual(SCHEDULED_WORKFLOWS);

    const watched = new Set(mainHealth().on?.workflow_run?.workflows);
    const unreported = scheduled()
      .filter(({ file }) => !(file in REPORTED_ELSEWHERE))
      .filter(
        ({ document }) =>
          !watched.has(String((document as WorkflowDocument).name)),
      )
      .map(({ file }) => file);
    expect(unreported).toEqual([]);

    // An allowlist entry for a workflow main-health also watches, or that is
    // no longer scheduled, is a stale reason nobody rechecks.
    for (const file of Object.keys(REPORTED_ELSEWHERE)) {
      const entry = scheduled().find((candidate) => candidate.file === file);
      expect(entry, `${file} is no longer scheduled`).toBeDefined();
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
    // Only canonical main runs: not a branch, not a fork calling its branch main.
    expect(reports('failure', { head_branch: 'feature' })).toBe(false);
    expect(
      reports('failure', { head_repository: { full_name: 'fork/station' } }),
    ).toBe(false);
  });

  it('grants issue writes only to the reporter, which runs no code from the reported run', () => {
    const document = mainHealth();
    // workflow_run is the only trigger: main-health never runs for a PR.
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
    // The watched workflows hold no issue scope of their own for reporting:
    // the newly watched ones are pinned to the permissions they had.
    const own = (file: string) =>
      (
        documents().find((candidate) => candidate.file === file)?.document as
          | WorkflowDocument
          | undefined
      )?.permissions;
    expect(own('.github/workflows/starved-pr-report.yml')).toEqual({
      contents: 'read',
      'pull-requests': 'write',
    });
    expect(own('.github/workflows/ios-rust-cache-warm.yml')).not.toHaveProperty(
      'issues',
    );
    expect(own('.github/workflows/container-smoke.yml')).toEqual({
      contents: 'read',
    });
  });

  it('opens one tracker on the first red run, updates it on the second, and closes it on green', async () => {
    const fake = fakeGithub();
    fake.setRun(RED_SWEEP);
    const first = workflowRunEvent('Repo: Dated TODO sweep', 'failure');
    await runMainHealth(fake, first);

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
    // Warnings are not failing lines.
    expect(tracker.body).not.toContain('Node.js 20 is deprecated');

    const second = workflowRunEvent('Repo: Dated TODO sweep', 'failure', {
      head_sha: 'd'.repeat(40),
    });
    await runMainHealth(fake, second);
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].body).toContain(
      `Run: ${second.event.workflow_run.html_url}`,
    );
    // The second red establishes the comment marker; a third, unchanged red
    // inside the heartbeat window edits it rather than notifying again.
    expect(fake.issues[0].comments).toHaveLength(1);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].comments).toHaveLength(1);
    expect(fake.writes.filter((write) => write === 'create')).toHaveLength(1);

    fake.setRun(GREEN_SWEEP);
    const { started } = await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'success'),
    );
    expect(started).toEqual(['close-after-success']);
    expect(fake.issues[0].state).toBe('closed');
    expect(fake.issues[0].comments.at(-1)?.body).toContain(
      'Closed after a successful run on main.',
    );

    // Red again after green reopens the same tracker; it never forks a second.
    fake.setRun(RED_SWEEP);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
    );
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].state).toBe('open');
  });

  it('keeps one tracker per workflow', async () => {
    const fake = fakeGithub();
    fake.setRun(RED_SWEEP);
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Dated TODO sweep', 'failure'),
    );
    await runMainHealth(
      fake,
      workflowRunEvent('Repo: Starved PR report', 'failure'),
    );
    expect(fake.issues.map((issue) => issue.title)).toEqual([
      'Main pipeline red: Repo: Dated TODO sweep',
      'Main pipeline red: Repo: Starved PR report',
    ]);
  });

  it.each([
    // Verbatim from Nightly run 39698506810.
    ['a person', 'The run was canceled by @briananderson1222.', 'person'],
    [
      'a newer run in its concurrency group',
      'Canceling since a higher priority waiting request for container-smoke-refs/heads/main exists',
      'superseded',
    ],
  ])('writes nothing when %s cancelled the run', async (_who, message) => {
    const fake = fakeGithub();
    fake.setRun({
      jobs: [
        job(21, 'Exact full-diff classification', 'success'),
        job(22, 'smoke', 'cancelled'),
      ],
      annotations: { 22: [annotation(message)] },
    });
    const { started } = await runMainHealth(
      fake,
      workflowRunEvent('Main: Container smoke', 'cancelled', { event: 'push' }),
    );
    // The reporter starts (only annotations can say who cancelled) and then
    // leaves every issue untouched.
    expect(started).toEqual(['report-failure']);
    expect(fake.writes).toEqual([]);
    expect(fake.issues).toEqual([]);
  });

  it.each([
    'The job was not acquired by Runner of type self-hosted even after multiple attempts',
    'The job has exceeded the maximum execution time while awaiting a runner for 24h0m0s',
    // Verbatim from run 42050153692 (smoke job 127324215144). GitHub ended
    // that job `failure`, not `cancelled`; the cancel path must still
    // recognise it when a lost runner ends a run cancelled.
    'The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.',
  ])(
    'reports a run GitHub cancelled for lack of a runner: %s',
    async (message) => {
      const fake = fakeGithub();
      fake.setRun({
        jobs: [job(31, 'smoke', 'cancelled')],
        annotations: { 31: [annotation(message)] },
      });
      await runMainHealth(
        fake,
        workflowRunEvent('Main: Container smoke', 'cancelled', {
          event: 'push',
        }),
      );
      expect(fake.issues).toHaveLength(1);
      expect(fake.issues[0].title).toBe(
        'Main pipeline red: Main: Container smoke',
      );
      expect(fake.issues[0].body).toContain('GitHub cancelled it');
      expect(fake.issues[0].body).toContain('- smoke (cancelled)');
      expect(fake.issues[0].body).toContain('Trigger: push');
    },
  );

  it('writes nothing for a cancel it cannot attribute, and says so on its own run', async () => {
    const fake = fakeGithub();
    fake.setRun({ jobs: [], annotations: {} });
    const { core } = await runMainHealth(
      fake,
      workflowRunEvent('Repo: Starved PR report', 'cancelled'),
    );
    expect(fake.writes).toEqual([]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('no recognised cause'),
    );
  });

  it('still opens the tracker when the run details cannot be read, then fails visibly', async () => {
    const fake = fakeGithub();
    fake.setRun({ jobs: [], annotations: {}, failJobs: true });
    await expect(
      runMainHealth(fake, workflowRunEvent('Repo: Backlog policy', 'failure')),
    ).rejects.toThrow(/Tracker written without run details: HTTP 502/);
    expect(fake.issues).toHaveLength(1);
    expect(fake.issues[0].body).toContain('Run details unavailable: HTTP 502');
  });

  it('fails visibly rather than guessing when a cancel cannot be read', async () => {
    const fake = fakeGithub();
    fake.setRun({ jobs: [], annotations: {}, failJobs: true });
    await expect(
      runMainHealth(
        fake,
        workflowRunEvent('Main: Container smoke', 'cancelled'),
      ),
    ).rejects.toThrow(/HTTP 502/);
    expect(fake.writes).toEqual([]);
  });
});
