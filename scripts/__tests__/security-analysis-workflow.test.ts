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
    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('runs-on: ubuntu-22.04');
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toContain('self-hosted');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('actions/cache@');
    expect(workflow).not.toContain('upload-artifact@');
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

  test.each([
    'scripts/__tests__/verification-coordinator.test.ts',
    'src-ui/src/components/__tests__/fixtures/data.json',
    '__tests__/root.ts',
    'tests/e2e-manifest.mjs',
    'src-server/routes/foo.test.ts',
    'src-ui/src/App.test.tsx',
    'tests/toolbar-reachability.spec.ts',
    'packages/sdk/src/client.spec.ts',
  ])('ignores test path %s', (path) => {
    expect(ignoredByCodeql(patterns, path)).toBe(true);
  });

  test.each([
    'src-server/routes/foo.ts',
    'src-ui/src/components/plugins/PluginFrameHost.tsx',
    'scripts/phone-ui-server.mjs',
    'src-ui/src/lib/test-utils.ts',
    'src-server/services/attestation.ts',
    'vitest.config.ts',
    'packages/tests-helper/src/index.ts',
    'src-ui/src/contest/latest.ts',
  ])('still scans production path %s', (path) => {
    expect(ignoredByCodeql(patterns, path)).toBe(false);
  });

  // push-to-main fails on a baseline entry that matches no result. An entry
  // on an ignored path can never match again, so none may remain.
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
