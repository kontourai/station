import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
// The gate declares the reviewed capacity-action commit; this test reads it
// rather than restating it. When those were two literals they drifted (#3443
// moved this one and left the gate's behind, taking `main` red).
import {
  ANDROID_BUILD_TOOLS_VERSION,
  ANDROID_NDK_VERSION,
  CHECKOUT_ACTION,
  FAST_CHECKS_JOB_TIMEOUT_MINUTES,
  PNPM_SETUP_ACTION,
  REVIEWED_PHYSICAL_HOST_CAPACITY_ACTION_SHA,
  REVIEWED_SECRET_SCAN_REUSABLE_WORKFLOW_SHA,
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
import { VITEST_CORPUS_GROUP_NAMES } from '../run-vitest-corpus.mjs';
import {
  CI_FAST_TIMEOUT_MS,
  COVERAGE_LANE_TIMEOUT_MS,
  FULL_REGRESSION_PHASES,
} from '../verification-lanes.mjs';
import { QUARANTINED_VITEST_FILES } from '../vitest-resource-manifest.mjs';

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
      `secret-scan.yml@${REVIEWED_SECRET_SCAN_REUSABLE_WORKFLOW_SHA}`,
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
      '.github/workflows/secret-scan.yml',
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

  // Three lanes build Android from three separate definitions: build-android.yml
  // verifies main, nightly-native-stage.yml signs and ships to Play, release.yml
  // ships a tag. A toolchain revision restated per lane can therefore be right
  // in the lane you are reading and wrong in the lane that ships. #1795 is the
  // worked example: a bare `aapt` in build-android.yml while
  // nightly-native-stage.yml resolved it correctly, so main was red for a day
  // while nightly kept shipping and neither lane's state implied anything about
  // the other's. Read the pins from the gate; do not restate them here either.
  it('pins one Android NDK and build-tools revision across every lane', () => {
    const seen = readWorkflowDocuments().flatMap(({ file }) => {
      const source = readFileSync(file, 'utf8');
      return [
        ...[...source.matchAll(/ndk[;/]([0-9][0-9.]*)/g)].map((m) => ({
          file,
          kind: 'ndk',
          value: m[1],
        })),
        ...[...source.matchAll(/build-tools[;/]([0-9][0-9.]*)/g)].map((m) => ({
          file,
          kind: 'build-tools',
          value: m[1],
        })),
      ];
    });
    // Guards the guard: a typo in the patterns above would make this vacuous.
    expect(seen.filter((e) => e.kind === 'ndk').length).toBeGreaterThan(0);

    const expected = {
      ndk: ANDROID_NDK_VERSION,
      'build-tools': ANDROID_BUILD_TOOLS_VERSION,
    } as Record<string, string>;
    expect(
      seen
        .filter((entry) => entry.value !== expected[entry.kind])
        .map((entry) => `${entry.file}: ${entry.kind} ${entry.value}`),
    ).toEqual([]);
  });

  // A workflow that verifies `main` on push but has no pull-request trigger
  // cannot fail before it has already landed. That is not a hypothetical
  // shape: #1795 (bare aapt) and #1726 (jni 0.22, a breaking API change) both
  // passed every required check and reddened main, because build-android.yml
  // is push-only. #1726 also broke that night's Play upload.
  //
  // The list below is the point of this test. Adding a main-only verification
  // lane is currently a silent decision; this makes it a declared one, and
  // gives the next person a list to read instead of a red main to diagnose.
  it('declares why each push-to-main workflow has no pull-request signal', () => {
    // Reason strings are the contract. "Publishes" means there is nothing to
    // verify before merge; "reduced PR lane" names where the PR signal lives.
    const declared: Record<string, string> = {
      '.github/workflows/pages.yml':
        'publishes GitHub Pages from merged main; nothing to pre-verify',
      '.github/workflows/publish-packages.yml':
        'publishes released packages from merged main; nothing to pre-verify',
      '.github/workflows/source-availability.yml':
        'reports on merged main and files issues; observational, not a build',
      '.github/workflows/container-smoke.yml':
        'no pull-request signal today; unfiltered on every main push (#1331 covers its host contention)',
      '.github/workflows/build-android.yml':
        'desktop-rust.yml type-checks the Android target on pull requests; full APK assembly stays post-merge',
      '.github/workflows/ios-rust-cache-warm.yml':
        'writes the iOS Rust cache from trusted main only; build-ios.yml is the pull-request and merge-queue signal and only restores it',
    };

    const pushOnly = readWorkflowDocuments()
      .filter(({ document }) => {
        const on = (document as { on?: Record<string, unknown> })?.on;
        if (!on || typeof on !== 'object') return false;
        const push = (on as { push?: { branches?: string[] } }).push;
        if (!push?.branches?.includes('main')) return false;
        return !('pull_request' in on) && !('pull_request_target' in on);
      })
      .map(({ file }) => file);

    expect(pushOnly.length).toBeGreaterThan(0);
    expect(pushOnly.filter((file) => !declared[file])).toEqual([]);
    // Stale entries are as misleading as missing ones: a workflow that gained a
    // pull-request trigger should lose its exemption, not keep a reason nobody
    // rechecks.
    expect(
      Object.keys(declared).filter((file) => !pushOnly.includes(file)),
    ).toEqual([]);
    for (const file of pushOnly) {
      expect(declared[file].length).toBeGreaterThan(20);
    }
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

    // (1) Whatever the wait is, the job must keep the smoke's own running
    // time after it: raising the wait alone moves the red from the reserve
    // step to the job timeout. 25 minutes is the observed smoke duration
    // (af2ae065: 03:45 -> 04:06) with margin.
    expect(smokeBudgetMinutes * 60 - smokeWaitSeconds).toBeGreaterThanOrEqual(
      25 * 60,
    );

    // (2) The Docker-state cleanup is conditional on the isolate step having
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

  it('keeps CI Extended as the dispatch-only full-browser surface without rerunning ci:fast', () => {
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
    // The PR smoke lives in fast-checks; the post-completion duplicate that
    // could only ever run on dispatch is gone (200 of 200 push runs skipped).
    expect(ci).not.toContain('  browser-smoke:');
    expect(extended).toContain('coverage:');
    expect(extended).toContain('playwright-full:');
    expect(extended).not.toContain('run: npm run ci:extended');
    expect(extended).not.toContain('run: npm run ci:fast');
    expect(extended).toContain('run: npm run test:coverage');
    expect(extended).toContain('run: npm run verify:e2e:full');
    // Dispatch only until a run is green; a scheduled red nobody acts on is noise.
    expect(extended).not.toContain('schedule:');
    expect(extended).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(coverage).toContain('needs: playwright-full');
    expect(coverage).toContain(
      "always() && !cancelled() && github.event_name != 'pull_request'",
    );
    expect(playwrightFull).not.toContain('needs: coverage');
    expect(coverage).toContain(
      'runs-on: [self-hosted, Linux, X64, kontour-linux, heavy-host, playwright]',
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

  it('runs sharded coverage sequentially in one capacity-leased job whose deadline holds the lane', () => {
    const entry = readWorkflowDocuments().find(
      ({ file }) => file === '.github/workflows/ci-extended.yml',
    );
    if (!entry)
      throw new Error('Expected the checked-in ci-extended workflow.');
    const job = (
      entry.document as {
        jobs: Record<
          string,
          {
            'timeout-minutes'?: number;
            strategy?: unknown;
            steps: Array<{
              name?: string;
              uses?: string;
              run?: string;
              with?: Record<string, unknown>;
            }>;
          }
        >;
      }
    ).jobs.coverage;
    // One job, no matrix: every fleet runner shares the one physical host, so
    // legs would queue on the lease and repeat all of the setup.
    expect(job.strategy).toBeUndefined();
    const capacity = job.steps.find(({ uses }) =>
      uses?.startsWith('kontourai/.github/actions/physical-host-capacity@'),
    );
    expect(String(capacity?.with?.['lease-weight'])).toBe('9');
    // The coordinated lane must be able to reach its own deadline (and write
    // its receipt) before the job is killed, leaving room for setup.
    const jobTimeoutMs = (job['timeout-minutes'] ?? 0) * 60_000;
    expect(jobTimeoutMs - COVERAGE_LANE_TIMEOUT_MS).toBeGreaterThanOrEqual(
      20 * 60_000,
    );
    const runs = job.steps.map(({ run }) => run ?? '');
    const lane = runs.findIndex(
      (run) => run.trim() === 'npm run test:coverage',
    );
    const prepare = runs.findIndex((run) =>
      run.includes('--phase=browser-prerequisite --phase=sdk-builds'),
    );
    const prepareStatic = runs.findIndex((run) =>
      run.includes('npm run prepare:verify-static'),
    );
    expect(lane).toBeGreaterThan(0);
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(lane);
    expect(prepareStatic).toBe(prepare);
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

  it('runs the nightly gallery gate on gallery-relevant PRs in the same pinned renderer (#2428)', () => {
    type Step = {
      id?: string;
      name?: string;
      uses?: string;
      run?: string;
      if?: string;
      env?: Record<string, unknown>;
      with?: Record<string, unknown>;
      'continue-on-error'?: unknown;
    };
    type Job = {
      needs?: unknown;
      if?: unknown;
      'runs-on'?: unknown;
      container?: unknown;
      env?: unknown;
      defaults?: unknown;
      'timeout-minutes'?: unknown;
      steps: Step[];
    };
    type Doc = {
      on?: Record<string, unknown>;
      permissions?: unknown;
      jobs: Record<string, Job>;
    };
    const documentFor = (file: string) => {
      const entry = readWorkflowDocuments().find(
        (candidate) => candidate.file === `.github/workflows/${file}`,
      );
      if (!entry) throw new Error(`Expected the checked-in ${file}.`);
      return entry.document as Doc;
    };
    const pr = documentFor('gallery-pr-check.yml');
    const nightly = documentFor('nightly-gallery.yml');

    // Trigger: base-controlled pull_request_target only. Not merge_group —
    // the queue-time combination check is #2428's option 2 — and never the
    // candidate-controlled pull_request (actionlint-gate refuses it).
    expect(Object.keys(pr.on ?? {})).toEqual(['pull_request_target']);
    expect(pr.on?.pull_request_target).toEqual({
      branches: ['main'],
      types: ['opened', 'synchronize', 'reopened'],
    });
    expect(pr.permissions).toEqual({ contents: 'read' });
    // The nightly stays a nightly: this check is additive, not a move.
    expect(Object.keys(nightly.on ?? {}).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
    ]);

    // The path filter is the base commit's classifier, not a `paths:` list: a
    // candidate cannot edit the rule that decides whether its screens are
    // photographed, and the scope it asks for is the gallery one.
    expect(Object.keys(pr.jobs).sort()).toEqual(['classify', 'gallery-diff']);
    const classifyRun =
      pr.jobs.classify.steps.find((step) => step.id === 'relevance')?.run ?? '';
    expect(classifyRun).toContain(
      'git show "$BASE_SHA:scripts/classify-ci-change.mjs"',
    );
    expect(classifyRun).toContain('--scope gallery --mode candidate');
    const job = pr.jobs['gallery-diff'];
    expect(job.needs).toBe('classify');
    expect(job.if).toBe("needs.classify.outputs.relevant == 'true'");

    // Renderer parity. The comparator is exact, so a baseline is a claim about
    // one renderer; a PR check in any other container would contradict the
    // nightly on pixels nobody changed. Compare parsed values, so a digest
    // bump in one file alone fails here.
    const nightlyJob = nightly.jobs['screenshot-diff'];
    for (const key of [
      'runs-on',
      'container',
      'env',
      'defaults',
      'timeout-minutes',
    ] as const) {
      expect(job[key], key).toEqual(nightlyJob[key]);
    }
    expect(String((job.container as { image?: unknown })?.image)).toMatch(
      /@sha256:[0-9a-f]{64}$/,
    );

    // Setup parity: every shell step the nightly runs before its capture —
    // toolchain, safe.directory, install, degraded-capture refusal — runs here
    // verbatim, in the same order. A fix to one copy that skips the other
    // would photograph two different builds.
    const nightlyCaptureIndex = nightlyJob.steps.findIndex((step) =>
      step.run?.includes('npm run test:e2e:screenshot'),
    );
    expect(nightlyCaptureIndex).toBeGreaterThan(0);
    const setupRuns = (steps: Step[]) =>
      steps
        .filter((step) => typeof step.run === 'string')
        .map((step) => ({ name: step.name, run: step.run }));
    const nightlySetup = setupRuns(
      nightlyJob.steps.slice(0, nightlyCaptureIndex),
    );
    expect(nightlySetup.length).toBeGreaterThanOrEqual(4);
    const captureIndex = job.steps.findIndex((step) => step.id === 'capture');
    expect(setupRuns(job.steps.slice(0, captureIndex))).toEqual(nightlySetup);
    const nightlyUses = nightlyJob.steps
      .slice(0, nightlyCaptureIndex)
      .map((step) => step.uses)
      .filter(Boolean);
    expect(
      job.steps
        .slice(0, captureIndex)
        .map((step) => step.uses)
        .filter(Boolean),
    ).toEqual(nightlyUses);

    // Capture, then the exact diff, as separate steps so a failure names its
    // half; nothing up to the upload may swallow a failure.
    const diffIndex = job.steps.findIndex((step) => step.id === 'diff');
    expect(job.steps[captureIndex]?.run).toBe('npm run test:e2e:screenshot');
    expect(job.steps[diffIndex]?.run).toBe('npm run screenshot:diff');
    expect(diffIndex).toBe(captureIndex + 1);
    const uploadIndex = job.steps.findIndex((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(uploadIndex).toBeGreaterThan(diffIndex);
    for (const step of job.steps.slice(0, uploadIndex)) {
      expect(step['continue-on-error'], step.name).toBeUndefined();
    }

    // The artifact is the ONLY sanctioned baseline source, so it must exist
    // on failure and carry the gallery directory at its root (capture.json
    // plus PNGs), which is what `screenshot-diff.mjs baseline --gallery=`
    // reads. run_attempt keeps a re-run from colliding on the name.
    const upload = job.steps[uploadIndex];
    const nightlyUpload = nightlyJob.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(upload.uses).toBe(nightlyUpload?.uses);
    expect(upload.if).toBe('always()');
    expect(upload.with?.path).toBe('gallery/');
    const artifactName = `gallery-pr-\${{ github.run_id }}-\${{ github.run_attempt }}`;
    expect(upload.with?.name).toBe(artifactName);

    // The refresh instructions name that same artifact and the command that
    // turns it into a baseline, and appear only when the DIFF failed; a
    // capture failure gets the opposite advice.
    const refresh = job.steps.find(
      (step) => step.name === 'Explain how to refresh the baseline',
    );
    expect(refresh?.if).toBe("failure() && steps.diff.outcome == 'failure'");
    expect(refresh?.env?.ARTIFACT).toBe(artifactName);
    expect(refresh?.run).toContain(
      `gh run download \${RUN_ID} --repo \${REPOSITORY} --name \${ARTIFACT}`,
    );
    expect(refresh?.run).toContain('npm run screenshot:baseline -- --gallery=');
    const pkg = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts['screenshot:baseline']).toBe(
      'node scripts/screenshot-diff.mjs baseline',
    );
    const captureFailed = job.steps.find(
      (step) => step.name === 'Explain a capture that did not complete',
    );
    expect(captureFailed?.if).toBe(
      "failure() && steps.capture.outcome == 'failure'",
    );
    expect(captureFailed?.run).toContain('do NOT re-baseline');
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

  it('runs browser smoke once, inside fast-checks, on every event', () => {
    // A second smoke job gated on full-regression (without always()) was
    // skipped on every push and merge_group run and only repeated this step
    // on dispatch. fast-checks runs on dispatch too, so dispatch keeps it.
    const ci = workflow('ci.yml');
    const jobs = (load(ci) as { jobs: Record<string, unknown> }).jobs;
    const smokeJobs = Object.entries(jobs)
      .filter(([, job]) => JSON.stringify(job).includes('test:e2e:pr-smoke'))
      .map(([id]) => id);
    expect(smokeJobs).toEqual(['fast-checks']);
    expect(String((jobs['fast-checks'] as { if?: string }).if)).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
  });

  it('fences every job that runs ci:fast around the lane budget plus its other bounded steps', () => {
    // #2577: the lane budget and each job fence are separate literals. Raising
    // the lane alone lets a job be killed before the coordinator's own
    // deadline fires and writes its receipt, so each fence must contain the
    // lane's budget, every other step's own bound, and the unbounded
    // setup/post steps (checkout, dependencies:ci, build:ui, ...; ~2 minutes
    // observed across 88 hosted fast-checks runs, budgeted at three). Jobs
    // are found by what they run, not by name, so a new caller (fork-smoke
    // was the one first missed) is covered without editing this test.
    type Step = { run?: string; 'timeout-minutes'?: number };
    type Job = { 'timeout-minutes'?: number; steps?: Step[] };
    const runsCiFast = (step: Step) =>
      typeof step.run === 'string' &&
      /(^|[\s;&|])npm run ci:fast(?![\w:-])/.test(step.run);
    const callers = readWorkflowDocuments().flatMap(({ file, document }) =>
      Object.entries(
        ((document as { jobs?: Record<string, Job> } | null)?.jobs ??
          {}) as Record<string, Job>,
      )
        .filter(([, job]) => (job.steps ?? []).some(runsCiFast))
        .map(([jobId, job]) => ({ id: `${file}#${jobId}`, job })),
    );
    expect(callers.map(({ id }) => id).sort()).toEqual([
      '.github/workflows/ci.yml#fast-checks',
      '.github/workflows/ci.yml#fork-smoke',
    ]);
    const unboundedAllowanceMs = 3 * 60_000;
    for (const { id, job } of callers) {
      const steps = job.steps ?? [];
      const lane = steps.filter(runsCiFast);
      expect(lane, id).toHaveLength(1);
      // The lane step is bounded by its coordinator deadline, not a step
      // timeout; a step timeout below it would kill it first.
      expect(lane[0]['timeout-minutes'], id).toBeUndefined();
      const boundedStepsMs = steps.reduce(
        (sum, step) => sum + (step['timeout-minutes'] ?? 0) * 60_000,
        0,
      );
      expect((job['timeout-minutes'] ?? 0) * 60_000, id).toBeGreaterThanOrEqual(
        CI_FAST_TIMEOUT_MS + boundedStepsMs + unboundedAllowanceMs,
      );
    }
  });

  it('keeps fast feedback bounded and composes the full merge gate separately', () => {
    const ci = workflow('ci.yml');
    const fastChecks = ci.slice(
      ci.indexOf('  fast-checks:'),
      ci.indexOf('  fork-smoke:'),
    );
    const fullRegression = ci.slice(
      ci.indexOf('  full-regression:'),
      ci.indexOf('  manual-completion-diagnostics:'),
    );

    expect(fastChecks).toContain(
      `timeout-minutes: ${FAST_CHECKS_JOB_TIMEOUT_MINUTES}`,
    );
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
      'windows-vitest-diagnostic.yml',
      'container-smoke.yml',
    ].flatMap((name) =>
      [...workflow(name).matchAll(/^\s+lease-weight: ["']?(\d+)["']?$/gm)].map(
        ([, weight]) => Number(weight),
      ),
    );
    expect(desktopWinLeaseWeights).toEqual([6, 6, 6, 9, 9]);
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
    for (const name of ['ci.yml', 'ci-extended.yml']) {
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
    const fastChecks = ci.slice(
      ci.indexOf('  fast-checks:'),
      ci.indexOf('  fork-smoke:'),
    );
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
      // The coverage corpus includes real-Chromium geometry tests, and its
      // lane checks for the pinned browser before any slice runs.
      [
        coverage,
        'coverage',
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

    // fast-checks (which now owns the only PR browser smoke) uses the same
    // convention — asserted here so a future edit that regresses it back
    // toward node_modules is caught by the same test.
    const fastChecksRunBody = extractRunBodies(fastChecks);
    expect(fastChecksRunBody).toContain(envExport);
    expect(fastChecks).toContain(envExport);
    expect(fastChecksRunBody).not.toMatch(inNodeModulesPathZero);
    // The browser must be installed before the lane that requires it runs.
    const coverageRunBody = extractRunBodies(coverage);
    expect(coverageRunBody.indexOf('npm run test:coverage')).toBeGreaterThan(
      coverageRunBody.indexOf(
        'node scripts/install-playwright-browsers.mjs chromium',
      ),
    );
  });

  it('checks out enough history for exact candidate and completion identities', () => {
    const ci = workflow('ci.yml');
    const fastChecks = ci.slice(
      ci.indexOf('  fast-checks:'),
      ci.indexOf('  fork-smoke:'),
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
      'gallery-pr-check.yml',
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

  it('runs the bounded Windows floor on every PR head from base-controlled hosted policy', () => {
    const windows = workflow('windows-pr-verification.yml');
    const document = load(windows) as {
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            if?: string;
            uses?: string;
            run?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
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
    // tsc's verdict is OS-independent and ci:fast's typecheck aggregate owns
    // it; repeating it here only lengthened the required check. The policy
    // gate above stays: it is the only Windows run of the policy scripts.
    const windowsRuns = document.jobs['windows-pr-portable'].steps.map((step) =>
      String(step.run ?? ''),
    );
    expect(windowsRuns.filter((run) => /\btypecheck\b/.test(run))).toEqual([]);
    expect(windows).toContain(
      'run: npm run gate:naming && npm run gate:ui-contracts',
    );
    // The cargo compile is skipped only on an exact base-controlled `false`.
    // The job itself has no condition: a skipped job would leave the required
    // `Windows PR portable floor` check to GitHub's skipped-counts-as-success.
    const floorJob = document.jobs['windows-pr-portable'] as {
      if?: string;
      steps: Array<{ id?: string; name?: string; if?: string; run?: string }>;
    };
    expect(floorJob.if).toBeUndefined();
    const relevance = floorJob.steps.find(
      (step) => step.id === 'rust_relevance',
    );
    expect(relevance?.run).toContain(
      '$BASE_SHA:scripts/classify-ci-change.mjs',
    );
    expect(relevance?.run).toContain('--scope desktop-rust --mode candidate');
    expect(relevance?.run).toContain('fail_closed');
    const compile = floorJob.steps.find(
      (step) => step.name === 'Compile desktop Rust tests',
    );
    expect(compile?.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      "${{ steps.rust_relevance.outputs.relevant != 'false' }}",
    );
    const relevanceIndex = floorJob.steps.findIndex(
      (step) => step.id === 'rust_relevance',
    );
    // Before ANY candidate code: an earlier `npm run` can rewrite
    // $GITHUB_PATH/$GITHUB_ENV and hand this "base-controlled" classifier a
    // fake node or git that prints whatever the candidate wants.
    const firstCandidateRun = floorJob.steps.findIndex((step) =>
      /\bnpm run\b|\bcargo\b/.test(String(step.run ?? '')),
    );
    expect(relevanceIndex).toBeGreaterThan(-1);
    expect(firstCandidateRun).toBeGreaterThan(-1);
    expect(relevanceIndex).toBeLessThan(firstCandidateRun);
    expect(relevanceIndex).toBeLessThan(
      floorJob.steps.findIndex(
        (step) => step.name === 'Compile desktop Rust tests',
      ),
    );
    const upload = document.jobs['windows-pr-portable'].steps.find(
      (step) => step.name === 'Upload Windows portable verification evidence',
    );
    expect(upload).toMatchObject({
      if: 'always()',
      with: {
        'include-hidden-files': true,
        'if-no-files-found': 'warn',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
        name: expect.stringContaining('${{ github.run_attempt }}'),
      },
    });
    expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(String(upload?.with?.path)).toContain(
      '.kontourai/verification-receipts/',
    );
    expect(String(upload?.with?.path)).toContain(
      '.kontourai/verification-output/',
    );
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
    ['gallery-pr-check.yml', 'gallery-pr-'],
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
    'ios-rust-cache-warm.yml',
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
    // The queue fast-forwards main to the candidate it built (merge_group run
    // 35778933116 and push run 35781390232 built the same SHA), so a push
    // trigger only repeats a finished macOS build. Dispatch covers the rest.
    const triggers = Object.keys(
      (load(ios) as { on: Record<string, unknown> }).on,
    ).sort();
    expect(triggers).toEqual([
      'merge_group',
      'pull_request_target',
      'workflow_dispatch',
    ]);
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

  it('starts the simulator booting before the build without trusting that boot', () => {
    const document = load(ios) as {
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            run?: string;
            'continue-on-error'?: boolean;
            'working-directory'?: string;
          }>;
        }
      >;
    };
    const steps = document.jobs['build-ios-verification'].steps;
    const preboot = steps.findIndex((step) =>
      String(step.run ?? '').includes('--preboot'),
    );
    const xcode = steps.findIndex((step) =>
      String(step.run ?? '').includes('xcode-select -s'),
    );
    const build = steps.findIndex((step) =>
      String(step.run ?? '').includes('npx tauri ios build'),
    );
    const smoke = steps.findIndex((step) =>
      String(step.run ?? '').includes('npm run test:ios-runtime-smoke --'),
    );
    // After the Xcode selection (simctl must be the reviewed Xcode's), before
    // the build it overlaps, and before the smoke that waits on it.
    expect(xcode).toBeGreaterThan(-1);
    expect(preboot).toBeGreaterThan(xcode);
    expect(preboot).toBeLessThan(build);
    expect(build).toBeLessThan(smoke);
    // A failed pre-boot must not fail the job on its own: the smoke's own
    // boot path is the fallback, and it fails the run if it cannot boot.
    expect(steps[preboot]['continue-on-error']).toBe(true);
    // Same exact device: neither invocation overrides the smoke's defaults.
    for (const index of [preboot, smoke]) {
      expect(steps[index].run).not.toContain('--device');
      expect(steps[index].run).not.toContain('--runtime');
    }
  });

  it('runs the native accessibility smoke and always retains its evidence', () => {
    expect(ios).toContain('npm run test:ios-runtime-smoke --');
    expect(ios).toContain('station-ios-simulator-runtime');
    const evidence = ios.indexOf('name: Upload iOS runtime evidence');
    expect(evidence).toBeGreaterThan(-1);
    expect(ios.slice(evidence - 120, evidence + 500)).toContain('if: always()');
  });
});

describe('the iOS Rust cache is written by main and only restored by PRs', () => {
  type Step = {
    id?: string;
    if?: string;
    uses?: string;
    run?: string;
    with?: Record<string, unknown>;
    'working-directory'?: string;
  };
  type Doc = {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<string, { 'runs-on': string; steps: Step[] }>;
  };
  const ios = load(workflow('build-ios.yml')) as Doc;
  const warmer = load(workflow('ios-rust-cache-warm.yml')) as Doc;
  const iosSteps = ios.jobs['build-ios-verification'].steps;
  const warmSteps = warmer.jobs.warm.steps;
  const CACHE_PREFIX = 'actions/cache';
  const byUses = (steps: Step[], prefix: string) =>
    steps.filter((step) => String(step.uses ?? '').startsWith(prefix));
  const runOf = (steps: Step[], needle: string) =>
    steps.filter((step) => String(step.run ?? '').includes(needle));

  it('never saves from the pull-request / merge-queue workflow', () => {
    const cacheSteps = byUses(iosSteps, CACHE_PREFIX);
    expect(cacheSteps.map((step) => step.uses)).toEqual([
      'actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
    ]);
    // Parsed, not grepped: the workflow's own comments name what it refuses.
    for (const [jobId, job] of Object.entries(ios.jobs)) {
      expect(Object.hasOwn(job, 'cache-mode'), jobId).toBe(false);
      const writers = job.steps.filter((step) => {
        const uses = String(step.uses ?? '');
        return (
          (uses.startsWith(CACHE_PREFIX) &&
            !uses.startsWith('actions/cache/restore@')) ||
          (uses.startsWith('actions/setup-node@') &&
            step.with?.cache !== undefined)
        );
      });
      expect(writers, jobId).toEqual([]);
    }
    expect(Object.hasOwn(ios, 'cache-mode')).toBe(false);
  });

  it('saves only from trusted main events, after a lookup that skips warm keys', () => {
    expect(Object.keys(warmer.on).sort()).toEqual([
      'push',
      'schedule',
      'workflow_dispatch',
    ]);
    expect((warmer.on.push as { branches: string[] }).branches).toEqual([
      'main',
    ]);
    expect(warmer.permissions).toEqual({ contents: 'read' });
    expect(warmer.jobs.warm['runs-on']).toBe(
      ios.jobs['build-ios-verification']['runs-on'],
    );
    const saves = byUses(warmSteps, 'actions/cache/save@');
    expect(saves).toHaveLength(1);
    expect(saves[0].if).toBe(
      "github.ref == 'refs/heads/main' && steps.lookup.outputs.cache-hit != 'true'",
    );
    const lookup = warmSteps.find((step) => step.id === 'lookup');
    expect(lookup?.with?.['lookup-only']).toBe(true);
  });

  it('keys and paths the restore exactly as the warmer saves them', () => {
    const [restore] = byUses(iosSteps, 'actions/cache/restore@');
    const lookup = warmSteps.find((step) => step.id === 'lookup');
    const [save] = byUses(warmSteps, 'actions/cache/save@');
    expect(restore.with?.key).toBe(lookup?.with?.key);
    expect(save.with?.key).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      '${{ steps.lookup.outputs.cache-primary-key }}',
    );
    expect(restore.with?.path).toBe(lookup?.with?.path);
    expect(save.with?.path).toBe(restore.with?.path);
    const key = String(restore.with?.key);
    for (const part of [
      'runner.os',
      'runner.arch',
      'steps.rust.outputs.cachekey',
      'aarch64-apple-ios-sim',
      "hashFiles('src-desktop/Cargo.lock')",
    ])
      expect(key).toContain(part);
    expect(String(restore.with?.['restore-keys']).trim()).toBe(
      key.slice(0, key.indexOf('${{ hashFiles')),
    );
  });

  it('builds with the same toolchain, Xcode and commands the restore serves', () => {
    // Cargo fingerprints include target, profile, env and paths: an entry
    // from a different invocation restores but rebuilds everything.
    const toolchain = (steps: Step[]) =>
      byUses(steps, 'dtolnay/rust-toolchain@').map((step) => [
        step.id,
        step.uses,
        step.with,
      ]);
    expect(toolchain(warmSteps)).toEqual(toolchain(iosSteps));
    expect(toolchain(iosSteps)).toHaveLength(1);
    for (const needle of [
      'sudo xcode-select -s /Applications/Xcode_26.6.app/Contents/Developer',
      'brew install xcodegen',
      'npm run dependencies:ci && npm run build:native-client',
      'npx tauri ios init',
      'node scripts/write-ios-build-manifest.mjs',
      'npx tauri ios build',
    ]) {
      const iosRuns = runOf(iosSteps, needle);
      const warmRuns = runOf(warmSteps, needle);
      expect(iosRuns, needle).toHaveLength(1);
      expect(warmRuns, needle).toHaveLength(1);
      const line = (step: Step) =>
        String(step.run)
          .split('\n')
          .find((candidate) => candidate.includes(needle));
      expect(line(warmRuns[0]), needle).toBe(line(iosRuns[0]));
      expect(warmRuns[0]['working-directory'], needle).toBe(
        iosRuns[0]['working-directory'],
      );
    }
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

describe('merge-queue regression workflow covers the full regression', () => {
  type Step = {
    name?: string;
    run?: string;
    env?: Record<string, string>;
    uses?: string;
    if?: string;
    shell?: string;
    'continue-on-error'?: unknown;
  };
  type Defaults = { run?: { shell?: string } };
  type Job = {
    name?: string;
    if?: string;
    needs?: string[];
    defaults?: Defaults;
    strategy?: { matrix?: { include?: Array<Record<string, string>> } };
    steps?: Step[];
    'continue-on-error'?: unknown;
  };
  type Workflow = { defaults?: Defaults; jobs: Record<string, Job> };
  function document() {
    const entry = readWorkflowDocuments().find(
      (candidate) =>
        candidate.file === '.github/workflows/merge-queue-regression.yml',
    );
    expect(entry, 'merge-queue-regression.yml must exist').toBeDefined();
    return entry?.document as Workflow;
  }

  const DRIVER = 'node scripts/run-full-regression-phases.mjs';
  const MATRIX_PHASES = `\${{ matrix.phases }}`;

  // Executed shell lines only: comment lines are dropped, and a line counts
  // as a driver call only when it STARTS with the driver command, so an
  // `echo` or a commented-out invocation selects nothing.
  function executedLines(run: string | undefined) {
    return (run ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  }

  // The phase selections the workflow actually executes. A `PHASES` env or a
  // matrix entry counts only when its step reads it into the driver's argv;
  // a literal driver line counts as written.
  function driverSteps(jobs: Record<string, Job>) {
    const found: Array<{
      job: string;
      step: Step;
      texts: string[];
      consumesPhases: boolean;
    }> = [];
    for (const [job, definition] of Object.entries(jobs)) {
      for (const step of definition.steps ?? []) {
        const lines = executedLines(step.run);
        const calls = lines.filter((line) => line.startsWith(DRIVER));
        if (calls.length === 0) continue;
        const texts: string[] = [];
        let consumesPhases = false;
        for (const call of calls) {
          if (call.startsWith(`${DRIVER} "\${phases[@]}"`)) {
            consumesPhases = lines.includes('read -r -a phases <<< "$PHASES"');
            if (!consumesPhases) continue;
            const phases = step.env?.PHASES;
            if (phases === MATRIX_PHASES)
              for (const entry of definition.strategy?.matrix?.include ?? [])
                texts.push(entry.phases ?? '');
            else if (phases) texts.push(phases);
          } else texts.push(call);
        }
        found.push({ job, step, texts, consumesPhases });
      }
    }
    return found;
  }

  function selections(jobs: Record<string, Job>) {
    return driverSteps(jobs).flatMap(({ job, texts }) =>
      texts.map((text) => ({ job, text })),
    );
  }

  function phaseIds(text: string) {
    return [...text.matchAll(/--phase=([A-Za-z0-9-]+)/g)].map(
      (match) => match[1],
    );
  }

  it('selects exactly the FULL_REGRESSION_PHASES ids, so a new phase fails until the queue runs it', () => {
    const covered = new Set(
      selections(document().jobs).flatMap(({ text }) => phaseIds(text)),
    );
    expect([...covered].sort()).toEqual(
      FULL_REGRESSION_PHASES.map(({ id }) => id).sort(),
    );
    // Every resource class in the corpus runner reaches the queue through a
    // phase: the ordinary shards and each serialized group.
    for (const group of VITEST_CORPUS_GROUP_NAMES)
      expect(
        [...covered].some(
          (id) =>
            id === `test-full-${group}` || id.startsWith(`test-full-${group}-`),
        ),
        `corpus group ${group}`,
      ).toBe(true);
  });

  it('runs every ordinary shard exactly once', () => {
    const ordinary = selections(document().jobs)
      .flatMap(({ text }) => phaseIds(text))
      .filter((id) => id.startsWith('test-full-ordinary-'));
    const expected = FULL_REGRESSION_PHASES.map(({ id }) => id).filter((id) =>
      id.startsWith('test-full-ordinary-'),
    );
    expect(expected).toHaveLength(8);
    expect([...ordinary].sort()).toEqual([...expected].sort());
  });

  it('splits process-heavy into slices that cover the group exactly once', () => {
    const heavy = selections(document().jobs).filter(({ text }) =>
      phaseIds(text).includes('test-full-process-heavy'),
    );
    const shards = heavy.map(({ text }) => {
      const match = /--process-heavy-shard=(\d+)\/(\d+)/.exec(text);
      expect(match, `process-heavy without a slice: ${text}`).not.toBeNull();
      return { index: Number(match?.[1]), count: Number(match?.[2]) };
    });
    expect(shards.length).toBeGreaterThanOrEqual(2);
    const counts = new Set(shards.map(({ count }) => count));
    expect(counts.size).toBe(1);
    expect(shards.map(({ index }) => index).sort((a, b) => a - b)).toEqual(
      Array.from({ length: shards[0].count }, (_, index) => index + 1),
    );
  });

  it('runs phases only through the driver and gates on one aggregate check', () => {
    const { jobs } = document();
    const text = workflow('merge-queue-regression.yml');
    expect(text).not.toMatch(/:raw\b/);
    const aggregate = jobs['merge-queue-regression'];
    expect(aggregate.name).toBe('Merge-queue regression');
    expect(aggregate.if).toBe(
      "always() && github.event_name != 'pull_request_target'",
    );
    const testJobs = Object.keys(jobs).filter(
      (job) => job !== 'merge-queue-regression',
    );
    expect([...(aggregate.needs ?? [])].sort()).toEqual([...testJobs].sort());
    for (const job of testJobs)
      expect(jobs[job].if, job).toBe(
        "github.event_name != 'pull_request_target'",
      );
    expect(jobs['android-viewport'].steps?.map(({ run }) => run)).toContain(
      'npm run test:android',
    );
  });

  it('keeps every driver step on the failure path: pipefail before tee, no if, no continue-on-error', () => {
    const steps = driverSteps(document().jobs);
    // static, 4 ordinary, 2 process-heavy, exclusive each have a Run step;
    // the three corpus job kinds also have a prerequisite step.
    expect(steps.filter(({ texts }) => texts.length > 0).length).toBe(
      steps.length,
    );
    const runSteps = steps.filter(({ step }) =>
      executedLines(step.run).some((line) => line.includes('| tee')),
    );
    expect(runSteps.map(({ job }) => job).sort()).toEqual([
      'exclusive',
      'ordinary',
      'process-heavy',
      'static',
    ]);
    for (const { job, step, consumesPhases } of steps) {
      expect(step.if, `${job}: ${step.name}`).toBeUndefined();
      expect(step['continue-on-error'], `${job}: ${step.name}`).toBeUndefined();
      const lines = executedLines(step.run);
      const tee = lines.findIndex((line) => line.includes('| tee'));
      if (tee >= 0) {
        const pipefail = lines.indexOf('set -o pipefail');
        expect(pipefail, `${job}: pipefail`).toBeGreaterThanOrEqual(0);
        expect(pipefail, `${job}: pipefail precedes tee`).toBeLessThan(tee);
        expect(consumesPhases, `${job}: Run step reads PHASES`).toBe(true);
      }
    }
    // The matrix jobs feed their Run step from the matrix itself.
    for (const job of ['ordinary', 'process-heavy'])
      expect(
        runSteps.find((entry) => entry.job === job)?.step.env?.PHASES,
      ).toBe(MATRIX_PHASES);
  });

  // Shell lines with `\` continuations joined, so a swallow written on the
  // `| tee` continuation still belongs to the driver line it continues.
  function logicalLines(run: string | undefined) {
    const joined: string[] = [];
    let pending = '';
    for (const line of executedLines(run)) {
      if (line.endsWith('\\')) pending += `${line.slice(0, -1).trim()} `;
      else {
        joined.push(`${pending}${line}`);
        pending = '';
      }
    }
    if (pending) joined.push(pending.trim());
    return joined;
  }

  // GitHub's `bash` keyword runs `bash --noprofile --norc -eo pipefail {0}`;
  // an unset shell is `bash -e {0}`. Any other override must keep both
  // errexit and pipefail, or a failed driver can exit its step green.
  function shellKeepsFailures(shell: string | undefined) {
    if (shell === undefined || shell === 'bash') return true;
    return (
      /(^|\s)bash(\s|$)/.test(shell) &&
      /(^|\s)-[a-z]*e[a-z]*(\s|$)/.test(shell) &&
      /\bpipefail\b/.test(shell)
    );
  }

  // Shell code (quotes and comments removed, see shellCode) that can turn a
  // failed command into a green step: disabling errexit/pipefail, an
  // explicit success exit anywhere, a trap that can rewrite the exit status,
  // and a backgrounded command whose status the step never collects.
  // Redirections (`2>&1`, `&>`, `>&2`) and `&&` are not backgrounding.
  const SWALLOWS: Array<[string, RegExp]> = [
    ['set +e', /\bset\s+\+[a-z]*e/],
    ['set +o errexit/pipefail', /\bset\s+\+o\s+(errexit|pipefail)\b/],
    ['exit 0', /\bexit\s+0\b/],
    ['trap', /(^|[\s;&|(])trap\b/],
    ['backgrounded command (&)', /(^|[^&>|<])&(?![&>])/],
  ];

  // Quoted text and trailing comments are data, not control flow: an
  // `echo "a || b"` or a jq filter must not read as an `||`.
  function shellCode(line: string) {
    let code = '';
    let quote: string | null = null;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quote) {
        if (quote === '"' && char === '\\') index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        code += ' ';
      } else if (char === '#' && (index === 0 || /\s/.test(line[index - 1])))
        break;
      else code += char;
    }
    return code;
  }

  // The one accepted `||`: a fallback that still fails the step,
  // `|| exit N` or `|| { ...; exit N; }` with N non-zero.
  const FAIL_LOUD =
    /^\s*(?:exit\s+[1-9][0-9]*|\{[^{}]*;\s*exit\s+[1-9][0-9]*\s*;?\s*\})\s*$/;

  function swallowingOr(line: string) {
    const segments = shellCode(line).split('||');
    return segments.slice(1).some((segment) => !FAIL_LOUD.test(segment));
  }

  function runSwallows(run: string | undefined) {
    const lines = logicalLines(run);
    const found = SWALLOWS.filter(([, pattern]) =>
      lines.some((line) => pattern.test(shellCode(line))),
    ).map(([label]) => label);
    for (const line of lines)
      if (swallowingOr(line)) found.push(`'||' swallows a failure: ${line}`);
    return found;
  }

  // The only steps exempt from the gate rules: `if: failure()` diagnostics.
  // They run only after the job has already failed, so they cannot make it
  // green -- unless the gate's own test command is moved into one, where it
  // would never run at all.
  // A test command: the phase driver, or an `npm run test:*` suite.
  const GATE_COMMAND = new RegExp(
    `(^|\\s)(${DRIVER.replaceAll('.', '\\.')}|npm run test:)`,
  );
  function isFailureDiagnostic(step: Step) {
    return step.if === 'failure()';
  }

  // One step's gate violations, and whether it runs a test command.
  function stepViolations(
    step: Step,
    where: string,
    inheritedShell: string | undefined,
  ) {
    const runsGateCommand = logicalLines(step.run).some((line) =>
      GATE_COMMAND.test(shellCode(line)),
    );
    if (isFailureDiagnostic(step))
      return {
        runsGateCommand: false,
        violations: runsGateCommand
          ? [`${where}: a gate command in an if: failure() step`]
          : [],
      };
    const violations: string[] = [];
    if (step['continue-on-error'] !== undefined)
      violations.push(`${where}: continue-on-error`);
    if (step.if !== undefined)
      violations.push(`${where}: if: ${step.if} can skip a gated step`);
    if (step.run !== undefined) {
      const shell = step.shell ?? inheritedShell;
      if (!shellKeepsFailures(shell))
        violations.push(`${where}: shell '${shell}' drops -e or pipefail`);
      for (const swallow of runSwallows(step.run))
        violations.push(`${where}: ${swallow}`);
    }
    return { runsGateCommand, violations };
  }

  /**
   * Every way a gate job could report success without its tests passing.
   * The aggregate's `needs` are the gate jobs; the aggregate itself is one
   * too. Every step in them is gated except `if: failure()` diagnostics.
   */
  function swallowedFailures(workflowDocument: Workflow) {
    const { jobs } = workflowDocument;
    const violations: string[] = [];
    const aggregateName = 'merge-queue-regression';
    const aggregate = jobs[aggregateName];
    for (const name of [...(aggregate?.needs ?? []), aggregateName]) {
      const job = jobs[name];
      if (!job) continue;
      if (job['continue-on-error'] !== undefined)
        violations.push(`${name}: job-level continue-on-error`);
      const inheritedShell =
        job.defaults?.run?.shell ?? workflowDocument.defaults?.run?.shell;
      let gatedTestCommands = 0;
      for (const step of job.steps ?? []) {
        const where = `${name}: ${step.name ?? step.uses ?? step.run?.split('\n')[0]}`;
        const result = stepViolations(step, where, inheritedShell);
        if (result.runsGateCommand) gatedTestCommands += 1;
        violations.push(...result.violations);
      }
      if (name !== aggregateName && gatedTestCommands === 0)
        violations.push(`${name}: no gated step runs a test command`);
    }
    // The aggregate's verdict is jq's exit status; without `-e` jq exits 0
    // for a `false` result.
    const verdict = (aggregate?.steps ?? []).map(({ run }) => run ?? '');
    if (!verdict.some((run) => /\bjq -e\b/.test(run)))
      violations.push('merge-queue-regression: no jq -e verdict');
    return violations;
  }

  it('lets no gate job swallow a failed driver (false-positive control on the real workflow)', () => {
    expect(swallowedFailures(document())).toEqual([]);
    // An explicit shell that keeps errexit and pipefail is not a swallow.
    const explicit = structuredClone(document());
    for (const job of Object.values(explicit.jobs))
      for (const step of job.steps ?? []) step.shell = 'bash';
    explicit.jobs.static.defaults = {
      run: { shell: 'bash --noprofile --norc -eo pipefail {0}' },
    };
    expect(swallowedFailures(explicit)).toEqual([]);
    // A fallback that still fails the step is not a swallow, and `||` inside
    // quotes or a comment is not control flow.
    const loud = structuredClone(document());
    const prepare = loud.jobs.ordinary.steps?.find(
      ({ name }) => name === 'Prepare the corpus prerequisites',
    ) as Step;
    prepare.run = [
      'npm run prepare:verify-static || { echo "::error::prepare failed || stop"; exit 1; }',
      'npm run dependencies:verify || exit 2',
      "echo 'a || b' # || true",
      // Quoted or commented swallow text is data, and redirections are not
      // backgrounding.
      'echo "never exit 0 here; trap nothing &" >&2 # exit 0',
      'npm run dependencies:verify 2>&1 &>/dev/null && echo ok',
    ].join('\n');
    expect(swallowedFailures(loud)).toEqual([]);
  });

  it('catches every known way to swallow a driver failure (known-bad controls)', () => {
    const runStep = (workflowDocument: Workflow, job: string) => {
      const step = workflowDocument.jobs[job].steps?.find(
        ({ name }) => name === 'Run full-regression phases',
      );
      expect(step, job).toBeDefined();
      return step as Step;
    };
    const androidStep = (workflowDocument: Workflow) =>
      workflowDocument.jobs['android-viewport'].steps?.find(
        ({ run }) => run === 'npm run test:android',
      ) as Step;
    const mutated = (mutate: (workflowDocument: Workflow) => void) => {
      const copy = structuredClone(document());
      mutate(copy);
      return swallowedFailures(copy);
    };
    const onTee = (suffix: string) => (workflowDocument: Workflow) => {
      const step = runStep(workflowDocument, 'ordinary');
      step.run = step.run?.replace(
        '| tee "$RUNNER_TEMP/merge-queue-regression.log"',
        `| tee "$RUNNER_TEMP/merge-queue-regression.log"${suffix}`,
      );
    };
    const cases: Array<[string, (workflowDocument: Workflow) => void, RegExp]> =
      [
        ['|| true', onTee(' || true'), /ordinary: .*'\|\|' swallows/],
        ['|| :', onTee(' || :'), /ordinary: .*'\|\|' swallows/],
        ['; exit 0', onTee('; exit 0'), /ordinary: .*exit 0/],
        [
          'set +e',
          (workflowDocument) => {
            const step = runStep(workflowDocument, 'static');
            step.run = `set +e\n${step.run}`;
          },
          /static: .*set \+e/,
        ],
        [
          'set +o pipefail',
          (workflowDocument) => {
            const step = runStep(workflowDocument, 'exclusive');
            step.run = `${step.run}\nset +o pipefail`;
          },
          /exclusive: .*set \+o errexit\/pipefail/,
        ],
        [
          'a trailing exit 0 line',
          (workflowDocument) => {
            const step = runStep(workflowDocument, 'process-heavy');
            step.run = `${step.run}\nexit 0`;
          },
          /process-heavy: .*exit 0/,
        ],
        [
          'shell sh',
          (workflowDocument) => {
            runStep(workflowDocument, 'static').shell = 'sh {0}';
          },
          /static: .*shell 'sh \{0\}' drops/,
        ],
        [
          'shell without -e',
          (workflowDocument) => {
            runStep(workflowDocument, 'static').shell =
              'bash --noprofile --norc -o pipefail {0}';
          },
          /static: .*drops -e or pipefail/,
        ],
        [
          'shell without pipefail',
          (workflowDocument) => {
            runStep(workflowDocument, 'static').shell = 'bash -e {0}';
          },
          /static: .*drops -e or pipefail/,
        ],
        [
          'job defaults shell',
          (workflowDocument) => {
            workflowDocument.jobs.exclusive.defaults = {
              run: { shell: 'bash {0}' },
            };
          },
          /exclusive: .*shell 'bash \{0\}'/,
        ],
        [
          'workflow defaults shell',
          (workflowDocument) => {
            workflowDocument.defaults = { run: { shell: 'sh {0}' } };
          },
          /merge-queue-regression: .*shell 'sh \{0\}'/,
        ],
        [
          'job-level continue-on-error on a gate job',
          (workflowDocument) => {
            workflowDocument.jobs.ordinary['continue-on-error'] =
              `\${{ matrix.experimental }}`;
          },
          /^ordinary: job-level continue-on-error$/,
        ],
        [
          'continue-on-error on the aggregate job',
          (workflowDocument) => {
            workflowDocument.jobs['merge-queue-regression'][
              'continue-on-error'
            ] = true;
          },
          /^merge-queue-regression: job-level continue-on-error$/,
        ],
        [
          'a swallowed aggregate verdict',
          (workflowDocument) => {
            const [step] =
              workflowDocument.jobs['merge-queue-regression'].steps ?? [];
            step.run = step.run?.replace('> /dev/null', '> /dev/null || true');
          },
          /merge-queue-regression: .*'\|\|' swallows/,
        ],
        [
          'an aggregate verdict without jq -e',
          (workflowDocument) => {
            const [step] =
              workflowDocument.jobs['merge-queue-regression'].steps ?? [];
            step.run = step.run?.replace('jq -e', 'jq');
          },
          /^merge-queue-regression: no jq -e verdict$/,
        ],
        [
          'continue-on-error on the android viewport step',
          (workflowDocument) => {
            androidStep(workflowDocument)['continue-on-error'] = true;
          },
          /^android-viewport: Run Android viewport tests: continue-on-error$/,
        ],
        [
          'if: always() on the android viewport step',
          (workflowDocument) => {
            androidStep(workflowDocument).if = 'always()';
          },
          /^android-viewport: Run Android viewport tests: if: always\(\)/,
        ],
        [
          'shell sh on the android viewport step',
          (workflowDocument) => {
            androidStep(workflowDocument).shell = 'sh {0}';
          },
          /^android-viewport: Run Android viewport tests: shell 'sh \{0\}'/,
        ],
        [
          'the android test moved into an if: failure() step',
          (workflowDocument) => {
            androidStep(workflowDocument).if = 'failure()';
          },
          /android-viewport: .*gate command in an if: failure\(\) step/,
        ],
        [
          '|| true on a prepare line',
          (workflowDocument) => {
            const step = workflowDocument.jobs.ordinary.steps?.find(
              ({ name }) => name === 'Prepare the corpus prerequisites',
            ) as Step;
            step.run = step.run?.replace(
              'npm run prepare:verify-static',
              'npm run prepare:verify-static || true',
            );
          },
          /^ordinary: Prepare the corpus prerequisites: '\|\|' swallows/,
        ],
        [
          'an exit 0 mid-line, inside a compound command',
          (workflowDocument) => {
            const step = runStep(workflowDocument, 'static');
            step.run = `${step.run}\nif true; then exit 0; fi`;
          },
          /^static: Run full-regression phases: exit 0$/,
        ],
        [
          'a trap that rewrites the exit status',
          (workflowDocument) => {
            const step = runStep(workflowDocument, 'ordinary');
            step.run = `trap 'exit 0' EXIT\n${step.run}`;
          },
          /^ordinary: Run full-regression phases: trap$/,
        ],
        [
          'a backgrounded driver',
          (workflowDocument) => {
            const step = runStep(workflowDocument, 'process-heavy');
            step.run = step.run?.replace(
              '| tee "$RUNNER_TEMP/merge-queue-regression.log"',
              '| tee "$RUNNER_TEMP/merge-queue-regression.log" &',
            );
          },
          /^process-heavy: Run full-regression phases: backgrounded command/,
        ],
        [
          'a backgrounded android suite',
          (workflowDocument) => {
            androidStep(workflowDocument).run = 'npm run test:android &';
          },
          /^android-viewport: .*backgrounded command/,
        ],
        [
          'a gate job with its test step removed',
          (workflowDocument) => {
            const job = workflowDocument.jobs['android-viewport'];
            job.steps = job.steps?.filter(
              ({ run }) => run !== 'npm run test:android',
            );
          },
          /^android-viewport: no gated step runs a test command$/,
        ],
        [
          'continue-on-error on a setup step',
          (workflowDocument) => {
            const step = workflowDocument.jobs.static.steps?.find(
              ({ run }) => run === 'npm run dependencies:ci',
            ) as Step;
            step['continue-on-error'] = true;
          },
          /^static: npm run dependencies:ci: continue-on-error$/,
        ],
        [
          'continue-on-error on the aggregate step',
          (workflowDocument) => {
            const [step] =
              workflowDocument.jobs['merge-queue-regression'].steps ?? [];
            step['continue-on-error'] = true;
          },
          /merge-queue-regression: .*: continue-on-error$/,
        ],
      ];
    for (const [label, mutate, expected] of cases) {
      const violations = mutated(mutate);
      expect(
        violations.some((violation) => expected.test(violation)),
        `${label}: ${JSON.stringify(violations)}`,
      ).toBe(true);
    }
  });

  it('excludes quarantined files from every queue corpus selection, and nowhere else', () => {
    const corpus = (text: string) =>
      phaseIds(text).some((id) => id.startsWith('test-full-'));
    const all = selections(document().jobs);
    const corpusSelections = all.filter(({ text }) => corpus(text));
    // Four ordinary slices, two process-heavy slices, the exclusive groups.
    expect(corpusSelections).toHaveLength(7);
    for (const { job, text } of corpusSelections)
      expect(text, `${job}: ${text}`).toMatch(
        /(^|\s)--exclude-quarantined(\s|$)/,
      );
    for (const { job, text } of all.filter(({ text }) => !corpus(text)))
      expect(text, `${job}: ${text}`).not.toContain('--exclude-quarantined');
    // So a quarantined file is never counted as covered by the queue: every
    // group the queue reaches (asserted above) reaches it minus the list.
    expect(Array.isArray(QUARANTINED_VITEST_FILES)).toBe(true);
  });

  it('leaves Nightly canonical: full:regression never excludes quarantined files', () => {
    // Nightly calls the hosted full-regression workflow, which runs the
    // canonical `npm run full:regression`; that resolves to the package
    // scripts behind FULL_REGRESSION_PHASES. None of them may carry the
    // queue-only flag, so a quarantined file still runs every night.
    expect(workflow('nightly.yml')).toContain(
      'uses: ./.github/workflows/full-regression.yml',
    );
    const hosted = workflow('full-regression.yml');
    expect(extractRunBodies(hosted)).toContain('npm run full:regression');
    expect(hosted).not.toContain('quarantine');
    const scripts = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ).scripts as Record<string, string>;
    for (const name of [
      'full:regression',
      'full:regression:raw',
      'test:full:raw',
      ...FULL_REGRESSION_PHASES.map(({ privateScript }) => privateScript),
    ]) {
      expect(scripts[name], name).toBeDefined();
      expect(scripts[name], name).not.toContain('quarantine');
    }
    for (const phase of FULL_REGRESSION_PHASES)
      expect(phase.command, phase.id).not.toContain('quarantine');
  });

  it('counts only executed driver lines as selections (parser control)', () => {
    const jobs: Record<string, Job> = {
      probe: {
        steps: [
          {
            run: [
              '# node scripts/run-full-regression-phases.mjs --phase=app-builds',
              'echo node scripts/run-full-regression-phases.mjs --phase=sdk-builds',
              'node scripts/run-full-regression-phases.mjs --phase=repo-governance',
            ].join('\n'),
          },
          {
            // A PHASES env the step never reads selects nothing.
            env: { PHASES: '--phase=verify-static' },
            run: `node scripts/run-full-regression-phases.mjs "\${phases[@]}"`,
          },
        ],
      },
    };
    expect(selections(jobs).flatMap(({ text }) => phaseIds(text))).toEqual([
      'repo-governance',
    ]);
  });
});
