import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CODEQL_ANALYZE_ACTION,
  CODEQL_INIT_ACTION,
  DEPENDENCY_REVIEW_ACTION,
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
