import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import {
  CODEQL_ANALYZE_ACTION,
  CODEQL_INIT_ACTION,
  DEPENDENCY_REVIEW_ACTION,
  SECURITY_CODEQL_CONFIG,
} from '../actionlint-gate.mjs';

const workflow = readFileSync(
  '.github/workflows/security-analysis.yml',
  'utf8',
);

describe('security analysis workflow', () => {
  test('uses the protected workflow definition while containing PR code on a hosted runner', () => {
    expect(workflow).toContain('pull_request_target:\n    branches: [main]');
    expect(workflow).toContain(
      'merge_group:\n    branches: [main]\n    types: [checks_requested]',
    );
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('runs-on: ubuntu-22.04');
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toContain('self-hosted');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('actions/cache@');
    expect(workflow).not.toContain('upload-artifact@');
  });

  // A push to main re-analysed the commit its merge group had already
  // analysed, and the PR-event run repeated the analysis on every PR push.
  // A merge group runs its candidate's own YAML, so a PR that changes
  // .github/ keeps the base-defined PR-level run (gate-change decides).
  test('analyses CodeQL once per landing: merge group and daily on main, on the PR only for .github/ changes', () => {
    const document = load(workflow) as {
      on: Record<string, unknown>;
      jobs: Record<string, { if?: unknown; needs?: unknown }>;
    };
    expect(Object.keys(document.on).sort()).toEqual([
      'merge_group',
      'pull_request_target',
      'schedule',
      'workflow_dispatch',
    ]);
    expect(document.on).not.toHaveProperty('push');
    expect(document.on.schedule).toEqual([{ cron: '11 9 * * *' }]);
    expect(Object.keys(document.jobs).sort()).toEqual([
      'codeql',
      'dependency-review',
      'gate-change',
    ]);
    expect(document.jobs.codeql.needs).toBe('gate-change');
    expect(document.jobs.codeql.if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      "${{ !cancelled() && (github.event_name != 'pull_request_target' || needs.gate-change.result != 'success' || needs.gate-change.outputs.analyse != 'false') }}",
    );
    expect(document.jobs['gate-change'].if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      "${{ github.event_name == 'pull_request_target' }}",
    );
    // Dependency review keeps its PR-event run unchanged.
    expect(document.jobs['dependency-review'].if).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      "${{ github.event_name == 'pull_request_target' || github.event_name == 'merge_group' }}",
    );
  });

  // Only the main run can see a baseline entry the change removed, so it
  // must fail rather than warn. Every trigger outside the warn list fails.
  test('fails on a stale baseline entry in every run on main, warning only in candidate runs', () => {
    const policy = (
      load(workflow) as {
        jobs: { codeql: { steps: Array<{ name?: string; run?: string }> } };
      }
    ).jobs.codeql.steps.find(
      (step) => step.name === 'Normalize and enforce JavaScript SARIF policy',
    )?.run;
    expect(policy).toContain('STALE_BASELINE_MODE=fail\n');
    expect(policy).toContain('--stale-baseline="$STALE_BASELINE_MODE"');
    const warnLines = (policy ?? '')
      .split('\n')
      .filter(
        (line) =>
          line.trim().startsWith('if [') && line.includes('GITHUB_EVENT_NAME'),
      );
    expect(warnLines).toHaveLength(1);
    const warnEvents = [
      ...warnLines[0].matchAll(/"\$GITHUB_EVENT_NAME" = "([a-z_]+)"/g),
    ].map(([, event]) => event);
    expect(warnEvents).toEqual(['pull_request_target', 'merge_group']);
    expect(warnEvents).not.toContain('schedule');
    expect(warnEvents).not.toContain('workflow_dispatch');
  });

  test('runs dependency review as one pinned, action-only candidate job', () => {
    expect(workflow).toContain(
      'dependency-review:\n    name: Dependency review',
    );
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      "if: ${{ github.event_name == 'pull_request_target' || github.event_name == 'merge_group' }}",
    );
    expect(workflow).toContain(DEPENDENCY_REVIEW_ACTION);
    expect(workflow).toContain('vulnerability-check: true');
    expect(workflow).toContain('fail-on-severity: high');
    expect(workflow).toContain('license-check: false');
    expect(workflow).toContain('warn-only: false');
    expect(workflow).toContain('comment-summary-in-pr: never');
    expect(workflow).not.toContain('continue-on-error:');
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'base-ref: ${{ github.event.merge_group.base_sha }}',
    );
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'head-ref: ${{ github.event.merge_group.head_sha }}',
    );
  });

  test('isolates base policy outside the candidate scan before checking out the exact candidate head', () => {
    const base = workflow.indexOf('name: Check out base policy');
    const isolate = workflow.indexOf(
      'name: Isolate base policy outside candidate scan',
    );
    const candidate = workflow.indexOf('name: Check out candidate');
    expect(base).toBeGreaterThan(-1);
    expect(isolate).toBeGreaterThan(base);
    expect(candidate).toBeGreaterThan(isolate);
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'repository: ${{ github.repository }}',
    );
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      "ref: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.base.sha || github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.sha }}",
    );
    expect(workflow).toContain('path: base-policy');
    expect(workflow).toContain('node-version-file: base-policy/.nvmrc');
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'BASE_POLICY_DIRECTORY: ${{ runner.temp }}/base-policy',
    );
    expect(workflow).toContain('mv base-policy "$BASE_POLICY_DIRECTORY"');
    expect(workflow).toContain('path: candidate');
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(workflow).toContain('github.event.pull_request.head.repo.full_name');
    expect(workflow).toContain('github.event.pull_request.head.sha');
  });

  test('pins CodeQL v4, uses JavaScript and TypeScript source analysis, and never ingests results', () => {
    expect(workflow).toContain(CODEQL_INIT_ACTION);
    expect(workflow).toContain(CODEQL_ANALYZE_ACTION);
    expect(workflow).toContain('languages: javascript-typescript');
    expect(workflow).toContain('build-mode: none');
    expect(workflow).toContain('queries: security-extended');
    expect(workflow).toContain('source-root: candidate');
    expect(workflow).toContain('checkout_path: candidate');
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'output: ${{ runner.temp }}/codeql-sarif',
    );
    expect(workflow).toContain('upload: never');
    expect(workflow).toContain('upload-database: false');
  });

  test('keeps a measured, bounded timeout for analysis and base-policy enforcement', () => {
    expect(workflow).toContain('timeout-minutes: 30');
    expect(workflow).not.toContain('timeout-minutes: 15');
  });

  test('requires exactly one known JavaScript SARIF output, normalizes it atomically, then runs the checked-in policy', () => {
    const analyze = workflow.indexOf('name: Analyze without ingestion');
    const policy = workflow.indexOf(
      'name: Normalize and enforce JavaScript SARIF policy',
    );
    expect(analyze).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(analyze);
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'CODEQL_SARIF_DIRECTORY: ${{ runner.temp }}/codeql-sarif',
    );
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'CODEQL_NORMALIZED_SARIF: ${{ runner.temp }}/codeql-sarif-normalized/javascript.sarif',
    );
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'BASE_POLICY_DIRECTORY: ${{ runner.temp }}/base-policy',
    );
    expect(workflow).toContain(
      'find "$CODEQL_SARIF_DIRECTORY" -type f -name javascript.sarif -print0',
    );
    expect(workflow).toContain(
      'Expected exactly one JavaScript CodeQL SARIF file',
    );
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell expansion.
      'node "$BASE_POLICY_DIRECTORY/scripts/codeql-sarif-normalize.mjs" --input="${SARIF_FILES[0]}" --output="$CODEQL_NORMALIZED_SARIF"',
    );
    expect(workflow).toContain(
      'node "$BASE_POLICY_DIRECTORY/scripts/codeql-sarif-policy.mjs" --input="$CODEQL_NORMALIZED_SARIF"',
    );
    expect(workflow).not.toContain('npm ci');
    expect(workflow).not.toContain('npm run codeql:sarif:check');
    expect(workflow).not.toContain('git fetch');
    expect(workflow).not.toContain('git show');
  });
});

