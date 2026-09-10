import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
// The gate declares the reviewed capacity-action commit; this test reads it
// rather than restating it. When those were two literals they drifted (#3443
// moved this one and left the gate's behind, taking `main` red).
import {
  CHECKOUT_ACTION,
  PNPM_SETUP_ACTION,
  REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA,
  readWorkflowDocuments,
} from '../actionlint-gate.mjs';
import { readPnpmLockfile } from '../lib/pnpm-lockfile.mjs';
import {
  failureDigest,
  parseMainHealthState,
  renderMainHealthComment,
} from '../main-health-comment-policy.mjs';
import {
  resolveAndroidBuildRun,
  sanitizeLookupDiagnostic,
  validateAndroidBuildRun,
} from '../resolve-android-build-run.mjs';

const root = resolve(import.meta.dirname, '../..');

function workflow(name: string) {
  return readFileSync(resolve(root, '.github/workflows', name), 'utf8');
}

/**
 * station#3579: extracts the concatenated bodies of every YAML `run:` step
 * within `yamlSource` — both bare single-line `run: <command>` forms and
 * `run: |` block-scalar forms — after first dropping every `#`-prefixed
 * comment line. Comments and `run:` bodies are otherwise textually
 * indistinguishable to a raw `.toContain`/`.not.toContain` check on a whole
 * workflow file, which cuts both ways:
 *
 * - A `not.toContain('run: <command>')` check only matches a literal
 *   `run: ` prefix, so a regression that re-adds the forbidden command
 *   *inside* a `run: |` block scalar's body (which carries no per-line
 *   `run: ` prefix) slips through silently.
 * - A bare-string `not.toContain('<command>')` check (dropping that prefix
 *   to close the gap above) instead risks reddening a CORRECT tree the
 *   moment a comment explains the constant by name in plain prose, since
 *   the comment's text is otherwise indistinguishable from executed shell.
 *
 * Asserting over this extraction closes both: a bare-command match is
 * strengthened (block-scalar-proof) without becoming comment-sensitive
 * (comment-proof), because comment lines never reach the extracted text at
 * all.
 *
 * This is a line-oriented approximation of the `run:` mapping key, not a
 * YAML parser — verified line-for-line against a real YAML parser (pyyaml)
 * across all 22 checked-in workflows (0 under-extracted, 0 over-extracted
 * on the corpus as it exists today), but its known failure modes matter
 * for what a FUTURE workflow edit could defeat:
 *
 * `run: |`, `run: >`, and their explicit chomping-indicator forms
 * (`run: |-`, `run: |2`, `run: >-`, ...) are all recognized as block
 * scalars (anything starting with `|` or `>`) and collect the following
 * more-indented block until the first blank or dedented line (GitHub
 * Actions' own scalar-block rule); `run: <inline command>` takes the rest
 * of the line; both forms may be preceded by a `- ` sequence-item marker
 * (the `- run: <cmd>` shorthand for a step with no separate `name:` key,
 * used throughout these workflows).
 *
 * Two genuine UNDER-extraction gaps exist, neither present in this repo's
 * workflows today (grepped), and under-extraction is the dangerous
 * direction for a `not.toContain` assertion — a command in a form this
 * helper misses is invisible to every negative check built on it:
 *
 * - `run:` with its value entirely on the FOLLOWING line, no `|`/`>`
 *   indicator (a valid plain-scalar YAML form) — `trimmedRest` is empty,
 *   which does not start with `|`/`>`, so the inline branch runs and
 *   pushes an empty string; the step contributes NOTHING to the extracted
 *   text.
 * - A quoted flow scalar spanning multiple lines (`run: "cmd &&\n  cmd2"`)
 *   — only the first source line is captured; continuation lines are
 *   never visited because block-scalar collection never triggers.
 *
 * A known OVER-extraction gap, also unexercised today: `keyIndent` is the
 * indentation of the `run:` KEY LINE (including a leading `- ` marker's own
 * column, not the column immediately after it), so a `- run: |` shorthand
 * swallows any sibling `env:`/`with:` key written at that same line's
 * indentation, since such a sibling is still more-indented than
 * `keyIndent`. Only step-body-shaped YAML (a `run:` key with siblings
 * indented further than the marker line) exists in this repo's workflows,
 * so this has not manifested — but a future edit combining `- run: |`
 * shorthand with a sibling key at the marker's own column would have its
 * sibling silently absorbed into the extracted "shell" text.
 */
function extractRunBodies(yamlSource: string): string {
  const lines = yamlSource.split('\n').filter((line) => !/^\s*#/.test(line));
  const bodies: string[] = [];
  const runKeyPattern = /^(\s*)(?:- )?run:(\s*)(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const match = runKeyPattern.exec(lines[i]);
    if (!match) continue;
    const [, indent, , rest] = match;
    const trimmedRest = rest.trim();
    if (trimmedRest.startsWith('|') || trimmedRest.startsWith('>')) {
      const keyIndent = indent.length;
      let j = i + 1;
      while (j < lines.length) {
        const line = lines[j];
        if (line.trim() === '') {
          bodies.push('');
          j++;
          continue;
        }
        const lineIndent = /^(\s*)/.exec(line)?.[1].length ?? 0;
        if (lineIndent <= keyIndent) break;
        bodies.push(line);
        j++;
      }
      i = j - 1;
    } else {
      bodies.push(trimmedRest);
    }
  }
  return bodies.join('\n');
}

const coordinatedArtifactPaths = [
  '.kontourai/verification-receipts/',
  '.kontourai/verification-output/',
];

const androidRunUrl =
  'https://api.github.com/repos/kontourai/station/actions/runs/123';
const encoder = new TextEncoder();

function androidBuildRun(overrides = {}) {
  return {
    id: 123,
    head_sha: 'a'.repeat(40),
    conclusion: 'success',
    path: '.github/workflows/build-android.yml',
    event: 'push',
    head_branch: 'main',
    head_repository: { full_name: 'kontourai/station' },
    ...overrides,
  };
}

function apiResponse({
  body = JSON.stringify(androidBuildRun()),
  bodyReadError,
  headers = {},
  keepOpen = false,
  onCancel,
  redirected = false,
  status = 200,
  statusText = 'OK',
  url = androidRunUrl,
}: {
  body?: string | Uint8Array[];
  bodyReadError?: unknown;
  headers?: Record<string, string>;
  keepOpen?: boolean;
  onCancel?: () => void;
  redirected?: boolean;
  status?: number;
  statusText?: string;
  url?: string;
} = {}) {
  const chunks = typeof body === 'string' ? [encoder.encode(body)] : body;
  const contentLength = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (bodyReadError) controller.error(bodyReadError);
        else if (!keepOpen) controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
    headers: new Headers({
      'content-length': String(contentLength),
      ...headers,
    }),
    ok: status >= 200 && status < 300,
    redirected,
    status,
    statusText,
    url,
  } as Response;
}

function resolverInput(overrides = {}) {
  return {
    appendFile: vi.fn(),
    env: { GH_TOKEN: 'test-token' },
    fetchImpl: async () => apiResponse(),
    outputPath: 'unused',
    repository: 'kontourai/station',
    runId: '123',
    ...overrides,
  };
}

