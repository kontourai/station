import { readFileSync } from 'node:fs';
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
    expect(workflow).toContain('actions/checkout@');
    expect(workflow).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub expression.
      'ref: ${{ github.event.repository.default_branch }}',
    );
    expect(workflow).toContain('persist-credentials: false');
  });
  test('checks maintainer permission and delegates all label decisions to the reducer', () => {
    expect(workflow).toContain('getCollaboratorPermissionLevel');
    expect(workflow).toContain('reduceIssueLifecycle(input)');
    expect(workflow).toContain('issues.addLabels');
    expect(workflow).toContain('issues.removeLabel');
  });
});
