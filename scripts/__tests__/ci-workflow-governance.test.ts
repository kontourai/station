import { readFileSync } from 'node:fs';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { FAST_CHECKS_JOB_TIMEOUT_MINUTES } from '../actionlint-gate.mjs';
import {
  collectCiWorkflowGovernanceFindings,
  collectPrimaryCiWorkflowTriggerFindings,
  collectRequiredBrowserSmokeFindings,
  FAST_CHECKS_AGGREGATE_RUN,
  FAST_CHECKS_AGGREGATE_STEP_IF,
  FAST_CHECKS_LEGACY_DETECT_RUN,
  FAST_CHECKS_LEGACY_OUTPUT,
  FAST_CHECKS_LEGACY_STEP_IF,
  FAST_CHECKS_MATRIX,
  FAST_CHECKS_PART_RESULTS_RUN,
  FAST_CHECKS_PLAN_RUN,
  FAST_CHECKS_PLANNED_STEP_IF,
  FAST_CHECKS_SHARD_IF,
  FAST_CHECKS_SHARD_RUN,
  FAST_CHECKS_SLICE_RUN,
  findNamedWorkflowStep,
  REQUIRED_FAST_CHECKS_AGGREGATE_CONDITION,
  REQUIRED_FAST_CHECKS_CONDITION,
} from '../ci-workflow-governance.mjs';

const primaryTriggers =
  'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n  merge_group:\n    branches: [main]\n    types: [checks_requested]\n  workflow_dispatch:\n';

/** A multi-line run body as a YAML block scalar at `indent` spaces. */
function block(text: string, indent: number) {
  const pad = ' '.repeat(indent);
  return `|\n${text
    .trimEnd()
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n')}`;
}

// The same shape as ci.yml (#2709): plan, shards, statics, and the required
// fast-checks aggregator over them. Single-quoted YAML scalars keep the
// double-quoted shell arguments literal.
const cleanWorkflow = `
${primaryTriggers}
jobs:
  fast-checks-plan:
    needs: classify
    if: ${REQUIRED_FAST_CHECKS_CONDITION}
    outputs:
      legacy: ${FAST_CHECKS_LEGACY_OUTPUT}
      shards: \${{ steps.plan.outputs.shards }}
      shard-count: \${{ steps.plan.outputs.shard-count }}
    steps:
      - name: Detect a candidate without the sharded lane
        id: mode
        run: ${block(FAST_CHECKS_LEGACY_DETECT_RUN, 10)}
      - run: npm run dependencies:ci
      - name: Run legacy unsharded ci:fast
        if: ${FAST_CHECKS_LEGACY_STEP_IF}
        run: npm run ci:fast
      - name: Plan the affected-test selection
        id: plan
        if: ${FAST_CHECKS_PLANNED_STEP_IF}
        run: '${FAST_CHECKS_PLAN_RUN}'
      - name: Upload fast-checks plan
        if: ${FAST_CHECKS_PLANNED_STEP_IF}
        uses: actions/upload-artifact@v7
  fast-checks-shard:
    needs: fast-checks-plan
    if: ${FAST_CHECKS_SHARD_IF}
    strategy:
      fail-fast: false
      matrix:
        shard: ${FAST_CHECKS_MATRIX}
    steps:
      - name: Resolve fast-checks shard slice
        run: '${FAST_CHECKS_SLICE_RUN}'
      - name: Run fast-checks shard
        run: '${FAST_CHECKS_SHARD_RUN}'
      - name: Upload fast-checks shard receipt
        if: always()
        uses: actions/upload-artifact@v7
        with:
          if-no-files-found: error
  fast-checks-statics:
    needs: classify
    if: ${REQUIRED_FAST_CHECKS_CONDITION}
    steps:
      - name: Run fast CI
        env:
          STATION_CI_FAST_SCOPE: statics
        run: npm run ci:fast
      - name: Verify critical browser journeys before merge
        run: npm run test:e2e:pr-smoke
      - name: Upload bounded fast-feedback diagnostics
        continue-on-error: true
        uses: actions/upload-artifact@v7
  fast-checks:
    needs: [classify, fast-checks-plan, fast-checks-shard, fast-checks-statics]
    if: ${REQUIRED_FAST_CHECKS_AGGREGATE_CONDITION}
    steps:
      - name: Require every fast-checks part job to succeed
        run: ${block(FAST_CHECKS_PART_RESULTS_RUN, 10)}
      - name: Verify fast-checks shard receipts
        if: ${FAST_CHECKS_AGGREGATE_STEP_IF}
        run: '${FAST_CHECKS_AGGREGATE_RUN}'
  completion:
    steps:
      - name: Run connected agents
        run: npm run test:connected-agents
      - name: Veritas readiness evidence
        if: always()
        run: |
          if node scripts/veritas-readiness-evidence.mjs --check evidence; then
            echo recorded
          else
            READINESS_EXIT=$?
            case "$READINESS_EXIT" in
              1) exit 1 ;;
              2) exit 2 ;;
              *) exit 1 ;;
            esac
          fi
          if [ -z "$BASE_REF" ]; then
            echo "NOT_VERIFIED: Veritas readiness evidence has no diff range available." >&2
            exit 2
          fi
`;