describe('CI verification workflow contracts', () => {
  it('keeps always-on secret scanning independent from heavy CI concurrency', () => {
    const ci = workflow('ci.yml');
    const secretScan = workflow('secret-scan.yml');

    expect(secretScan).toMatch(/^name: Secret Scan$/m);
    expect(secretScan).toContain('    name: Secret Scan');
    expect(secretScan).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
    expect(secretScan).toMatch(/^ {2}pull_request:\n {4}branches: \[main\]$/m);
    expect(secretScan).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(secretScan).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(secretScan).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    expect(secretScan).toContain('cancel-in-progress: true');
    expect(secretScan).toContain(
      'secret-scan.yml@02f40a67901a79ce4004c44d91e350b93782644c',
    );
    expect(secretScan).toContain('runner: \'"ubuntu-22.04"\'');
    expect(secretScan).not.toContain('capacity-coordination-root:');
    expect(secretScan).not.toContain('capacity-host-id:');
    expect(secretScan).not.toContain('pull_request_target:');
    expect(secretScan).not.toContain("github.event_name != 'pull_request'");
    expect(secretScan).toContain(
      `group: station-secret-scan-\${{ github.ref }}`,
    );
    expect(secretScan).not.toContain('group: ci-');
    expect(secretScan).not.toContain('group: container-smoke-');
    expect(ci).not.toContain('paths-ignore:');
    expect(ci).toContain('Exact full-diff classification');
    expect(ci).toContain('needs.classify.outputs.heavy');
    expect(ci).not.toContain('  secret-scan:');
  });

  it('tracks and closes one attributed issue per red main-only workflow', () => {
    const mainHealth = workflow('main-health.yml');
    const workflowDocuments = readWorkflowDocuments();
    const parsedMainHealth = workflowDocuments.find(
      ({ file }) => file === '.github/workflows/main-health.yml',
    )?.document as
      | {
          on?: { workflow_run?: { workflows?: unknown } };
          permissions?: unknown;
        }
      | undefined;
    const intendedTargetFiles = [
      '.github/workflows/nightly.yml',
      '.github/workflows/container-smoke.yml',
      '.github/workflows/windows-verification.yml',
      '.github/workflows/secret-scan.yml',
      '.github/workflows/backlog-priority-policy.yml',
      '.github/workflows/android-test.yml',
      '.github/workflows/dependency-advisory.yml',
    ];
    const intendedTargetNames = intendedTargetFiles.map((targetFile) => {
      const target = workflowDocuments.find(({ file }) => file === targetFile)
        ?.document as { name?: unknown } | undefined;
      expect(target?.name).toEqual(expect.any(String));
      return target?.name as string;
    });
    const watchedWorkflows = parsedMainHealth?.on?.workflow_run?.workflows;
    expect(watchedWorkflows).toEqual(expect.any(Array));
    expect(new Set(watchedWorkflows as string[])).toEqual(
      new Set(intendedTargetNames),
    );
    const trigger = mainHealth.slice(
      mainHealth.indexOf('  workflow_run:'),
      mainHealth.indexOf('\npermissions:'),
    );
    const failureJob = mainHealth.slice(
      mainHealth.indexOf('  report-failure:'),
      mainHealth.indexOf('  close-after-success:'),
    );
    const successJob = mainHealth.slice(
      mainHealth.indexOf('  close-after-success:'),
    );

    expect(trigger).toContain('types: [completed]');
    expect(trigger).not.toContain('Main pipeline health');
    // `contents: read` was added for one reason — checking out the default
    // branch so the failure job can import its comment-policy module (#1811).
    // Pinned as an exact object rather than a `not.toContain`, so the next
    // scope added to this privileged workflow_run handler is a visible edit
    // here and not a silently passing absence check.
    expect(parsedMainHealth?.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'write',
    });
    // Only report-failure grew: it checks out and reads the tracker's comment
    // history. close-after-success does the same work it always did, so the
    // asymmetry is deliberate and pinned as such.
    expect(failureJob).toContain('timeout-minutes: 5');
    expect(successJob).toContain('timeout-minutes: 2');
    expect(failureJob).toContain(
      "github.event.workflow_run.conclusion == 'failure'",
    );
    expect(successJob).toContain(
      "github.event.workflow_run.conclusion == 'success'",
    );
    for (const job of [failureJob, successJob]) {
      expect(job).toContain("github.event.workflow_run.head_branch == 'main'");
      expect(job).toContain(
        'github.event.workflow_run.head_repository.full_name == github.repository',
      );
      expect(job).toContain(
        'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3',
      );
      expect(job).toContain('github.event.workflow_run.html_url');
      expect(job).toContain('github.event.workflow_run.head_sha');
      expect(job).toContain('Main pipeline red: $' + '{workflowName}');
    }
    expect(failureJob).toContain("labels: ['bug', 'P1']");
    expect(failureJob).toContain("state: 'all'");
    expect(failureJob).toContain("state: 'open'");
    expect(failureJob).toContain(
      'group: main-health-$' + '{{ github.event.workflow_run.name }}',
    );
    expect(failureJob).not.toContain('cancel-in-progress');
    // The comment policy lives in a module so its transitions are testable
    // without a workflow_run event; re-inlining it would take that away
    // silently. The checkout reads the default branch, never the reported
    // run's code, and keeps no credentials.
    expect(failureJob).toContain(`uses: ${CHECKOUT_ACTION}`);
    expect(failureJob).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'ref: ${{ github.event.repository.default_branch }}',
    );
    expect(failureJob).toContain('persist-credentials: false');
    expect(failureJob).toContain('scripts/main-health-comment-policy.mjs');
    expect(failureJob).toContain('summarizeRunFailure(jobs)');
    expect(failureJob).toContain('github.rest.issues.updateComment');
    expect(successJob).toContain("state: 'closed'");
    expect(successJob).not.toContain("conclusion == 'failure'");
  });

  it('refuses to close a main-health issue for a skip-bearing run', () => {
    const mainHealth = workflow('main-health.yml');
    const successJob = mainHealth.slice(
      mainHealth.indexOf('  close-after-success:'),
    );

    expect(successJob).toContain('github.rest.actions.listJobsForWorkflowRun');
    expect(successJob).toContain(
      "jobs.some((job) => job.conclusion === 'success')",
    );
    expect(successJob).toContain(
      "jobs.some((job) => job.conclusion === 'skipped')",
    );
    expect(successJob).toContain(
      'if (!hasSuccessfulJob || hasSkippedJob) return;',
    );
  });

  /**
   * Runs the report-failure step's own script, the way the Nightly test below
   * runs close-after-success's. The module pin above proves the workflow
   * NAMES the policy; only executing the script proves it ACTS on the answer —
   * a step that imported the module and then commented unconditionally would
   * satisfy every string assertion in this file.
   *
   * The `workflow_run` event itself still cannot be raised locally; what this
   * covers is everything downstream of it.
   */
  async function runReportFailure({
    comments,
    failingStep,
    issueState = 'open',
  }: {
    comments: { id: number; body: string; user?: { type: string } }[];
    failingStep: string;
    issueState?: 'open' | 'closed';
  }) {
    const document = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/main-health.yml',
    )?.document as {
      jobs: Record<string, { steps: { with?: { script?: string } }[] }>;
    };
    const script = document.jobs['report-failure'].steps.find(
      (step) => typeof step.with?.script === 'string',
    )?.with?.script as string;
    // `new Function` cannot host a dynamic `import()`, and this step's first
    // statement is one. vm.compileFunction with the main context's loader can,
    // so the script runs verbatim rather than being rewritten to suit the test.
    const run = vm.compileFunction(
      `return async function (github, context, process, core) {\n${script}\n};`,
      [],
      { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    )();
    const listForRepo = vi.fn();
    const listJobs = vi.fn();
    const listComments = vi.fn();
    const createComment = vi.fn();
    const updateComment = vi.fn();
    const updateIssue = vi.fn();
    const github = {
      rest: {
        actions: { listJobsForWorkflowRun: listJobs },
        issues: {
          listForRepo,
          listComments,
          create: vi.fn(),
          update: updateIssue,
          addLabels: vi.fn(),
          createComment,
          updateComment,
        },
      },
      paginate: vi.fn(async (method: unknown) => {
        if (method === listJobs)
          return [
            {
              name: 'policy',
              conclusion: 'failure',
              steps: [{ name: failingStep, conclusion: 'failure' }],
            },
          ];
        if (method === listComments) return comments;
        return [
          {
            number: 42,
            state: issueState,
            title: 'Main pipeline red: Backlog disposition policy',
          },
        ];
      }),
    };
    await run(
      github,
      {
        repo: { owner: 'kontourai', repo: 'station' },
        payload: { workflow_run: { id: 123 } },
      },
      {
        env: {
          GITHUB_WORKSPACE: root,
          WORKFLOW_NAME: 'Backlog disposition policy',
          RUN_URL: 'https://example.test/run/123',
          HEAD_SHA: 'a'.repeat(40),
        },
      },
      { info: vi.fn() },
    );
    return { createComment, updateComment, updateIssue };
  }

  function recordedComment(failure: string) {
    return renderMainHealthComment(
      {
        workflowName: 'Backlog disposition policy',
        runUrl: 'https://example.test/run/1',
        headSha: 'a'.repeat(40),
      },
      {
        lead: 'The workflow failed again on main.',
        failures: [failure],
        failureCount: 1,
        digest: failureDigest([failure]),
        redRunsSinceComment: 4,
        commentedAt: new Date().toISOString(),
      },
    );
  }

  it('records an unchanged red run in the existing comment rather than adding one', async () => {
    const { createComment, updateComment } = await runReportFailure({
      comments: [
        {
          id: 7,
          body: recordedComment('policy > Run the gate (failure)'),
          user: { type: 'Bot' },
        },
      ],
      failingStep: 'Run the gate',
    });

    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledTimes(1);
    const [call] = updateComment.mock.calls;
    expect(call[0].comment_id).toBe(7);
    expect(parseMainHealthState(call[0].body)?.redRunsSinceComment).toBe(5);
  });

  it('comments when a different step fails than the last comment recorded', async () => {
    const { createComment, updateComment } = await runReportFailure({
      comments: [
        {
          id: 7,
          body: recordedComment('policy > Run the gate (failure)'),
          user: { type: 'Bot' },
        },
      ],
      failingStep: 'Publish the report',
    });

    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(createComment.mock.calls[0][0].body).toContain(
      'policy > Publish the report (failure)',
    );
  });

  it('speaks when a green-closed tracker is reopened, even with matching state', async () => {
    // The reducer's own reopen test passes `reopened: true` directly, so it
    // never reaches the wiring. Here the ONLY signal is the closed issue the
    // workflow reads: with `reopened` hardcoded false at the call site, the
    // pre-close marker still matches and the tracker reopens in silence —
    // the one comment the design most owes a reader.
    const { createComment, updateComment, updateIssue } =
      await runReportFailure({
        comments: [
          {
            id: 7,
            body: recordedComment('policy > Run the gate (failure)'),
            user: { type: 'Bot' },
          },
        ],
        failingStep: 'Run the gate',
        issueState: 'closed',
      });

    expect(updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 42, state: 'open' }),
    );
    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('scans the advisory floor on its own sub-daily schedule, in a shape main-health can clear (#1753)', () => {
    const document = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/dependency-advisory.yml',
    )?.document as
      | {
          on?: { schedule?: unknown; workflow_dispatch?: unknown };
          permissions?: unknown;
          jobs?: Record<
            string,
            { if?: unknown; 'runs-on'?: unknown; steps?: { run?: unknown }[] }
          >;
        }
      | undefined;

    // Parsed values, not file text: every constant below is also named in
    // that workflow's own comments, so a substring check over the source
    // would stay green if the key itself changed while the prose survived.
    //
    // A registry-side break reds the floor for every pull request whose diff
    // touches a dependency input (the policy narrows by range), with no
    // commit to attribute it to — a newly disclosed advisory, or an affected
    // range narrowing until a ledger residual is unused. Four slots a day
    // bound how long that goes unattributed; one slot leaves it to whichever
    // pull request gates next, which is how four such breaks were found on
    // 2026-09-08.
    expect(document?.on?.schedule).toEqual([{ cron: '23 2,8,14,20 * * *' }]);
    expect(document?.on).toHaveProperty('workflow_dispatch');
    // main-health.yml owns every issue write; a red scan here only has to be
    // observable as a failed run on main.
    expect(document?.permissions).toEqual({ contents: 'read' });

    // main-health clears this workflow's tracker only for a run that has a
    // successful job and NO skipped job. A second job here, or an `if:` on
    // this one, would leave the tracker open against a floor that has since
    // gone green.
    const jobs = Object.entries(document?.jobs ?? {});
    expect(jobs).toHaveLength(1);
    const [, audit] = jobs[0];
    expect(audit.if).toBeUndefined();
    expect(audit['runs-on']).toBe('ubuntu-22.04');
    expect(audit.steps?.map((step) => step.run)).toContain(
      'npm run audit:policy',
    );
  });

  it('closes Nightly health only after terminal deliveries, despite expected recovery skips', async () => {
    const document = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/main-health.yml',
    )?.document as {
      jobs: Record<string, { steps: { with: { script: string } }[] }>;
    };
    const script = document.jobs['close-after-success'].steps[0].with.script;
    const run = new (Object.getPrototypeOf(async () => {}).constructor)(
      'github',
      'context',
      'process',
      script,
    );
    const requiredNames = [
      '3 · Publish native cohort / Record ledger and markers',
      '3 · Publish CLI to npm nightly',
      '3 · Stage portable fleet evidence / Admit portable bytes',
    ];
    for (const missingTerminal of [false, true]) {
      const update = vi.fn();
      const jobs = requiredNames.map((name, index) => ({
        name,
        conclusion: missingTerminal && index === 0 ? 'skipped' : 'success',
      }));
      // Skipped on a complete night; it runs only when a chain job did not
      // succeed, and then only writes a receipt (#1774).
      jobs.push({
        name: '3 · Publish native cohort / Record incomplete-cohort receipt',
        conclusion: 'skipped',
      });
      const listJobs = vi.fn();
      const github = {
        rest: {
          actions: { listJobsForWorkflowRun: listJobs },
          issues: { listForRepo: vi.fn(), createComment: vi.fn(), update },
        },
        paginate: vi.fn(async (method) =>
          method === listJobs
            ? jobs
            : [{ number: 1, title: 'Main pipeline red: Nightly' }],
        ),
      };
      await run(
        github,
        {
          repo: { owner: 'kontourai', repo: 'station' },
          payload: { workflow_run: { id: 123 } },
        },
        {
          env: {
            WORKFLOW_NAME: 'Nightly',
            RUN_URL: 'https://example.test/run/123',
            HEAD_SHA: 'a'.repeat(40),
          },
        },
      );
      expect(update).toHaveBeenCalledTimes(missingTerminal ? 0 : 1);
    }
  });

  // The gate treats this pin as an allowlist key: a `pull_request_target`
  // router step whose `uses` does not match it exactly is reported as an
  // unreviewed custom action. That property is worth keeping — such a step runs
  // beside a write-scoped token — but it also means a Dependabot bump of
  // `pnpm/setup` can never be green on its own (#1042, #1725). Reading the pin
  // from the gate rather than restating it keeps the remedy to one edit, and
  // keeps the workflows and the gate from disagreeing while both stay green.
  it('bootstraps pnpm from the reviewed pin in every workflow that uses it', () => {
    const uses = readWorkflowDocuments().flatMap(({ file, document }) =>
      Object.values(
        (document as { jobs?: Record<string, { steps?: { uses?: string }[] }> })
          .jobs ?? {},
      ).flatMap((job) =>
        (job?.steps ?? [])
          .map((step) => step?.uses)
          .filter(
            (value): value is string =>
              typeof value === 'string' && value.startsWith('pnpm/setup@'),
          )
          .map((value) => `${file}: ${value}`),
      ),
    );
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.filter((entry) => !entry.endsWith(PNPM_SETUP_ACTION))).toEqual(
      [],
    );
  });

  it('classifies the complete push diff before entering independent heavy concurrency groups', () => {
    const ci = workflow('ci.yml');
    const containerSmoke = workflow('container-smoke.yml');

    for (const source of [ci, containerSmoke]) {
      expect(source).toContain('push:');
      expect(source).toContain('branches: [main]');
      expect(source).not.toContain('paths-ignore:');
      expect(source).toContain('Exact full-diff classification');
      expect(source).toContain('fetch-depth: 0');
      expect(source).toContain('scripts/classify-ci-change.mjs');
      expect(source).toContain('workflow_dispatch:');
    }
    expect(ci).toContain('runs-on: ubuntu-22.04');
    expect(ci).not.toContain('runs-on: [self-hosted, Linux');
    const containerClassify = containerSmoke.slice(
      containerSmoke.indexOf('  classify:'),
      containerSmoke.indexOf('  smoke:'),
    );
    expect(containerClassify).toContain('runs-on: ubuntu-22.04');
    expect(containerClassify).not.toContain('self-hosted');
    // The head sha is part of the group identity, not decoration: without it
    // two runs for the same PR at different heads collide and
    // `cancel-in-progress` picks a winner by arrival order (#1445).
    expect(ci).toContain(
      `group: ci-fast-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.ref }}-\${{ github.event.pull_request.head.sha || github.sha }}`,
    );
    expect(workflow('full-regression.yml')).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'group: hosted-full-regression-${{ inputs.source_sha }}',
    );
    expect(ci).toContain(
      `group: ci-browser-smoke-\${{ github.event_name }}-\${{ github.ref }}`,
    );
    expect(containerSmoke).toContain(
      `group: container-smoke-\${{ github.ref }}`,
    );
    // A 20-minute smoke must outlive the next queue merge; the group still
    // collapses pending runs, so only the in-progress verdict is preserved.
    const containerSmokeJob = containerSmoke.slice(
      containerSmoke.indexOf('  smoke:'),
    );
    expect(containerSmokeJob).toContain('cancel-in-progress: false');
    expect(containerSmokeJob).not.toContain('cancel-in-progress: true');
    expect(ci).not.toMatch(/^concurrency:/m);
    expect(containerSmoke).not.toMatch(/^concurrency:/m);
  });

  it('lets the container smoke wait out every desktop-win lease it cannot share the host with', () => {
    // Run 33589882367: the smoke (weight 9 of 10) waited 600s behind the
    // Windows PR floor (weight 5, budgeted 45 min, runs on every PR), timed
    // out, and main-health reopened #917 for a red with no code cause. Two
    // relations hold this closed, both read from the parsed workflows so a
    // renamed key or a string-typed number cannot satisfy them by accident.
    type Step = {
      id?: string;
      name?: string;
      if?: string;
      uses?: string;
      with?: Record<string, unknown>;
    };
    type Job = { 'timeout-minutes'?: number; steps?: Step[] };
    const documents = readWorkflowDocuments();
    const job = (file: string, jobId: string): Job => {
      const document = documents.find(
        (entry) => entry.file === `.github/workflows/${file}`,
      )?.document as { jobs?: Record<string, Job> } | undefined;
      const found = document?.jobs?.[jobId];
      expect(found, `${file} must define job "${jobId}"`).toBeDefined();
      return found as Job;
    };
    const capacityStep = (candidate: Job): Step => {
      const step = candidate.steps?.find((entry) =>
        entry.uses?.startsWith(
          'kontourai/.github/actions/physical-host-capacity@',
        ),
      );
      expect(step, 'job must reserve physical-host capacity').toBeDefined();
      return step as Step;
    };

    const smoke = job('container-smoke.yml', 'smoke');
    const smokeCapacity = capacityStep(smoke);
    const smokeWaitSeconds = Number(smokeCapacity.with?.['timeout-seconds']);
    const smokeBudgetMinutes = Number(smoke['timeout-minutes']);
    expect(Number.isInteger(smokeWaitSeconds)).toBe(true);
    expect(Number.isInteger(smokeBudgetMinutes)).toBe(true);

    // (1) The smoke's weight leaves no room for the floor beside it, so its
    // admission waits for a floor run to finish — the wait must cover the
    // floor's whole budget, not a typical duration.
    const floor = job('windows-verification.yml', 'portable-floor');
    const floorCapacity = capacityStep(floor);
    const units = Number(smokeCapacity.with?.['capacity-units']);
    expect(
      Number(smokeCapacity.with?.['lease-weight']) +
        Number(floorCapacity.with?.['lease-weight']),
    ).toBeGreaterThan(units);
    expect(smokeWaitSeconds).toBeGreaterThanOrEqual(
      Number(floor['timeout-minutes']) * 60,
    );

    // (2) Whatever the wait is, the job must keep the smoke's own running
    // time after it: raising the wait alone moves the red from the reserve
    // step to the job timeout. 25 minutes is the observed smoke duration
    // (af2ae065: 03:45 -> 04:06) with margin.
    expect(smokeBudgetMinutes * 60 - smokeWaitSeconds).toBeGreaterThanOrEqual(
      25 * 60,
    );

    // (3) The Docker-state cleanup is conditional on the isolate step having
    // run. With a bare `always()` it refused the empty DOCKER_CONFIG after a
    // failed reservation and reported that refusal as the job's last error.
    const isolate = smoke.steps?.find(
      (step) => step.name === 'Isolate Docker client state',
    );
    const remove = smoke.steps?.find(
      (step) => step.name === 'Remove isolated Docker client state',
    );
    expect(isolate?.id).toEqual(expect.any(String));
    expect(remove?.if).toContain('always()');
    expect(remove?.if).toContain(`steps.${isolate?.id}.outcome == 'success'`);
  });

  it('pins remaining desktop-win capacity leases to a bounded shared lifetime', () => {
    const reviewedSha = REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA;
    const performance = workflow('interactive-workspace-performance.yml');
    expect(
      performance.match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(3);
    expect(performance.match(/owner-lifetime-seconds: "7800"/g)).toHaveLength(
      3,
    );
    expect(
      workflow('windows-verification.yml').match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(1);
    expect(
      workflow('windows-vitest-diagnostic.yml').match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(1);
    expect(
      workflow('container-smoke.yml').match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(1);
    expect(
      workflow('ci-extended.yml').match(
        new RegExp(`physical-host-capacity@${reviewedSha}`, 'g'),
      ),
    ).toHaveLength(2);
    for (const name of [
      'android-test.yml',
      'build-android.yml',
      'ci.yml',
      'nightly.yml',
      'publish-packages.yml',
      'backlog-priority-policy.yml',
      // #1645: the gallery capture moved to a digest-pinned Playwright
      // container on a hosted runner, so it no longer reserves half of
      // desktop-win for up to its owner lifetime. It held `lease-weight: "5"`
      // of 10 capacity units while never once reaching a runner.
      'nightly-gallery.yml',
    ]) {
      expect(workflow(name), name).not.toContain('physical-host-capacity@');
    }

    const android = workflow('android-test.yml');
    const resolveBuild = android.slice(
      android.indexOf('  resolve-build:'),
      android.indexOf('  mobile-playwright:'),
    );
    const emulatorSmoke = android.slice(android.indexOf('  emulator-smoke:'));
    expect(resolveBuild).toContain('timeout-minutes: 90');
    expect(emulatorSmoke).toContain('timeout-minutes: 90');
  });

  it('keeps CI Extended as the weekly and manual full-browser surface without rerunning ci:fast', () => {
    const ci = workflow('ci.yml');
    const extended = workflow('ci-extended.yml');
    const coverage = extended.slice(
      extended.indexOf('  coverage:'),
      extended.indexOf('  playwright-full:'),
    );
    const playwrightFull = extended.slice(
      extended.indexOf('  playwright-full:'),
    );

    expect(ci).not.toContain('playwright-full:');
    expect(ci).toContain('browser-smoke:');
    expect(extended).toContain('coverage:');
    expect(extended).toContain('playwright-full:');
    expect(extended).not.toContain('run: npm run ci:extended');
    expect(extended).not.toContain('run: npm run ci:fast');
    expect(extended).toContain('run: npm run test:coverage');
    expect(extended).toContain('run: npm run verify:e2e:full');
    expect(extended).toContain("- cron: '30 11 * * 6'");
    expect(extended).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(coverage).toContain('needs: playwright-full');
    expect(coverage).toContain(
      "always() && !cancelled() && github.event_name != 'pull_request'",
    );
    expect(playwrightFull).not.toContain('needs: coverage');
    expect(coverage).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host]',
    );
    expect(playwrightFull).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host, playwright]',
    );
    for (const job of [coverage, playwrightFull]) {
      expect(job).toContain("github.event_name != 'pull_request'");
      expect(job).toContain('runner-preflight@');
      expect(job).toContain('physical-host-capacity@');
      expect(job).toContain('owner-lifetime-seconds: "7800"');
    }
  });

  it('runs only the exact screenshot bucket nightly and fails on baseline drift (#518, #875)', () => {
    const gallery = workflow('nightly-gallery.yml');
    const runBodies = extractRunBodies(gallery);

    expect(gallery).toMatch(/^name: Nightly gallery$/m);
    expect(gallery).toContain("- cron: '30 7 * * *'");
    expect(gallery).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(gallery).toContain(`group: nightly-gallery-\${{ github.ref }}`);
    // #1645: NOT cancel-in-progress. Two daily runs are 24h apart, so nothing
    // legitimately cancels its predecessor — and while this job could not
    // reach a runner at all, that setting is what converted four of six
    // consecutive stalls into a fresh-looking `cancelled` run.
    //
    // Read the parsed value, not the file text: a prose line explaining the
    // choice satisfies `toContain('cancel-in-progress: false')` on its own, so
    // the substring form would stay green if the key itself flipped or went
    // away while the comment survived.
    const galleryDocument = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/nightly-gallery.yml',
    )?.document as
      | { concurrency?: { 'cancel-in-progress'?: unknown } }
      | undefined;
    expect(galleryDocument?.concurrency?.['cancel-in-progress']).toBe(false);
    expect(gallery).toContain("if: github.event_name != 'pull_request'");
    // #1645: a digest-pinned Playwright container on a hosted runner, not the
    // fleet. The comparator hashes a decoded RGBA buffer with no threshold, so
    // the baseline is bound to whichever renderer produced it — and the
    // fleet's kontour-linux runner is a WSL2 instance in a shared developer
    // desktop whose system libraries and fonts are unmanaged and unpinnable.
    // A digest rather than the `v1.62.1-noble` tag: a rebuilt base image
    // published under the same tag is a different renderer wearing the same
    // name. Bump it in lockstep with `@playwright/test`.
    expect(gallery).toContain('runs-on: ubuntu-22.04');
    expect(gallery).not.toContain('runs-on: [self-hosted');
    // Anchored to the parsed `container.image`, not matched loose against the
    // file, so a digest quoted in a comment cannot stand in for the pin. The
    // version is a strict dotted triple rather than `[\d.]+`, which would
    // accept `1..2` or a bare `1`.
    const galleryJob = (
      galleryDocument as
        | {
            jobs?: Record<
              string,
              {
                container?: { image?: unknown };
                defaults?: { run?: { shell?: unknown } };
              }
            >;
          }
        | undefined
    )?.jobs?.['screenshot-diff'];
    const containerImage = galleryJob?.container?.image;
    expect(containerImage).toEqual(expect.any(String));

    // A CONTAINER job's default shell is `sh`, not `bash`. Measured in run
    // 34064794212: dash rejected `set -euo pipefail` with "Illegal option -o
    // pipefail" and the job died before any real work. Every `run:` here needs
    // pipefail — without it the `tee` in the dependency install masks a failed
    // `dependencies:ci`, which is precisely the pipe-masking this job exists
    // not to do — so the job must declare bash for all of them at once.
    expect(galleryJob?.defaults?.run?.shell).toBe('bash');
    const container = String(containerImage).match(
      /^mcr\.microsoft\.com\/playwright:v(?<version>\d+\.\d+\.\d+)-[a-z]+@sha256:(?<digest>[0-9a-f]{64})$/,
    );
    expect(container?.groups?.digest).toEqual(expect.any(String));

    // The container IS the renderer, so the Playwright inside it must be the
    // Playwright that drives it. The digest cannot be derived from anything in
    // this repository — that half stays unverifiable, and a skew there surfaces
    // as a Playwright launch error rather than silently. The VERSION in the tag
    // can be derived, and it is the half worth guarding: a bump to
    // `@playwright/test` that leaves the image behind would otherwise only be
    // discovered by a nightly that nobody is watching closely.
    //
    // The oracle is the LOCKFILE, not `package.json`. The declared specifier is
    // a caret range (`^1.62.1`), so comparing against the declaration would
    // miss exactly the case that matters — a resolved minor bump that installs
    // a Playwright the pinned image does not contain.
    const resolvedPlaywright = (
      readPnpmLockfile(root) as {
        importers: Record<
          string,
          { devDependencies?: Record<string, { version?: unknown }> }
        >;
      }
    ).importers['.']?.devDependencies?.['@playwright/test']?.version;
    expect(resolvedPlaywright).toEqual(expect.any(String));
    // pnpm appends peer suffixes to some resolutions; the version is the head.
    const installedVersion = String(resolvedPlaywright).replace(/\(.*$/, '');
    expect(container?.groups?.version).toBe(installedVersion);
    // runner-preflight reports the capabilities of a SELF-HOSTED runner; it
    // has nothing to assert about a hosted container.
    expect(gallery).not.toContain('runner-preflight@');
    // The capture and the diff must refer to the SAME pixels. Through
    // `run-e2e-coverage.mjs` they did not: it overrides
    // `STATION_E2E_GALLERY_DIR` to a run-scoped
    // `.kontourai/e2e-runs/<runId>/evidence/gallery` while `screenshot:diff`
    // reads `gallery/`, so the gate captured one directory and compared
    // another. Measured in run 34065319882 — capture PASSED, diff aborted with
    // "No capture manifest at …/gallery/capture.json". The bucket script
    // invoked directly retains `gallery/`, which is what the spec's own comment
    // says it is for.
    expect(runBodies).toContain('npm run test:e2e:screenshot');
    expect(runBodies).not.toContain('run-e2e-coverage.mjs --only=screenshot');
    expect(runBodies).toContain('npm run screenshot:diff');
    expect(runBodies.indexOf('npm run test:e2e:screenshot')).toBeLessThan(
      runBodies.indexOf('npm run screenshot:diff'),
    );
    expect(runBodies).not.toContain('npm run verify:e2e:full');
    expect(runBodies).not.toContain('npm run test:coverage');
    expect(gallery).toContain('name: Upload gallery and pixel diffs');
    expect(gallery).toContain('if: always()');
    expect(gallery).toContain('continue-on-error: true');
    expect(gallery).toContain('gallery/');

    // The rot alarm is only an alarm if a pixel mismatch FAILS the job. A
    // file-level `toContain('continue-on-error')` would stay green if that
    // key migrated onto the capture/diff step, so pin it to the upload step:
    // everything before the upload must be able to fail the job.
    const uploadIndex = gallery.indexOf('name: Upload gallery and pixel diffs');
    expect(uploadIndex).toBeGreaterThan(-1);
    expect(gallery.slice(0, uploadIndex)).not.toContain('continue-on-error');
  });

  it('the nightly gallery entrypoint reaches the suppression-injecting suite (station#875)', () => {
    // nightly-gallery.yml invokes `test:e2e:screenshot`, but the
    // hermetic-roster flag lives in run-e2e-suite.mjs. Nothing else asserts
    // that chain, so a renamed bucket script would leave every test green while
    // the nightly captured with the host's real CLIs — the exact daily re-red
    // this lane exists to prevent.
    //
    // #1645 shortened this chain by one hop: the workflow used to reach the
    // bucket through `run-e2e-coverage.mjs --only=screenshot`, which wrote the
    // gallery somewhere `screenshot:diff` never looked. The roster is unchanged
    // either way because it has always lived in the suite runner, which is what
    // this asserts.
    expect(extractRunBodies(workflow('nightly-gallery.yml'))).toContain(
      'npm run test:e2e:screenshot',
    );
    const pkg = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:e2e:screenshot']).toContain('--suite=screenshot');
    const suite = readFileSync(
      resolve(root, 'scripts/run-e2e-suite.mjs'),
      'utf8',
    );
    expect(suite).toContain('STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION');
  });

  it('runs browser smoke only after the full completion gate releases capacity', () => {
    const ci = workflow('ci.yml');
    const browserSmoke = ci.slice(ci.indexOf('  browser-smoke:'));

    expect(browserSmoke).toContain('needs: [classify, full-regression]');
    expect(browserSmoke).toContain(
      "if: github.event_name != 'pull_request_target'",
    );
    expect(browserSmoke).toContain(
      'Start browser smoke only after the completion gate',
    );
    expect(browserSmoke).toContain(
      'GitHub skips failed dependencies by default',
    );
  });

  it('keeps fast feedback bounded and composes the full merge gate separately', () => {
    const ci = workflow('ci.yml');
    const fastChecks = ci.slice(
      ci.indexOf('  fast-checks:'),
      ci.indexOf('  fork-smoke:'),
    );
    const fullRegression = ci.slice(
      ci.indexOf('  full-regression:'),
      ci.indexOf('  browser-smoke:'),
    );

    expect(fastChecks).toContain('timeout-minutes: 45');
    expect(fastChecks).toContain('timeout-minutes: 20');
    expect(fastChecks).toContain('run: npm run ci:fast');
    expect(fastChecks).toContain("needs.classify.outputs.heavy == 'true'");
    expect(fastChecks).toContain('runs-on: ubuntu-22.04');
    expect(fastChecks).not.toContain('self-hosted');
    expect(fastChecks).not.toContain('physical-host-capacity@');
    expect(fastChecks).toContain('STATION_CI_FAST_BASE');
    expect(fastChecks).toContain('run: npm run ci:fast');
    expect(fastChecks).toContain('name: Enforce candidate UI bundle budget');
    expect(fastChecks).toContain('run: npm run build:ui');
    expect(fastChecks.indexOf('run: npm run ci:fast')).toBeLessThan(
      fastChecks.indexOf('name: Enforce candidate UI bundle budget'),
    );
    expect(
      fastChecks.indexOf('name: Enforce candidate UI bundle budget'),
    ).toBeLessThan(
      fastChecks.indexOf('name: Upload bounded fast-feedback diagnostics'),
    );
    expect(fastChecks).not.toContain('run: npm run full:regression');
    expect(fastChecks).not.toContain('test:connected-agents');

    expect(fullRegression).toContain('needs: [classify, fast-checks]');
    expect(fullRegression).toMatch(
      /if: \$\{\{ always\(\) && !cancelled\(\) && github\.event_name != 'pull_request_target' && github\.event_name == 'workflow_dispatch' \}\}/,
    );
    expect(fullRegression).not.toContain(
      "needs.classify.outputs.heavy == 'true'",
    );
    expect(fullRegression).toContain(
      'uses: ./.github/workflows/full-regression.yml',
    );
    expect(fullRegression).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'source_sha: ${{ github.sha }}',
    );
    expect(fullRegression).not.toContain('self-hosted');
    expect(fullRegression).not.toContain('physical-host-capacity@');
    const desktopWinLeaseWeights = [
      'interactive-workspace-performance.yml',
      'windows-verification.yml',
      'windows-vitest-diagnostic.yml',
      'container-smoke.yml',
    ].flatMap((name) =>
      [...workflow(name).matchAll(/^\s+lease-weight: ["']?(\d+)["']?$/gm)].map(
        ([, weight]) => Number(weight),
      ),
    );
    expect(desktopWinLeaseWeights).toEqual([6, 6, 6, 5, 9, 9]);
    expect(Math.max(...desktopWinLeaseWeights)).toBeLessThanOrEqual(9);
    expect(workflow('secret-scan.yml')).not.toContain('capacity-lease-weight:');
    expect(fullRegression).not.toContain('run: npm run full:regression');
  });

  it('validates pull-request titles from exact base policy before either candidate checkout', () => {
    const ci = workflow('ci.yml');
    const trigger = ci.slice(
      ci.indexOf('  pull_request_target:'),
      ci.indexOf('  workflow_dispatch:'),
    );
    expect(trigger).toContain('types: [opened, synchronize, reopened, edited]');

    const fastChecks = ci.slice(
      ci.indexOf('  fast-checks:'),
      ci.indexOf('  fork-smoke:'),
    );
    const forkSmoke = ci.slice(
      ci.indexOf('  fork-smoke:'),
      ci.indexOf('  full-regression:'),
    );
    for (const [job, candidateRepository, conditional] of [
      [
        fastChecks,
        `repository: \${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name || github.repository }}`,
        `if: \${{ github.event_name == 'pull_request_target' }}`,
      ],
      [
        forkSmoke,
        `repository: \${{ github.event.pull_request.head.repo.full_name }}`,
        undefined,
      ],
    ] as const) {
      const baseCheckout = job.indexOf(
        'name: Check out base policy for pull-request title gate',
      );
      const titleGate = job.indexOf(
        'name: Validate base-controlled pull-request title',
      );
      const candidateCheckout = job.indexOf(candidateRepository);
      expect(baseCheckout).toBeGreaterThan(-1);
      expect(titleGate).toBeGreaterThan(baseCheckout);
      expect(candidateCheckout).toBeGreaterThan(titleGate);
      expect(job).toContain(`repository: \${{ github.repository }}`);
      expect(job).toContain(`ref: \${{ github.event.pull_request.base.sha }}`);
      expect(job).toContain(
        `PULL_REQUEST_TITLE: \${{ github.event.pull_request.title }}`,
      );
      expect(job).toContain(
        `PULL_REQUEST_NUMBER: \${{ github.event.pull_request.number }}`,
      );
      expect(job).toContain(
        'node scripts/commit-message-gate.mjs --pull-request-title "$PULL_REQUEST_TITLE" "$PULL_REQUEST_NUMBER"',
      );
      if (conditional) expect(job).toContain(conditional);
    }
  });

  it('runs required checks against the synthesized merge-group candidate', () => {
    const ci = workflow('ci.yml');
    const security = workflow('security-analysis.yml');
    const windows = workflow('windows-pr-verification.yml');
    const ios = workflow('build-ios.yml');

    for (const source of [ci, security, windows, ios]) {
      expect(source).toContain(
        'merge_group:\n    branches: [main]\n    types: [checks_requested]',
      );
    }
    expect(ci).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      "BEFORE: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event.before || '0000000000000000000000000000000000000000' }}",
    );
    expect(ci).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      "STATION_CI_FAST_BASE: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.base.sha || github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event.before || 'origin/main' }}",
    );
    expect(security).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'base-ref: ${{ github.event.merge_group.base_sha }}',
    );
    expect(security).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'head-ref: ${{ github.event.merge_group.head_sha }}',
    );
    expect(windows).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'group: windows-pr-verification-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(ios).toContain(
      "github.event_name == 'merge_group' && github.event.merge_group.head_sha",
    );
  });

  it('keeps coordinated lane receipts and failure artifacts downloadable', () => {
    for (const name of [
      'ci.yml',
      'ci-extended.yml',
      'windows-verification.yml',
    ]) {
      const source = workflow(name);
      expect(source, name).toContain('if: always()');
      expect(source, name).toContain('if-no-files-found: ignore');
      expect(source, name).not.toContain('actions/cache');
      for (const artifactPath of coordinatedArtifactPaths)
        expect(source, name).toContain(artifactPath);
    }

    const extended = workflow('ci-extended.yml');
    const playwrightUpload = extended.slice(
      extended.indexOf(
        '      - name: Upload Playwright verification diagnostics',
      ),
    );
    expect(extended).toContain('coverage/');
    expect(extended).toContain('playwright-report/');
    expect(extended).toContain('test-results/');
    expect(extended).toContain('.kontourai/e2e-latest/');
    expect(playwrightUpload).toMatch(
      /name: Upload Playwright verification diagnostics\n\s+if: always\(\)\n\s+uses: actions\/upload-artifact@/,
    );
    expect(playwrightUpload).toContain('.kontourai/e2e-latest/');
  });

  it('installs Playwright browsers to $HOME, not node_modules, in every job npm run dependencies:ci would otherwise wipe (station#3517, station#3555)', () => {
    const envExport =
      'echo "PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright" >> "$GITHUB_ENV"';
    const inNodeModulesPathZero = /PLAYWRIGHT_BROWSERS_PATH=0/;

    const ci = workflow('ci.yml');
    const fullRegression = workflow('full-regression.yml');
    const browserSmoke = ci.slice(ci.indexOf('  browser-smoke:'));
    const extended = workflow('ci-extended.yml');
    const coverage = extended.slice(
      extended.indexOf('  coverage:'),
      extended.indexOf('  playwright-full:'),
    );
    const playwrightFull = extended.slice(
      extended.indexOf('  playwright-full:'),
    );

    // `npm run dependencies:ci` deletes and reinstalls all of `node_modules`, taking
    // `node_modules/playwright-core/.local-browsers` with it — but never
    // touches `$HOME`. Both jobs below export `PLAYWRIGHT_BROWSERS_PATH` to
    // a `$HOME`-rooted path job-wide (via `$GITHUB_ENV`) and call
    // `playwright install` directly, never through `npm run
    // install:playwright[:ci]` — those scripts hardcode
    // `PLAYWRIGHT_BROWSERS_PATH=0` (in-node_modules) as a package.json
    // prefix, which would silently override the exported path.
    for (const [job, name, installLine] of [
      [fullRegression, 'full-regression', 'npx playwright install chromium'],
      [
        playwrightFull,
        'playwright-full',
        'node scripts/install-playwright-browsers.mjs chromium',
      ],
    ] as const) {
      const jobRunBody = extractRunBodies(job);
      // Both jobs' install steps are `run: |` block scalars — proven by
      // this non-vacuous check (station#3579: comment-stripping must not
      // reduce the asserted-over text to something that would pass any
      // negative check regardless of content).
      expect(jobRunBody, name).toContain(installLine);
      // station#3579 review round MEDIUM-1: this positive `envExport` check
      // stayed on raw `job` text only, so commenting out the REAL export
      // line inside the `run: |` block (the exact regression this test's
      // headline claims to guard) left it — and the ordering assertion
      // below it, which then compared against the comment's offset — both
      // green, because the substring survives as a shell comment. Checking
      // the extracted run body closes it the same way LOW-A/LOW-B did.
      expect(jobRunBody, name).toContain(envExport);
      expect(job, name).toContain(envExport);
      expect(job, name).toContain(installLine);
      // Dropped the `run: ` prefix and moved to the extracted run-body text
      // (station#3579 LOW-A): the old prefixed check on raw file text never
      // saw a regression re-added *inside* this block scalar's body (no
      // per-line `run: ` prefix there), and the bare string now also
      // appears in this file's own explanatory comments — asserting over
      // comment-stripped run bodies instead catches the block-scalar case
      // without being defeated by, or reddening on, prose.
      expect(jobRunBody, name).not.toContain('npm run install:playwright');
      // station#1648: `--with-deps` apt-installs system libraries as root and
      // the fleet's runner account has no passwordless sudo, so on this
      // runner the flag could only fail — three identical times in half a
      // second each, with `verify:e2e:full` never running once.
      //
      // This is the SECOND line of that guard, not the only one. A text scan
      // over workflow YAML cannot see a folded scalar and passes on an empty
      // value, so the real refusals live in code: `actionlint-gate.mjs`
      // rejects the flag on any persistent self-hosted step (over the PARSED
      // run string), and `install-playwright-browsers.mjs` refuses it before
      // spawning anything. Asserted on the extracted run body so that the
      // workflow's own comment explaining the flag's absence stays inert.
      expect(jobRunBody, name).not.toContain('--with-deps');
      // station#3579 LOW-B: same move for the raw-path literal — a future
      // author explaining the constant in plain prose must not red this.
      expect(jobRunBody, name).not.toMatch(inNodeModulesPathZero);
      // Exported before installed — an install that runs before the
      // export would read whatever PLAYWRIGHT_BROWSERS_PATH the job
      // already had (unset, defaulting every downstream reader to '0').
      // Asserted over the run body now that both operands are proven
      // present there (immediately above), not raw `job` text.
      expect(jobRunBody.indexOf(envExport), name).toBeLessThan(
        jobRunBody.indexOf(installLine),
      );
      // Installed after npm run dependencies:ci — installing before it would place browsers
      // under a still-to-be-wiped `node_modules` state on a first-ever
      // checkout, and more importantly would run before `npm run dependencies:ci` puts the
      // `playwright` CLI on disk for `npx` to find.
      //
      // station#3579 review round MEDIUM-2: `job.indexOf('run: npm run dependencies:ci')`
      // returns -1 when the string is absent (e.g. `npm run dependencies:ci` moved into a
      // `run: |` block scalar, or reordered after the install step), and
      // `expect(-1).toBeLessThan(N)` is vacuously true — the exact
      // regression this line exists to catch would pass. Pinned as its own
      // non-vacuous presence check first, then compared on the run body.
      const npmCiIndex = jobRunBody.indexOf('npm run dependencies:ci');
      expect(npmCiIndex, name).toBeGreaterThanOrEqual(0);
      expect(npmCiIndex, name).toBeLessThan(jobRunBody.indexOf(envExport));
    }

    // browser-smoke already used this convention before this change and is
    // unaffected by it — asserted here so a future edit that regresses it
    // back toward node_modules is caught by the same test.
    const browserSmokeRunBody = extractRunBodies(browserSmoke);
    expect(browserSmokeRunBody).toContain(envExport);
    expect(browserSmoke).toContain(envExport);
    expect(browserSmokeRunBody).not.toMatch(inNodeModulesPathZero);
    // coverage (ci-extended.yml) installs no browsers at all. Its run
    // bodies are non-empty (`npm run dependencies:ci`, `npm run test:coverage`) so this
    // absence check has something real to check against, not a body
    // emptied by comment-stripping.
    const coverageRunBody = extractRunBodies(coverage);
    expect(coverageRunBody).toContain('npm run dependencies:ci');
    expect(coverageRunBody).not.toContain('playwright install');
    expect(coverageRunBody).not.toMatch(inNodeModulesPathZero);
  });

  it('checks out enough history for exact candidate and completion identities', () => {
    const ci = workflow('ci.yml');
    const fastChecks = ci.slice(
      ci.indexOf('  fast-checks:'),
      ci.indexOf('  browser-smoke:'),
    );

    expect(fastChecks).toContain('fetch-depth: 0');
    expect(fastChecks).toContain('STATION_CI_FAST_BASE');
    expect(workflow('full-regression.yml')).toContain('fetch-depth: 0');
    expect(workflow('full-regression.yml')).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'ref: ${{ inputs.source_sha }}',
    );
    expect(ci).not.toContain('  connected-agents:');
  });

  it('runs Android viewport coverage through the public isolated suite', () => {
    const android = workflow('android-test.yml');
    const resolver = readFileSync(
      resolve(root, 'scripts/resolve-android-build-run.mjs'),
      'utf8',
    );

    expect(
      android.match(
        /ref: \$\{\{ needs\.resolve-build\.outputs\.head_sha \}\}/g,
      ),
    ).toHaveLength(2);
    expect(android).toContain('run_id:');
    expect(android).toContain('required: true');
    expect(android).toContain('Resolve exact build revision');
    expect(android).toContain('node scripts/resolve-android-build-run.mjs');
    expect(resolver).toContain('.github/workflows/build-android.yml');
    expect(resolver).toContain('fetchImpl = fetch');
    expect(resolver).toContain("redirect: 'error'");
    expect(resolver).not.toContain("from 'node:child_process'");
    expect(resolver).not.toContain('spawnSync(');
    expect(resolver).not.toContain('response.json()');
    expect(resolver).not.toContain('response.text()');
    expect(android).toContain('persist-credentials: false');
    expect(android).not.toContain(
      'github.event.workflow_run.head_sha || github.sha',
    );
    // station#3579: moved from a raw-file `toContain` to the extracted
    // run-body text — the file already asserts this exact verbatim shell
    // line, and a raw-text positive check has the mirror-image risk of the
    // negative checks fixed above: a comment merely *mentioning* the
    // literal would satisfy it too, without the real command being present
    // at all. Checking the run body instead proves it's actually executed
    // shell.
    expect(extractRunBodies(android)).toContain(
      'PLAYWRIGHT_BROWSERS_PATH="$HOME/.cache/ms-playwright"',
    );
    expect(android).toContain('runs-on: ubuntu-22.04');
    expect(android).not.toContain('self-hosted');
    expect(android).toContain('reactivecircus/android-emulator-runner@');
    expect(android).toContain('run: npm run test:android');
    expect(android).not.toContain('npx vite preview');
    expect(android).not.toContain('npx playwright test --project=android');
    expect(android).toContain('test-results/');
  });

  it('keeps Linux CI on GitHub-hosted runners and desktop-win for hardware reference', () => {
    const linuxWorkflows = [
      'ci.yml',
      'android-test.yml',
      'build-android.yml',
      'secret-scan.yml',
      'nightly.yml',
      'publish-packages.yml',
      'backlog-priority-policy.yml',
      // #1645: the gallery capture belongs on a hosted runner now, because an
      // exact-pixel baseline needs a renderer pinned by digest.
      'nightly-gallery.yml',
    ];
    for (const name of linuxWorkflows) {
      const source = workflow(name);
      expect(source, name).not.toContain('runs-on: [self-hosted, Linux');
      expect(source, name).not.toMatch(/runs-on:.*fast-feedback/);
    }

    const performance = workflow('interactive-workspace-performance.yml');
    expect(performance).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
    expect(workflow('windows-verification.yml')).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
    expect(workflow('container-smoke.yml')).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host, docker, playwright]',
    );
    expect(workflow('ci-extended.yml')).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host, playwright]',
    );
    const recovery = workflow('recover-terminal-capacity-owner.yml');
    expect(recovery).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host]',
    );
    expect(recovery).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
  });

  it('accepts only trusted same-repository main Android build runs', () => {
    const valid = androidBuildRun();
    expect(validateAndroidBuildRun(valid, 'kontourai/station')).toEqual({
      headSha: valid.head_sha,
      runId: '123',
      conclusion: 'success',
    });

    for (const untrusted of [
      { ...valid, event: 'pull_request' },
      {
        ...valid,
        head_repository: { full_name: 'attacker/station' },
      },
      { ...valid, head_branch: 'feature/untrusted' },
    ]) {
      expect(() =>
        validateAndroidBuildRun(untrusted, 'kontourai/station'),
      ).toThrow();
    }
  });

  it('resolves an exact Android build through authenticated REST without gh', async () => {
    const run = androidBuildRun();
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe(androidRunUrl);
        expect(init?.headers).toMatchObject({
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer test-token',
          'X-GitHub-Api-Version': '2022-11-28',
        });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.redirect).toBe('error');
        return apiResponse({ body: JSON.stringify(run) });
      },
    );
    const appendFile = vi.fn();

    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl,
        }),
      ),
    ).resolves.toEqual({
      headSha: run.head_sha,
      runId: '123',
      conclusion: 'success',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(appendFile).toHaveBeenCalledWith(
      'unused',
      `head_sha=${run.head_sha}\nrun_id=123\nconclusion=success\n`,
    );
  });

  it('fails honestly when the authenticated run lookup returns an API error', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({
              body: JSON.stringify({ message: 'capacity exhausted' }),
              status: 503,
              statusText: 'Service Unavailable',
            }),
        }),
      ),
    ).rejects.toThrow(
      'GitHub run lookup failed with HTTP 503 Service Unavailable: capacity exhausted',
    );
    expect(appendFile).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP', 'http://api.github.com', 'GITHUB_API_URL must use HTTPS'],
    [
      'credentials',
      'https://user:pass@api.github.com',
      'GITHUB_API_URL must not include credentials',
    ],
    [
      'query',
      'https://api.github.com?redirect=elsewhere',
      'GITHUB_API_URL must not include a query string',
    ],
    [
      'fragment',
      'https://api.github.com#elsewhere',
      'GITHUB_API_URL must not include a fragment',
    ],
  ])(
    'rejects an unsafe %s API URL before fetching',
    async (_kind, apiUrl, message) => {
      const appendFile = vi.fn();
      const fetchImpl = vi.fn();
      await expect(
        resolveAndroidBuildRun(
          resolverInput({
            appendFile,
            env: { GH_TOKEN: 'test-token', GITHUB_API_URL: apiUrl },
            fetchImpl,
          }),
        ),
      ).rejects.toThrow(message);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(appendFile).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing token before fetching or exporting output', async () => {
    const appendFile = vi.fn();
    const fetchImpl = vi.fn();
    await expect(
      resolveAndroidBuildRun(resolverInput({ appendFile, env: {}, fetchImpl })),
    ).rejects.toThrow('GH_TOKEN is required');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('rejects a redirected or cross-origin response before reading its body', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({ url: 'https://unexpected.example/actions/runs/123' }),
        }),
      ),
    ).rejects.toThrow('GitHub run lookup response URL did not match request');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('rejects a response run ID that does not match the normalized request', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({ body: JSON.stringify(androidBuildRun({ id: 124 })) }),
          runId: '000123',
        }),
      ),
    ).rejects.toThrow(
      "selected Android build run ID '124' does not match requested run ID '123'",
    );
    expect(appendFile).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a declared oversized body',
      apiResponse({
        headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
      }),
    ],
    [
      'a streamed oversized body',
      apiResponse({
        body: [new Uint8Array(2 * 1024 * 1024), new Uint8Array(1)],
        headers: { 'content-length': '0' },
      }),
    ],
  ])('rejects %s without exporting output', async (_description, response) => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({ appendFile, fetchImpl: async () => response }),
      ),
    ).rejects.toThrow(
      'GitHub run lookup response body exceeds 2097152 byte limit',
    );
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('cancels a declared oversized response before acquiring a reader', async () => {
    const appendFile = vi.fn();
    const onCancel = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({
              headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
              keepOpen: true,
              onCancel,
            }),
        }),
      ),
    ).rejects.toThrow(
      'GitHub run lookup response body exceeds 2097152 byte limit',
    );
    expect(onCancel).toHaveBeenCalledOnce();
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('classifies an aborted body read as a timeout without leaking output', async () => {
    const appendFile = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          createAbortSignal: () => controller.signal,
          fetchImpl: async () =>
            apiResponse({ bodyReadError: new Error('body reader aborted') }),
        }),
      ),
    ).rejects.toThrow('GitHub run lookup body read timed out after 15000ms');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('classifies an AbortError from the body reader without leaking output', async () => {
    const appendFile = vi.fn();
    const abortError = new Error('request aborted');
    abortError.name = 'AbortError';
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () => apiResponse({ bodyReadError: abortError }),
        }),
      ),
    ).rejects.toThrow('GitHub run lookup body read aborted');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('rejects malformed successful response schema without exporting output', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () =>
            apiResponse({
              body: JSON.stringify(androidBuildRun({ path: 'unexpected.yml' })),
            }),
        }),
      ),
    ).rejects.toThrow("selected run belongs to 'unexpected.yml'");
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('rejects malformed successful JSON without exporting output', async () => {
    const appendFile = vi.fn();
    await expect(
      resolveAndroidBuildRun(
        resolverInput({
          appendFile,
          fetchImpl: async () => apiResponse({ body: '{not json' }),
        }),
      ),
    ).rejects.toThrow('GitHub run lookup returned invalid JSON');
    expect(appendFile).not.toHaveBeenCalled();
  });

  it('renders token-safe, single-line diagnostics', () => {
    const token = 'secret-token';
    const diagnostic = sanitizeLookupDiagnostic(
      `lookup failed\n${token}\u0000${'x'.repeat(2_000)}`,
      token,
    );
    expect(diagnostic).toContain('[REDACTED]');
    expect(diagnostic).not.toContain(token);
    expect(diagnostic).not.toContain('\r');
    expect(diagnostic).not.toContain('\n');
    expect(diagnostic).not.toContain('\u0000');
    expect(diagnostic.length).toBeLessThanOrEqual(1_024);
  });

  it('keeps the two copied classify jobs identical where they are copies, and different only where their own triggers require it', () => {
    // ci.yml and container-smoke.yml both carry a job called `classify` that
    // runs the same classifier. They had drifted, and the drift was invisible
    // because nothing compared them. Byte-equality is the wrong pin — one
    // workflow runs on merge_group and the other does not, so forcing the
    // expressions identical would add a dead branch to container-smoke. So
    // the invocation is pinned identical and the event handling is pinned
    // DERIVED from each workflow's own `on:` block.
    type ClassifyStep = {
      id?: string;
      run?: string;
      env?: Record<string, string>;
    };
    type ClassifyJob = {
      name?: string;
      'runs-on'?: string;
      if?: string;
      steps?: ClassifyStep[];
    };
    const documents = readWorkflowDocuments();
    const read = (file: string, stepId = 'classify') => {
      const entry = documents.find(
        (candidate) => candidate.file === `.github/workflows/${file}`,
      );
      expect(entry, `${file} must exist`).toBeDefined();
      const document = entry?.document as {
        on?: Record<string, unknown>;
        true?: Record<string, unknown>;
        jobs?: Record<string, ClassifyJob>;
      };
      // `on` is YAML 1.1 truthy, so a permissive parser can hand it back
      // under the key `true`. Both are accepted rather than assuming one.
      const triggers = Object.keys(document.on ?? document.true ?? {});
      const job = document.jobs?.classify;
      expect(job, `${file} must define job "classify"`).toBeDefined();
      const step = job?.steps?.find((candidate) => candidate.id === stepId);
      expect(
        step,
        `${file} classify job must have a step id "${stepId}"`,
      ).toBeDefined();
      return { triggers, job: job as ClassifyJob, step: step as ClassifyStep };
    };

    const ci = read('ci.yml');
    const smoke = read('container-smoke.yml');

    // The copied part: same classifier, same command, same runner, same
    // budget, same job name. A change to one that is not made to the other
    // fails here.
    expect(smoke.step.run).toBe(ci.step.run);
    expect(ci.step.run).toContain('node scripts/classify-ci-change.mjs');
    expect(smoke.job.name).toBe(ci.job.name);
    expect(smoke.job['runs-on']).toBe(ci.job['runs-on']);
    expect(smoke.job['runs-on']).toBe('ubuntu-22.04');

    // The part that is allowed to differ, and only in one direction: a
    // workflow handles merge_group in its BEFORE/AFTER expressions if and
    // only if it declares the merge_group trigger. That is what makes
    // container-smoke's shorter expression correct rather than stale, and it
    // is also what would catch a merge_group trigger added without the
    // matching base_sha branch — the actual drift shape here.
    for (const { name, triggers, step } of [
      { name: 'ci.yml', ...ci },
      { name: 'container-smoke.yml', ...smoke },
    ]) {
      const declaresMergeGroup = triggers.includes('merge_group');
      const expressions = `${step.env?.BEFORE ?? ''}${step.env?.AFTER ?? ''}`;
      expect(
        expressions,
        `${name} classify must derive BEFORE/AFTER`,
      ).toContain('github.sha');
      expect(
        expressions.includes('github.event.merge_group'),
        `${name}: merge_group trigger ${declaresMergeGroup ? 'declared' : 'absent'}, expression ${expressions.includes('github.event.merge_group') ? 'handles' : 'ignores'} it`,
      ).toBe(declaresMergeGroup);
    }

    // The guards that read as dead code and are not. Neither workflow
    // declares the event its job-level `if` excludes; the guard is what keeps
    // candidate code off a self-hosted runner if one is ever added. Pinned so
    // a later reader does not delete them as unreachable.
    expect(ci.triggers).not.toContain('pull_request');
    expect(smoke.triggers).not.toContain('pull_request');
    expect(smoke.job.if).toContain("github.event_name != 'pull_request'");
    // ci.yml's guard is live rather than defensive: it DOES declare
    // pull_request_target, and the classifier is intentionally skipped there
    // because a fork candidate must not choose its own classification.
    expect(ci.triggers).toContain('pull_request_target');
    expect(ci.job.if).toContain("github.event_name != 'pull_request_target'");

    // build-ios.yml also has a `classify` job. It is NOT a third copy and
    // must not be unified with these: it resolves the classifier out of the
    // BASE commit (`git show "$BASE_SHA:scripts/classify-ci-change.mjs"`) and
    // fails closed, because it runs on pull_request_target where the head
    // commit is untrusted. Deleting that difference in the name of removing
    // duplication would hand a fork PR control of its own iOS relevance.
    // Its step is `relevance`, not `classify` — the first sign these are
    // not the same thing.
    const ios = read('build-ios.yml', 'relevance');
    expect(ios.step.run).not.toBe(ci.step.run);
    expect(ios.step.run).toContain('$BASE_SHA:scripts/classify-ci-change.mjs');
    expect(ios.step.run).toContain('fail_closed');
  });

  it('provides the supported post-merge Windows fallback without pretending E2E is covered', () => {
    const windows = workflow('windows-verification.yml');

    expect(windows).toContain('workflow_dispatch:');
    expect(windows).toContain('push:');
    expect(windows).toContain('branches: [main]');
    expect(windows).not.toContain('pull_request:');
    expect(windows).toContain('paths:');
    expect(windows).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
    expect(windows).toContain('run: npm run verification:policy:gate');
    expect(windows).toContain('run: npm run typecheck');
    expect(windows).toContain('run: npm run test:windows:portable');
    expect(windows).toContain('no full Vitest/E2E');
    expect(windows).toContain('#1420');
    expect(windows).not.toContain('run: npm run test:full');
    expect(windows).not.toContain('verify:e2e:full');
    expect(windows).not.toContain('test:android');
  });

  it('runs the bounded Windows floor on every PR head from base-controlled hosted policy', () => {
    const windows = workflow('windows-pr-verification.yml');
    expect(windows).toContain('pull_request_target:');
    expect(windows).toContain('merge_group:');
    expect(windows).not.toContain('  pull_request:\n');
    expect(windows).toContain('branches: [main]');
    expect(windows).not.toContain(
      'github.event.pull_request.head.repo.full_name == github.repository',
    );
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).not.toContain('self-hosted');
    expect(windows).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the workflow's literal GitHub expression
      "repository: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name || github.repository }}",
    );
    expect(windows).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the workflow's literal GitHub expression
      "ref: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || github.sha }}",
    );
    expect(windows).toContain('run: npm run verification:policy:gate');
    expect(windows).toContain('run: npm run test:windows:portable');
    expect(windows).toContain('name: Compile desktop Rust tests');
    expect(windows).toContain(
      'cargo test --manifest-path src-desktop/Cargo.toml --no-run',
    );
    expect(windows).toContain('run: npm run typecheck');
  });

  it('keeps full Windows Vitest diagnostics complete, manual, and honestly red', () => {
    const diagnostic = workflow('windows-vitest-diagnostic.yml');

    expect(diagnostic).toMatch(/^name: Windows Full Vitest Diagnostic$/m);
    expect(diagnostic).toContain('workflow_dispatch:');
    expect(diagnostic).not.toContain('push:');
    expect(diagnostic).not.toContain('continue-on-error');
    expect(diagnostic).toContain(
      'runs-on: [self-hosted, Windows, X64, kontour-windows, native]',
    );
    expect(diagnostic).toContain('run: npm run test:windows:diagnostic');
    expect(diagnostic).toContain('if: always()');
    expect(diagnostic).toContain('.kontourai/windows-vitest/');
    expect(diagnostic).toContain('if-no-files-found: error');
  });

  it('keeps terminal capacity recovery manual, owner-scoped, and exact', () => {
    const recovery = workflow('recover-terminal-capacity-owner.yml');

    expect(recovery).toMatch(
      /^name: Recover terminal physical-host capacity owner$/m,
    );
    expect(recovery).toContain('workflow_dispatch:');
    expect(recovery).not.toContain('push:');
    expect(recovery).not.toContain('pull_request:');
    expect(recovery).toContain('actions: read');
    expect(recovery).toContain('contents: read');
    expect(recovery).toContain(
      'recover-terminal-capacity-owner@563effe7ec559c6f4fcc6c80b3532acb71d86373',
    );
    expect(recovery).toContain(
      'owner-repository: $' + '{{ github.repository }}',
    );
    expect(recovery).toContain('github-token: $' + '{{ github.token }}');
    expect(recovery).not.toContain('physical-host-capacity@');
    expect(recovery).toContain('cancel-in-progress: false');
  });
});