/** CodeQL paths-ignore globs: `**` spans segments, `*` stays inside one. */
function ignoredByCodeql(patterns: string[], path: string) {
  return patterns.some((pattern) => {
    const source = pattern
      .split('**/')
      .map((part) =>
        part
          .split('/**')
          .map((piece) =>
            piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
          )
          .join('/.*'),
      )
      .join('(?:.*/)?');
    return new RegExp(`^${source}$`).test(path);
  });
}

describe('CodeQL skips test code only', () => {
  const init = (
    load(workflow) as {
      jobs: {
        codeql: {
          steps: Array<{ name?: string; with?: Record<string, unknown> }>;
        };
      };
    }
  ).jobs.codeql.steps.find((step) => step.name === 'Initialize CodeQL');
  const patterns = (
    load(SECURITY_CODEQL_CONFIG) as { 'paths-ignore': string[] }
  )['paths-ignore'];

  test('passes exactly the reviewed ignore list inline, keeping security-extended', () => {
    expect(init?.with?.config).toBe(SECURITY_CODEQL_CONFIG);
    expect(init?.with).not.toHaveProperty('config-file');
    expect(init?.with?.queries).toBe('security-extended');
    expect(patterns).toEqual([
      '**/__tests__/**',
      'tests/**',
      '**/*.test.*',
      '**/*.spec.*',
    ]);
  });

  // Positive control for the baseline cross-check below: one row per pattern
  // proves the translator can match, so an empty filter result is not vacuous.
  test.each([
    'src-ui/src/components/__tests__/fixtures/data.json',
    'tests/e2e-manifest.mjs',
    'src-server/routes/foo.test.ts',
    'packages/sdk/src/client.spec.ts',
  ])('ignores test path %s', (path) => {
    expect(ignoredByCodeql(patterns, path)).toBe(true);
  });

  // The scheduled main run fails on a baseline entry that matches no result.
  // An entry on an ignored path can never match again, so none may remain.
  test('keeps no grandfathered finding on a path the scan now ignores', () => {
    const baseline = JSON.parse(
      readFileSync('scripts/codeql-error-baseline.json', 'utf8'),
    ) as { findings: Array<{ path: string }> };
    expect(baseline.findings.length).toBeGreaterThan(0);
    expect(
      baseline.findings
        .map((finding) => finding.path)
        .filter((path) => ignoredByCodeql(patterns, path)),
    ).toEqual([]);
  });
});
