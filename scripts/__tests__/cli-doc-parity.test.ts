import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  documentedVerbs,
  evaluateParity,
  helpTopics,
} from '../cli-doc-parity.mjs';

describe('cli-doc parity', () => {
  it('an undocumented topic and a stale verb heading both fail', () => {
    const { documented, verbHeadings } = documentedVerbs(
      '### `config`\n\n### `retired-verb`\n\n### Prose heading, no constraint\n',
    );
    const { undocumented, stale } = evaluateParity({
      topics: ['config', 'newverb'],
      documented,
      verbHeadings,
    });
    expect(undocumented).toEqual(['newverb']);
    expect(stale).toEqual(['retired-verb']);
  });

  it('grouped and quoted-key forms parse: hyphenated topics and multi-verb headings', () => {
    expect(
      helpTopics("  start: {\n  },\n  'secret-bindings': {\n  },\n"),
    ).toEqual(['start', 'secret-bindings']);
    const { documented } = documentedVerbs(
      '### `stations`, `target`, and `setup`\n',
    );
    expect([...documented].sort()).toEqual(['setup', 'stations', 'target']);
  });

  it('the real help and the real reference are at parity, via the entry point', () => {
    const out = execFileSync('node', ['scripts/cli-doc-parity.mjs'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(out).toContain('CLI doc parity passed');
    // Non-vacuous: the topic list must be substantial, not an empty match.
    expect(helpTopics().length).toBeGreaterThan(30);
  });
});