/**
 * The org's artifact retention default is 90 days. A ~169 MB debug APK per
 * push at that retention held 3.8 GB across 23 runs and filled the org's
 * storage quota, after which every upload step failed. Two properties keep
 * that from recurring, and neither is visible in a passing CI run — so pin
 * them here rather than rediscover them the next time uploads start failing
 * (station#2218).
 */
describe('artifact storage does not accumulate or gate verdicts', () => {
  it('bounds the debug APK, the largest recurring artifact', () => {
    const step =
      /name:\s*station-android-debug[\s\S]*?retention-days:\s*(\d+)/.exec(
        workflow('build-android.yml'),
      );
    expect(
      step,
      'the debug APK upload must declare a retention',
    ).not.toBeNull();
    expect(Number(step?.[1])).toBeLessThanOrEqual(14);
  });

  it.each([
    ['ci.yml', 'ci-fast-verification'],
    ['ci-extended.yml', 'coverage-verification'],
    ['nightly-gallery.yml', 'nightly-gallery'],
  ])('%s: the %s diagnostic upload cannot fail its job', (file, artifact) => {
    // A diagnostic that cannot be stored is an infrastructure condition, not
    // a verdict on the code. Read backwards from the artifact name to the
    // step that uploads it, since `continue-on-error` sits above `with:`.
    const source = workflow(file);
    const at = source.indexOf(`name: ${artifact}`);
    expect(at, `${artifact} not found in ${file}`).toBeGreaterThan(-1);
    const stepStart = source.lastIndexOf('- name:', at);
    expect(source.slice(stepStart, at)).toContain('continue-on-error: true');
  });
});