function findingsFor(workflow: string) {
  return collectCiWorkflowGovernanceFindings({
    ciWorkflowPath: '/fixture/.github/workflows/ci.yml',
    exists: () => true,
    readFile: () => workflow,
  });
}

function parsedJob(workflow: string, id: string) {
  const document = load(workflow, { schema: JSON_SCHEMA }) as {
    jobs?: Record<string, Record<string, unknown>>;
  };
  return document.jobs?.[id];
}

describe('primary CI workflow governance', () => {
  test('accepts explicit readiness exit classification', () => {
    expect(findingsFor(cleanWorkflow)).toEqual([]);
    expect(
      findNamedWorkflowStep(cleanWorkflow, 'Veritas readiness evidence'),
    ).toContain('READINESS_EXIT=$?');
  });

  test('fails closed when the primary workflow is absent', () => {
    expect(
      collectCiWorkflowGovernanceFindings({
        ciWorkflowPath: '/missing/.github/workflows/ci.yml',
        exists: () => false,
      }),
    ).toEqual(['Missing .github/workflows/ci.yml.']);
  });

  test('requires candidate feedback on pull requests to main', () => {
    expect(collectPrimaryCiWorkflowTriggerFindings(cleanWorkflow)).toEqual([]);
    expect(
      collectPrimaryCiWorkflowTriggerFindings(
        cleanWorkflow.replace('  pull_request:\n    branches: [main]\n', ''),
      ),
    ).toContain('Primary CI workflow must trigger on pull requests to main.');
  });

  test('accepts and requires the reviewed pull_request_target title-routing types', () => {
    const targetWorkflow = cleanWorkflow.replace(
      '  pull_request:\n    branches: [main]\n',
      '  pull_request_target:\n    branches: [main]\n    types: [opened, synchronize, reopened, edited]\n',
    );
    expect(collectPrimaryCiWorkflowTriggerFindings(targetWorkflow)).toEqual([]);
    expect(
      collectPrimaryCiWorkflowTriggerFindings(
        targetWorkflow.replace(', edited', ''),
      ),
    ).toContain(
      'Primary CI pull_request_target must include exactly opened, synchronize, reopened, and edited types.',
    );
  });

  test('requires the synthesized merge queue candidate trigger', () => {
    expect(collectPrimaryCiWorkflowTriggerFindings(cleanWorkflow)).toEqual([]);
    expect(
      collectPrimaryCiWorkflowTriggerFindings(
        cleanWorkflow.replace(
          '  merge_group:\n    branches: [main]\n    types: [checks_requested]\n',
          '',
        ),
      ),
    ).toContain(
      'Primary CI workflow must trigger on merge_group checks_requested for main.',
    );
  });

  test('does not accept a comment-only readiness command', () => {
    const workflow = cleanWorkflow.replace(
      '- name: Veritas readiness evidence',
      '# npm exec -- veritas readiness --check evidence',
    );
    expect(findingsFor(workflow)).toContain(
      'Post-merge CI workflow must execute the named Veritas readiness evidence step.',
    );
  });

  test.each([
    [
      'commented fast command',
      '# npm run ci:fast',
      'Post-merge CI workflow must execute npm run ci:fast.',
    ],
    [
      'echoed fast command',
      'echo "npm run ci:fast"',
      'Post-merge CI workflow must execute npm run ci:fast.',
    ],
    [
      'unreachable fast command',
      'exit 0\n        npm run ci:fast',
      'Post-merge CI workflow must execute npm run ci:fast.',
    ],
    [
      'commented readiness wrapper',
      '# node scripts/veritas-readiness-evidence.mjs --check evidence',
      'Veritas readiness evidence must execute the Station three-state readiness wrapper.',
    ],
    [
      'echoed readiness wrapper',
      'echo "node scripts/veritas-readiness-evidence.mjs --check evidence"',
      'Veritas readiness evidence must execute the Station three-state readiness wrapper.',
    ],
    [
      'unreachable readiness wrapper',
      'exit 0\n          node scripts/veritas-readiness-evidence.mjs --check evidence',
      'Veritas readiness evidence must execute the Station three-state readiness wrapper.',
    ],
  ])('rejects %s', (_name, replacement, expected) => {
    const target = _name.includes('fast')
      ? 'npm run ci:fast'
      : 'node scripts/veritas-readiness-evidence.mjs --check evidence';
    // Every executable ci:fast: the statics lane and the transitional legacy
    // lane in fast-checks-plan (#2709) both run it.
    const workflow =
      _name === 'unreachable fast command'
        ? cleanWorkflow.replaceAll(
            'run: npm run ci:fast',
            'run: |\n          exit 0\n          npm run ci:fast',
          )
        : _name.includes('unreachable')
          ? cleanWorkflow.replace(
              `if ${target}`,
              `${replacement}\n          if ${target}`,
            )
          : cleanWorkflow.replaceAll(target, replacement);
    expect(findingsFor(workflow)).toContain(expected);
  });

  test('rejects discarded and unclassified readiness exits', () => {
    expect(
      findingsFor(
        cleanWorkflow.replace('case "$READINESS_EXIT" in', '|| true'),
      ),
    ).toEqual(
      expect.arrayContaining([
        'Veritas readiness evidence must not discard its exit status with || true.',
        'Veritas readiness evidence must classify and propagate a nonzero exit status.',
      ]),
    );
  });

  test.each([
    [
      'a short-circuited fast command',
      'npm run ci:fast',
      'false && npm run ci:fast',
      'Post-merge CI workflow must execute npm run ci:fast.',
    ],
    [
      'an exit before readiness status capture',
      'READINESS_EXIT=$?',
      'exit 0\n            READINESS_EXIT=$?',
      'Veritas readiness evidence must classify and propagate a nonzero exit status.',
    ],
    [
      'a green unknown readiness branch',
      '*) exit 1 ;;',
      '*) exit 0 ;;',
      'Veritas readiness evidence must classify and propagate a nonzero exit status.',
    ],
    [
      'a comment-only no-diff token',
      'echo "NOT_VERIFIED: Veritas readiness evidence has no diff range available." >&2',
      '# NOT_VERIFIED: Veritas readiness evidence has no diff range available.',
      'Veritas readiness evidence must report a missing diff range as NOT_VERIFIED.',
    ],
  ])('rejects %s', (_name, target, replacement, expected) => {
    expect(
      findingsFor(cleanWorkflow.replaceAll(target, replacement)),
    ).toContain(expected);
  });

  test('rejects a no-diff path that would report success without evidence', () => {
    expect(
      findingsFor(
        cleanWorkflow.replace(
          'NOT_VERIFIED: Veritas readiness evidence has no diff range available.',
          'Skipping Veritas readiness evidence: no diff range available',
        ),
      ),
    ).toContain(
      'Veritas readiness evidence must report a missing diff range as NOT_VERIFIED.',
    );
  });

  test('keeps PR: Secret scan on candidate pull requests to main', () => {
    const secretScan = load(
      readFileSync(
        new URL('../../.github/workflows/secret-scan.yml', import.meta.url),
        'utf8',
      ),
      { schema: JSON_SCHEMA },
    ) as { on?: { pull_request?: { branches?: unknown } | null } };

    expect(secretScan.on?.pull_request?.branches).toEqual(['main']);
  });

  test('runs bounded PR feedback while reserving the heavy completion gate for main', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const classify = parsedJob(workflow, 'classify');
    // #2709: the statics job carries the former fast-checks steps; the
    // required `fast-checks` id is the aggregator over it and the shards.
    const fastChecks = parsedJob(workflow, 'fast-checks-statics');
    const aggregate = parsedJob(workflow, 'fast-checks');
    const fullRegression = parsedJob(workflow, 'full-regression');
    expect(parsedJob(workflow, 'browser-smoke')).toBeUndefined();

    expect(workflow).toContain('pull_request_target:\n    branches: [main]');
    expect(workflow).toContain(
      'merge_group:\n    branches: [main]\n    types: [checks_requested]',
    );
    expect(classify?.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
      "${{ github.event_name != 'pull_request_target' }}",
    );
    expect(classify?.['runs-on']).toBe('ubuntu-22.04');
    expect(fastChecks?.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
      "${{ always() && !cancelled() && (github.event_name == 'merge_group' || (github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'workflow_dispatch' || needs.classify.outputs.heavy == 'true') }}",
    );
    expect(fastChecks?.['runs-on']).toBe('ubuntu-22.04');
    // The fence is the gate's constant, not a second literal (#2577: this pin
    // stayed at 45 when the fence moved). ci-workflow-contract.test.ts proves
    // the value covers the ci:fast budget plus the job's bounded steps; this
    // keeps ci.yml and the actionlint-gate constant from drifting apart.
    expect(fastChecks?.['timeout-minutes']).toBe(
      FAST_CHECKS_JOB_TIMEOUT_MINUTES,
    );
    expect(aggregate?.concurrency).toEqual({
      group:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
        'ci-fast-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}-${{ github.event.pull_request.head.sha || github.sha }}',
      'cancel-in-progress': true,
    });
    // Every part job keys its own group on the head sha (#1445), and each
    // shard on its index, so no leg or part cancels another's run.
    for (const [id, prefix] of [
      ['fast-checks-statics', 'ci-fast-statics-'],
      ['fast-checks-plan', 'ci-fast-plan-'],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
      ['fast-checks-shard', 'ci-fast-shard-${{ matrix.shard }}-'],
    ]) {
      const group = String(
        (parsedJob(workflow, id)?.concurrency as { group?: string })?.group,
      );
      expect(group.startsWith(prefix), id).toBe(true);
      expect(group, id).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
        '${{ github.event.pull_request.head.sha || github.sha }}',
      );
    }
    const forkSmoke = parsedJob(workflow, 'fork-smoke');
    expect(forkSmoke?.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
      "${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name != github.repository }}",
    );
    expect(forkSmoke?.permissions).toEqual({ contents: 'read' });
    expect(forkSmoke?.['runs-on']).toBe('ubuntu-22.04');
    expect(JSON.stringify(forkSmoke)).not.toContain('secrets.');
    expect(JSON.stringify(forkSmoke)).not.toContain('actions/cache@');
    expect(JSON.stringify(forkSmoke)).not.toContain('actions/upload-artifact@');
    const forkSteps = forkSmoke?.steps as
      | Array<{
          name?: string;
          uses?: string;
          with?: Record<string, unknown>;
          run?: string;
        }>
      | undefined;
    expect(
      forkSteps?.find(
        (step) =>
          step.with?.repository ===
          `\${{ github.event.pull_request.head.repo.full_name }}`,
      )?.with,
    ).toMatchObject({
      'persist-credentials': false,
      repository: `\${{ github.event.pull_request.head.repo.full_name }}`,
      ref: `\${{ github.event.pull_request.head.sha }}`,
    });
    expect(
      forkSteps?.find((step) => step.run === 'npm run ci:fast'),
    ).toBeTruthy();
    const actionlintStepIndex = forkSteps?.findIndex(
      (step) => step.name === 'Install pinned actionlint',
    );
    const forkSmokeIndex = forkSteps?.findIndex(
      (step) => step.name === 'Run isolated fork smoke',
    );
    expect(actionlintStepIndex).toBeGreaterThanOrEqual(0);
    expect(forkSmokeIndex).toBeGreaterThan(actionlintStepIndex ?? 0);
    const fastSteps = fastChecks?.steps as
      | Array<{ name?: string; run?: string }>
      | undefined;
    expect(
      (
        fastChecks?.steps as
          | Array<{ uses?: string; with?: Record<string, unknown> }>
          | undefined
      )?.find(
        (step) =>
          step.with?.repository ===
          `\${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name || github.repository }}`,
      )?.with,
    ).toMatchObject({
      'persist-credentials': false,
      repository: `\${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name || github.repository }}`,
      ref: `\${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || github.sha }}`,
    });
    expect(
      fastSteps?.find(
        (step) => step.name === 'Enforce candidate UI bundle budget',
      )?.run,
    ).toBe('npm run build:ui');
    const fastActionlintIndex = fastSteps?.findIndex(
      (step) => step.name === 'Install pinned actionlint',
    );
    const fastCiIndex = fastSteps?.findIndex(
      (step) => step.name === 'Run fast CI lane',
    );
    const fastNpmCiIndex = fastSteps?.findIndex(
      (step) => step.run === 'npm run dependencies:ci',
    );
    expect(fastActionlintIndex).toBeGreaterThanOrEqual(0);
    expect(fastNpmCiIndex).toBeGreaterThan(fastActionlintIndex ?? 0);
    expect(fastCiIndex).toBeGreaterThan(fastActionlintIndex ?? 0);
    expect(fullRegression?.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
      "${{ always() && !cancelled() && github.event_name != 'pull_request_target' && github.event_name == 'workflow_dispatch' }}",
    );
  });

  test('rejects a parsed false fast-checks guard despite a comment decoy', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const decoy = workflow.replace(
      `if: ${REQUIRED_FAST_CHECKS_AGGREGATE_CONDITION}`,
      "if: false # github.event_name == 'pull_request_target'",
    );

    expect(decoy).not.toBe(workflow);
    expect(findingsFor(workflow)).toEqual([]);
    expect(findingsFor(decoy)).toContain(
      'Required fast-checks must admit PR and merge candidates without swallowing failures.',
    );
  });
});

