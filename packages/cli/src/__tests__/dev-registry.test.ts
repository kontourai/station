import { describe, expect, test } from 'vitest';
import { parsePromptMarkdown } from '../dev/registry.js';

describe('parsePromptMarkdown', () => {
  test('parses frontmatter and list metadata from prompt markdown', () => {
    const parsed = parsePromptMarkdown(
      `---
id: deploy
label: Deploy App
icon: rocket
requires:
  - aws
  - kubernetes
---
Ship it.`,
      'deploy.md',
    );

    expect(parsed).toEqual({
      id: 'deploy',
      name: 'Deploy App',
      icon: 'rocket',
      requires: ['aws', 'kubernetes'],
      content: 'Ship it.',
    });
  });
});