/**
 * The Tauri CLI DISCOVERS a config when none is given, by walking the tree —
 * and `experiments/browser-host/*\/tauri.conf.json` sorts before
 * `src-desktop/`. Those spike configs declare `"version": "0.0.0"`, which the
 * Android packager rejects outright, so build-android produced no APK for four
 * days after the spike landed (station#2306). Nothing in the repo's own config
 * changed; a file added elsewhere silently captured every unpinned invocation.
 */
describe('every Tauri invocation is rooted at the app directory', () => {
  const DISCOVERY_EXPOSED = [
    'build-android.yml',
    'build-ios.yml',
    'nightly-native-stage.yml',
    'release.yml',
  ];

  function tauriInvocationErrors(step: string) {
    const hasWorkingDirectory = step.includes('working-directory: src-desktop');
    return step
      .split('\n')
      .filter((line) => line.includes('npx tauri'))
      .flatMap((line) => {
        const errors: string[] = [];
        if (!hasWorkingDirectory && !line.includes('(cd src-desktop &&'))
          errors.push('unrooted Tauri invocation');
        if (!line.includes('--config'))
          errors.push('Tauri invocation without explicit config');
        return errors;
      });
  }

  it.each(DISCOVERY_EXPOSED)(
    '%s runs tauri from src-desktop, not the repo root',
    (file) => {
      // --config supplies the config VALUES; the discovered directory still
      // supplies the app ROOT. Pinning only --config left `frontendDist:
      // ../dist-ui` resolving against experiments/browser-host/ (station#2306).
      const source = workflow(file);
      const steps = source
        .split(/\n {6}- /)
        .filter((step) => step.includes('npx tauri'));
      expect(steps.length).toBeGreaterThan(0);
      for (const step of steps) {
        expect(tauriInvocationErrors(step), file).toEqual([]);
      }
    },
  );

  it('rejects an unrooted Tauri invocation even when another invariant is present', () => {
    expect(
      tauriInvocationErrors(
        'run: npx tauri build --config "$RUNNER_TEMP/tauri.json"',
      ),
    ).toContain('unrooted Tauri invocation');
  });

  it('keeps the spike configs recognisable as the hazard they are', () => {
    // These are legitimate cargo spikes whose build.rs needs a config, so they
    // stay. That is exactly why the real lanes must never resolve by discovery.
    const spike = JSON.parse(
      readFileSync(
        resolve(
          root,
          'experiments/browser-host/tauri-child-webview/tauri.conf.json',
        ),
        'utf8',
      ),
    );
    expect(spike.version).toBe('0.0.0');
    expect(spike.build.frontendDist).toBe('../fixture');
  });
});

