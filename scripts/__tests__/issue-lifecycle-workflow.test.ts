import { readFileSync } from 'node:fs';
import { JSON_SCHEMA, load } from 'js-yaml';
import { describe, expect, test } from 'vitest';

describe('issue lifecycle workflow', () => {
  const workflow = readFileSync(
    '.github/workflows/issue-lifecycle.yml',
    'utf8',
  );
  test('uses only issue events and grants the minimum label mutation permission', () => {
    expect(workflow).toContain(
      'issues:\n    types: [opened, reopened, labeled]',
    );
    expect(workflow).toContain('issue_comment:\n    types: [created]');
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('issues: write');
    expect(workflow).not.toContain('pull_request:');
  });
  test('every checkout reads the default branch without persisting credentials', () => {
    const document = load(workflow, { schema: JSON_SCHEMA }) as {
      jobs: Record<
        string,
        { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }
      >;
    };
    const checkouts = Object.values(document.jobs).flatMap((job) =>
      (job.steps ?? []).filter((step) =>
        step.uses?.startsWith('actions/checkout@'),
      ),
    );
    expect(checkouts.length).toBeGreaterThan(0);
    for (const checkout of checkouts) {
      expect(checkout.with).toMatchObject({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
        ref: '${{ github.event.repository.default_branch }}',
        'persist-credentials': false,
      });
    }
  });
  test('checks maintainer permission and delegates all label decisions to the reducer', () => {
    expect(workflow).toContain('getCollaboratorPermissionLevel');
    expect(workflow).toContain('reduceIssueLifecycle(input)');
    expect(workflow).toContain('issues.addLabels');
    expect(workflow).toContain('issues.removeLabel');
  });
});