describe('primary CI trigger declaration parser', () => {
  const unsupported = [
    'Primary CI workflow must declare supported top-level triggers.',
  ];
  const withTriggers = (triggers: string) => {
    const workflow = cleanWorkflow.replace(primaryTriggers, triggers);
    if (triggers !== primaryTriggers && workflow === cleanWorkflow)
      throw new Error('trigger fixture did not replace the canonical block');
    return workflow;
  };
  const candidateTriggers =
    '  pull_request:\n    branches: [main]\n  merge_group:\n    branches: [main]\n    types: [checks_requested]\n  workflow_dispatch:\n';

  test('accepts the canonical declaration, inline comments, block sequences, and an empty dispatch mapping', () => {
    expect(
      collectPrimaryCiWorkflowTriggerFindings(withTriggers(primaryTriggers)),
    ).toEqual([]);
    expect(
      collectPrimaryCiWorkflowTriggerFindings(
        withTriggers(
          'on: # candidate and main\n  push: # main only\n    branches: # required\n      - main # only\n  pull_request:\n    branches: [main]\n  merge_group:\n    branches: [main]\n    types: [checks_requested]\n  workflow_dispatch: {}\n',
        ),
      ),
    ).toEqual([]);
  });

  test.each([
    [
      'inline event list',
      'on: [push, pull_request, merge_group, workflow_dispatch]',
    ],
    ['scalar event', 'on: pull_request'],
    ['event sequence', 'on:\n  - push\n  - pull_request'],
    ['empty event list', 'on: []'],
    ['double-quoted top-level on key', `"on":\n${primaryTriggers.slice(4)}`],
    ['single-quoted top-level on key', `'on':\n${primaryTriggers.slice(4)}`],
    [
      'quoted event key',
      `on:\n  "push":\n    branches: [main]\n${candidateTriggers}`,
    ],
    [
      'duplicate top-level on declaration with a mapping',
      `${primaryTriggers}on:\n  pull_request:\n`,
    ],
    [
      'duplicate top-level on declaration with an inline list',
      `${primaryTriggers}on:[pull_request]\n`,
    ],
    [
      'duplicate quoted top-level on declaration with a scalar',
      `${primaryTriggers}"on": pull_request\n`,
    ],
    [
      'duplicate push mapping whose last branch is main',
      `on:\n  push:\n    branches: [release]\n  push:\n    branches: [main]\n${candidateTriggers}`,
    ],
    [
      'push branches-ignore main',
      `on:\n  push:\n    branches-ignore: [main]\n${candidateTriggers}`,
    ],
    ['tags-only push', `on:\n  push:\n    tags: [v*]\n${candidateTriggers}`],
    ['push without a branch filter', `on:\n  push:\n${candidateTriggers}`],
    [
      'types filter on push',
      `on:\n  push:\n    branches: [main]\n    types: [created]\n${candidateTriggers}`,
    ],
    [
      'unsupported event',
      `on:\n  push:\n    branches: [main]\n  schedule:\n${candidateTriggers}`,
    ],
  ])('rejects %s as an unsupported trigger declaration', (_name, triggers) => {
    expect(
      collectPrimaryCiWorkflowTriggerFindings(withTriggers(triggers)),
    ).toEqual(unsupported);
  });

  test.each([
    [
      'missing push',
      `on:\n${candidateTriggers}`,
      'Primary CI workflow must trigger on pushes to main.',
    ],
    [
      'push excluding main',
      `on:\n  push:\n    branches: [release]\n${candidateTriggers}`,
      'Primary CI workflow must trigger on pushes to main.',
    ],
    [
      'push including an extra branch',
      `on:\n  push:\n    branches: [main, release]\n${candidateTriggers}`,
      'Primary CI workflow must trigger on pushes to main.',
    ],
    [
      'push with a duplicate main branch',
      `on:\n  push:\n    branches: [main, main]\n${candidateTriggers}`,
      'Primary CI workflow must trigger on pushes to main.',
    ],
    [
      'pull request including an extra branch',
      primaryTriggers.replace(
        '  pull_request:\n    branches: [main]',
        '  pull_request:\n    branches: [main, release]',
      ),
      'Primary CI workflow must trigger on pull requests to main.',
    ],
    [
      'missing manual trigger',
      primaryTriggers.replace('  workflow_dispatch:\n', ''),
      'Primary CI workflow must support workflow_dispatch.',
    ],
  ])('rejects %s with its own finding', (_name, triggers, expected) => {
    expect(
      collectPrimaryCiWorkflowTriggerFindings(withTriggers(triggers)),
    ).toEqual([expected]);
  });

  test('ignores a pull_request decoy inside a run block', () => {
    const decoy = withTriggers(
      primaryTriggers.replace('  pull_request:\n    branches: [main]\n', ''),
    ).replace('run: npm run ci:fast', 'run: |\n          echo pull_request:');
    expect(collectPrimaryCiWorkflowTriggerFindings(decoy)).toEqual([
      'Primary CI workflow must trigger on pull requests to main.',
    ]);
  });
});