describe('iOS verification proves packaged runtime readiness', () => {
  const ios = workflow('build-ios.yml');
  const classifier = readFileSync(
    resolve(root, 'scripts/classify-ci-change.mjs'),
    'utf8',
  );

  it('emits a stable check while reserving macOS for affected pull requests', () => {
    expect(ios).toContain('pull_request_target:');
    expect(ios).toContain('merge_group:');
    expect(classifier).toContain("'src-desktop/'");
    expect(classifier).toContain("'src-ui/'");
    expect(classifier).toContain("'packages/connect/'");
    expect(ios).toContain(
      'if [ "$GITHUB_EVENT_NAME" != "pull_request_target" ] && [ "$GITHUB_EVENT_NAME" != "merge_group" ]',
    );
    expect(ios).toContain(
      'git show "$BASE_SHA:scripts/classify-ci-change.mjs"',
    );
    expect(ios).toContain('--scope ios --mode candidate');
    expect(ios).toContain('relevant=true|relevant=false)');
    expect(ios).toContain('fail_closed "classifier execution failed"');
    expect(ios).toContain('fail_closed "classifier returned malformed output"');
    expect(ios).toContain('needs: classify');
    expect(ios).toContain("if: needs.classify.outputs.relevant == 'true'");
    expect(ios).toContain('runs-on: macos-26');
    expect(ios).toContain('/Applications/Xcode_26.6.app/Contents/Developer');
    expect(ios).not.toContain('self-hosted');
    expect(ios).toContain('persist-credentials: false');
    expect(ios).toContain("github.event_name == 'pull_request_target'");
    expect(ios).toContain(
      `--source-sha "\${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.sha }}"`,
    );
  });

  it('runs the native accessibility smoke and always retains its evidence', () => {
    expect(ios).toContain('npm run test:ios-runtime-smoke --');
    expect(ios).toContain('station-ios-simulator-runtime');
    const evidence = ios.indexOf('name: Upload iOS runtime evidence');
    expect(evidence).toBeGreaterThan(-1);
    expect(ios.slice(evidence - 120, evidence + 500)).toContain('if: always()');
  });
});

