import { readFileSync } from 'node:fs';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import {
  collectCiWorkflowGovernanceFindings,
  collectPostMergeDetectorWorkflowFindings,
  collectPrimaryCiWorkflowTriggerFindings,
  collectRequiredBrowserSmokeFindings,
  findNamedWorkflowStep,
  REQUIRED_FAST_CHECKS_CONDITION,
  workflowExecutionScope,
} from '../ci-workflow-governance.mjs';

const cleanWorkflow = `
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  merge_group:
    branches: [main]
    types: [checks_requested]
  workflow_dispatch:

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

const cleanPostMergeWorkflow = cleanWorkflow
  .replace('  pull_request:\n    branches: [main]\n', '')
  .replace(
    '  merge_group:\n    branches: [main]\n    types: [checks_requested]\n',
    '',
  );

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

  test('keeps Secret Scan on candidate pull requests and documents its evidence boundary', () => {
    const secretScan = readFileSync(
      new URL('../../.github/workflows/secret-scan.yml', import.meta.url),
      'utf8',
    );
    const localProtocol = readFileSync(
      new URL('../../docs/strategy/local-merge-readiness.md', import.meta.url),
      'utf8',
    );
    const governanceSource = readFileSync(
      new URL('../ci-workflow-governance.mjs', import.meta.url),
      'utf8',
    );

    expect(workflowExecutionScope(secretScan)).toBe('pull-request');
    expect(collectPostMergeDetectorWorkflowFindings(secretScan)).toContain(
      'Post-merge detector workflow must not trigger on pull_request.',
    );
    expect(localProtocol).toContain(
      'Secret Scan scans all Git history reachable from',
    );
    expect(localProtocol).toContain(
      'a red may come from pre-existing\n> reachable history',
    );
    expect(localProtocol).toContain(
      'does not replace the rest of merge-readiness evidence',
    );
    expect(governanceSource).not.toContain('Primary PR CI');
  });

  test('runs bounded PR feedback while reserving the heavy completion gate for main', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const classify = parsedJob(workflow, 'classify');
    const fastChecks = parsedJob(workflow, 'fast-checks');
    const fullRegression = parsedJob(workflow, 'full-regression');
    const browserSmoke = parsedJob(workflow, 'browser-smoke');

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
    expect(fastChecks?.['timeout-minutes']).toBe(45);
    expect(fastChecks?.concurrency).toEqual({
      group:
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
        'ci-fast-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}',
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
    expect(browserSmoke?.if).toBe(
      "github.event_name != 'pull_request_target' && (github.event_name == 'workflow_dispatch' || needs.classify.outputs.heavy == 'true')",
    );
  });

  test('rejects a parsed false PR-feedback guard despite a comment decoy', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    ).replace(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
      "if: ${{ always() && !cancelled() && (github.event_name == 'merge_group' || (github.event_name == 'pull_request_target' && github.event.pull_request.head.repo.full_name == github.repository) || github.event_name == 'workflow_dispatch' || needs.classify.outputs.heavy == 'true') }}",
      "if: false # github.event_name == 'pull_request_target'",
    );

    expect(workflow).toContain("github.event_name == 'pull_request_target'");
    expect(parsedJob(workflow, 'fast-checks')?.if).toBe(false);
    expect(parsedJob(workflow, 'fast-checks')?.if).not.toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression syntax is literal workflow data.
      "${{ always() && !cancelled() && (github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch' || needs.classify.outputs.heavy == 'true') }}",
    );
  });

  test('identifies a workflow that evaluates pull-request candidates', () => {
    expect(
      workflowExecutionScope(
        'on:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\n',
      ),
    ).toBe('pull-request');
  });

  test('accepts one canonical top-level on declaration', () => {
    expect(
      collectPostMergeDetectorWorkflowFindings(cleanPostMergeWorkflow),
    ).toEqual([]);
  });

  const workflowWithTriggers = (triggers: string) =>
    cleanPostMergeWorkflow.replace(
      'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n',
      triggers,
    );

  test.each([
    ['inline pull_request', 'on:[push,pull_request]'],
    ['scalar pull_request', 'on: pull_request'],
    ['sequence pull_request', 'on:\n  - push\n  - pull_request'],
    [
      'quoted top-level on key',
      '"on":\n  push:\n    branches: [main]\n  workflow_dispatch:\n',
    ],
    [
      'quoted inline event',
      'on:\n  "push":\n    branches: [main]\n  workflow_dispatch:\n',
    ],
    ['empty trigger list', 'on: []'],
    ['missing push trigger', 'on:\n  workflow_dispatch:\n'],
    ['missing manual trigger', 'on:\n  push:\n    branches: [main]\n'],
    [
      'push excluding main',
      'on:\n  push:\n    branches: [release]\n  workflow_dispatch:\n',
    ],
    [
      'push including an extra branch',
      'on:\n  push:\n    branches: [main, release]\n  workflow_dispatch:\n',
    ],
    [
      'push with duplicate main branch',
      'on:\n  push:\n    branches: [main, main]\n  workflow_dispatch:\n',
    ],
    [
      'push branches-ignore main',
      'on:\n  push:\n    branches-ignore: [main]\n  workflow_dispatch:\n',
    ],
    ['tags-only push', 'on:\n  push:\n    tags: [v*]\n  workflow_dispatch:\n'],
    [
      'duplicate top-level on declaration with scalar pull request',
      'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\non:\n  pull_request:\n',
    ],
    [
      'duplicate top-level on declaration with inline pull request',
      'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\non:[pull_request]\n',
    ],
    [
      'duplicate quoted top-level on declaration with scalar pull request',
      'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"on": pull_request\n',
    ],
    [
      'duplicate push mapping with last main branch',
      'on:\n  push:\n    branches: [release]\n  push:\n    branches: [main]\n  workflow_dispatch:\n',
    ],
  ])('rejects %s in the post-merge detector boundary', (_name, triggers) => {
    expect(
      collectPostMergeDetectorWorkflowFindings(workflowWithTriggers(triggers)),
    ).not.toEqual([]);
  });

  test.each([
    '"on":\n  push:\n    branches: [main]\n  workflow_dispatch:\n',
    'on:\n  "push":\n    branches: [main]\n  workflow_dispatch:\n',
    'on: [push, workflow_dispatch]',
    'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\non:\n  pull_request:\n',
    'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\non:[pull_request]\n',
    'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"on": pull_request\n',
    'on:\n  push:\n    branches: [release]\n  push:\n    branches: [main]\n  workflow_dispatch:\n',
  ])('rejects unsupported trigger syntax with a stable finding', (triggers) => {
    expect(
      collectPostMergeDetectorWorkflowFindings(workflowWithTriggers(triggers)),
    ).toEqual([
      'Post-merge detector workflow must declare supported top-level triggers.',
    ]);
  });

  test('accepts canonical inline comments and workflow_dispatch mapping', () => {
    expect(
      collectPostMergeDetectorWorkflowFindings(
        workflowWithTriggers(
          'on: # operational detector\n  push: # main only\n    branches: [main] # required\n  workflow_dispatch: {}\n',
        ),
      ),
    ).toEqual([]);
  });

  test('ignores a pull_request decoy inside a run block', () => {
    const decoy = cleanPostMergeWorkflow.replace(
      'run: npm run ci:fast',
      'run: |\n          echo pull_request:',
    );
    expect(collectPostMergeDetectorWorkflowFindings(decoy)).toEqual([]);
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