describe('required browser evidence cannot silently disappear', () => {
  test('accepts the actual pre-merge job wiring', () => {
    expect(
      collectRequiredBrowserSmokeFindings(
        readFileSync('.github/workflows/ci.yml', 'utf8'),
      ),
    ).toEqual([]);
  });
  const executesOnce =
    'Required browser smoke must execute once, unconditionally, with its real exit status inside fast-checks-statics.';
  const admitsPlan =
    'Required fast-checks-plan must admit PR and merge candidates without swallowing failures.';
  test.each([
    [
      'manual dependency',
      (text: string) =>
        text.replace('needs: classify', 'needs: [classify, full-regression]'),
      admitsPlan,
    ],
    [
      'removed suite',
      (text: string) =>
        text.replace('run: npm run test:e2e:pr-smoke', 'run: echo omitted'),
      executesOnce,
    ],
    [
      'conditional skip',
      (text: string) =>
        text.replace(
          'run: npm run test:e2e:pr-smoke',
          'if: false\n        run: npm run test:e2e:pr-smoke',
        ),
      executesOnce,
    ],
    [
      'swallowed error',
      (text: string) =>
        text.replace(
          'run: npm run test:e2e:pr-smoke',
          'run: npm run test:e2e:pr-smoke || true',
        ),
      executesOnce,
    ],
    [
      'optional step',
      (text: string) =>
        text.replace(
          'run: npm run test:e2e:pr-smoke',
          'continue-on-error: true\n        run: npm run test:e2e:pr-smoke',
        ),
      executesOnce,
    ],
    [
      'optional job',
      (text: string) => text.replace('  fast-checks:', '  optional-smoke:'),
      'Required browser smoke must run inside fast-checks.',
    ],
    [
      'skipped job',
      (text: string) => text.replace(REQUIRED_FAST_CHECKS_CONDITION, 'false'),
      admitsPlan,
    ],
  ])(
    'rejects %s before the workflow can claim green',
    (_name, mutate, finding) => {
      const mutated = mutate(cleanWorkflow);
      expect(mutated).not.toBe(cleanWorkflow);
      expect(collectRequiredBrowserSmokeFindings(mutated)).toContain(finding);
    },
  );
});