/**
 * Gradle's generated BuildTask.kt re-invokes the CLI as
 * `npm run -- tauri android android-studio-script`, and npm runs a script from
 * the package.json directory — the repo ROOT. From there the CLI discovers
 * `experiments/browser-host/*\/tauri.conf.json` and derived the experiment's
 * identifier, so it looked for a socket-address file named after the SPIKE and
 * aborted (station#2306):
 *
 *   failed to read missing addr file
 *   /tmp/io.kontour.station.browser-host-child-experiment-server-addr
 *
 * That file is generated into `src-desktop/gen/android` by `tauri android
 * init`, so the fix cannot live there — it would be overwritten. It lives in
 * the script npm actually runs.
 */
describe('the root tauri script roots itself at the app directory', () => {
  it('changes into src-desktop before invoking the CLI', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const script: string = pkg.scripts.tauri;
    expect(script).toMatch(/(^|\s|&&)cd\s+src-desktop(\s|$|&)/);
    expect(script).toContain('tauri');
  });

  it('is the invocation gradle actually uses', () => {
    // If the generated task stops calling `npm run`, this guard is protecting
    // a path nothing takes and should be revisited rather than trusted.
    const buildTask = readFileSync(
      resolve(
        root,
        'src-desktop/gen/android/buildSrc/src/main/java/io/kontourai/station/kotlin/BuildTask.kt',
      ),
      'utf8',
    );
    expect(buildTask).toContain('"run"');
    expect(buildTask).toContain('"tauri"');
  });
});
