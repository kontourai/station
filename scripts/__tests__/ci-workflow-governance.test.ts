import { readFileSync } from 'node:fs';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { FAST_CHECKS_JOB_TIMEOUT_MINUTES } from '../actionlint-gate.mjs';
import {
  collectCiWorkflowGovernanceFindings,
  collectPrimaryCiWorkflowTriggerFindings,
  collectRequiredBrowserSmokeFindings,
  findNamedWorkflowStep,
  REQUIRED_FAST_CHECKS_CONDITION,
} from '../ci-workflow-governance.mjs';

const primaryTriggers =
  'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n  merge_group:\n    branches: [main]\n    types: [checks_requested]\n  workflow_dispatch:\n';

const cleanWorkflow = `
${primaryTriggers}
jobs:
  fast-checks:
    needs: classify
    if: ${REQUIRED_FAST_CHECKS_CONDITION}
    steps:
      - name: Run fast CI
        run: npm run ci:fast
      - name: Verify critical browser journeys before merge
        run: npm run test:e2e:pr-smoke
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
    const workflow =
      _name === 'unreachable fast command'
        ? cleanWorkflow.replace(
            'run: npm run ci:fast',
            'run: |\n          exit 0\n          npm run ci:fast',
          )
        : _name.includes('unreachable')
          ? cleanWorkflow.replace(
              `if ${target}`,
              `${replacement}\n          if ${target}`,
            )
          : cleanWorkflow.replace(target, replacement);
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
    expect(findingsFor(cleanWorkflow.replace(target, replacement))).toContain(
      expected,
    );
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

  test('keeps Secret Scan on candidate pull requests to main', () => {
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
    const fastChecks = parsedJob(workflow, 'fast-checks');
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
    expect(fastChecks?.concurrency).toEqual({
      group:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
        'ci-fast-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}-${{ github.event.pull_request.head.sha || github.sha }}',
      'cancel-in-progress': true,
    });
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
      `if: ${REQUIRED_FAST_CHECKS_CONDITION}`,
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
  ])('rejects %s as unsupported syntax', (_name, triggers) => {
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
  test.each([
    [
      'manual dependency',
      (text: string) =>
        text.replace('needs: classify', 'needs: [classify, full-regression]'),
    ],
    [
      'removed suite',
      (text: string) =>
        text.replace('run: npm run test:e2e:pr-smoke', 'run: echo omitted'),
    ],
    [
      'conditional skip',
      (text: string) =>
        text.replace(
          'run: npm run test:e2e:pr-smoke',
          'if: false\n        run: npm run test:e2e:pr-smoke',
        ),
    ],
    [
      'swallowed error',
      (text: string) =>
        text.replace(
          'run: npm run test:e2e:pr-smoke',
          'run: npm run test:e2e:pr-smoke || true',
        ),
    ],
    [
      'optional step',
      (text: string) =>
        text.replace(
          'run: npm run test:e2e:pr-smoke',
          'continue-on-error: true\n        run: npm run test:e2e:pr-smoke',
        ),
    ],
    [
      'optional job',
      (text: string) => text.replace('  fast-checks:', '  optional-smoke:'),
    ],
    [
      'skipped job',
      (text: string) => text.replace(REQUIRED_FAST_CHECKS_CONDITION, 'false'),
    ],
  ])('rejects %s before the workflow can claim green', (_name, mutate) => {
    expect(
      collectRequiredBrowserSmokeFindings(mutate(cleanWorkflow)),
    ).not.toEqual([]);
  });
});