describe('the required fast-checks aggregator cannot pass over a missing part (#2709)', () => {
  test('accepts the checked-in workflow and the fixture', () => {
    expect(collectRequiredBrowserSmokeFindings(cleanWorkflow)).toEqual([]);
    expect(
      collectRequiredBrowserSmokeFindings(
        readFileSync('.github/workflows/ci.yml', 'utf8'),
      ),
    ).toEqual([]);
  });

  test.each([
    [
      'an aggregator that skips itself on a cancelled run',
      REQUIRED_FAST_CHECKS_AGGREGATE_CONDITION,
      REQUIRED_FAST_CHECKS_CONDITION,
      'Required fast-checks must admit PR and merge candidates without swallowing failures.',
    ],
    [
      'an aggregator that does not wait for the shards',
      'needs: [classify, fast-checks-plan, fast-checks-shard, fast-checks-statics]',
      'needs: [classify, fast-checks-plan, fast-checks-statics]',
      'Required fast-checks must not depend on optional or manual completion jobs.',
    ],
    [
      'a part-result check that accepts any result',
      'all(.value.result == "success")',
      'all(.value.result != "")',
      'Required fast-checks must fail unless every part job succeeded and every shard receipt verifies.',
    ],
    [
      'an aggregator that never reads the receipts',
      `run: '${FAST_CHECKS_AGGREGATE_RUN}'`,
      'run: echo receipts',
      'Required fast-checks must fail unless every part job succeeded and every shard receipt verifies.',
    ],
    [
      'a receipt verification skipped whenever legacy is not exactly false',
      `        if: ${FAST_CHECKS_AGGREGATE_STEP_IF}\n        run: '${FAST_CHECKS_AGGREGATE_RUN}'`,
      `        if: \${{ needs.fast-checks-plan.outputs.legacy != 'false' }}\n        run: '${FAST_CHECKS_AGGREGATE_RUN}'`,
      'Required fast-checks must fail unless every part job succeeded and every shard receipt verifies.',
    ],
    [
      'a dropped shard',
      `shard: ${FAST_CHECKS_MATRIX}`,
      'shard: [1, 2, 3]',
      'fast-checks-shard must run the planned matrix after the plan without swallowing failures.',
    ],
    [
      'fail-fast shards',
      'fail-fast: false',
      'fail-fast: true',
      'fast-checks-shard must run the planned matrix after the plan without swallowing failures.',
    ],
    [
      'a shard admitted without a successful plan',
      `    if: ${FAST_CHECKS_SHARD_IF}\n`,
      '    if: always()\n',
      'fast-checks-shard must run the planned matrix after the plan without swallowing failures.',
    ],
    [
      'a swallowed receipt upload',
      '      - name: Upload fast-checks shard receipt\n',
      '      - name: Upload fast-checks shard receipt\n        continue-on-error: true\n',
      'fast-checks-shard must run the planned matrix after the plan without swallowing failures.',
    ],
    [
      'a receipt uploaded only on success',
      '        if: always()\n        uses: actions/upload-artifact@v7',
      '        uses: actions/upload-artifact@v7',
      'fast-checks-shard must run its slice unconditionally and always upload its receipt.',
    ],
    [
      'a statics job that also swallows its lane',
      '          STATION_CI_FAST_SCOPE: statics\n        run: npm run ci:fast\n',
      '          STATION_CI_FAST_SCOPE: statics\n        continue-on-error: true\n        run: npm run ci:fast\n',
      'Required fast-checks-statics must admit PR and merge candidates without swallowing failures.',
    ],
    [
      'a statics lane that is not scoped to statics',
      'STATION_CI_FAST_SCOPE: statics',
      'STATION_CI_FAST_SCOPE: all',
      'fast-checks-statics must run the statics-only ci:fast lane once, unconditionally.',
    ],
    [
      'a legacy branch that skips the plan and statics results',
      '.["fast-checks-plan"].result == "success" and .["fast-checks-statics"].result == "success" and ',
      '',
      'Required fast-checks must fail unless every part job succeeded and every shard receipt verifies.',
    ],
    [
      'a legacy lane scoped to statics only',
      `        if: ${FAST_CHECKS_LEGACY_STEP_IF}\n        run: npm run ci:fast\n`,
      `        if: ${FAST_CHECKS_LEGACY_STEP_IF}\n        env:\n          STATION_CI_FAST_SCOPE: statics\n        run: npm run ci:fast\n`,
      'fast-checks-plan must run the whole unsharded ci:fast lane exactly when the candidate lacks the sharded lane.',
    ],
    [
      'a legacy lane that also runs on sharded candidates',
      `        if: ${FAST_CHECKS_LEGACY_STEP_IF}\n        run: npm run ci:fast\n`,
      '        run: npm run ci:fast\n',
      'fast-checks-plan must run the whole unsharded ci:fast lane exactly when the candidate lacks the sharded lane.',
    ],
    [
      'a detection that always reports legacy',
      'if [ -f scripts/fast-checks-shard.mjs ]; then',
      'if false; then',
      'fast-checks-plan must run the whole unsharded ci:fast lane exactly when the candidate lacks the sharded lane.',
    ],
    [
      'a plan uploaded even on the legacy path',
      `        if: ${FAST_CHECKS_PLANNED_STEP_IF}\n        uses: actions/upload-artifact@v7`,
      '        uses: actions/upload-artifact@v7',
      'fast-checks-plan must compute the plan exactly once.',
    ],
    [
      'a plan that is never computed',
      `run: '${FAST_CHECKS_PLAN_RUN}'`,
      'run: echo planned',
      'fast-checks-plan must compute the plan exactly once.',
    ],
  ])('rejects %s', (_name, target, replacement, expected) => {
    const mutated = cleanWorkflow.replace(target, replacement);
    expect(mutated).not.toBe(cleanWorkflow);
    expect(collectRequiredBrowserSmokeFindings(mutated)).toContain(expected);
  });
});
