import { describe, expect, test } from 'vitest';
import {
  CLAUDE_ARTIFACT_TITLE_MAX_CHARS,
  CLAUDE_ARTIFACT_URL_MAX_CHARS,
  claudeArtifactLinkView,
  claudeArtifactUrl,
  parseClaudeArtifactPublish,
} from '../claude-artifact.js';

const URL_OK = 'https://claude.ai/artifact/abc123';

describe('claudeArtifactUrl', () => {
  test('admits only https on exactly claude.ai, normalized', () => {
    expect(claudeArtifactUrl(URL_OK)).toBe(URL_OK);
    expect(claudeArtifactUrl('https://CLAUDE.AI/code/artifact/x')).toBe(
      'https://claude.ai/code/artifact/x',
    );
    for (const refused of [
      'http://claude.ai/artifact/x',
      'https://claude.ai.evil.example/artifact/x',
      'https://evil.example/claude.ai/artifact/x',
      'https://www.claude.ai/artifact/x',
      'https://claude.ai./artifact/x',
      'https://claude.ai:8443/artifact/x',
      'https://user:pass@claude.ai/artifact/x',
      'javascript:alert(1)//claude.ai',
      'claude.ai/artifact/x',
      'not a url',
      '',
      42,
      undefined,
    ])
      expect(claudeArtifactUrl(refused), String(refused)).toBeUndefined();
  });

  test('refuses a URL one character over the bound rather than cutting it', () => {
    expect(CLAUDE_ARTIFACT_URL_MAX_CHARS).toBe(2048);
    const prefix = 'https://claude.ai/artifact/';
    const atBound =
      prefix + 'a'.repeat(CLAUDE_ARTIFACT_URL_MAX_CHARS - prefix.length);
    expect(claudeArtifactUrl(atBound)).toBe(atBound);
    expect(claudeArtifactUrl(`${atBound}a`)).toBeUndefined();
  });
});

describe('parseClaudeArtifactPublish', () => {
  test('reads a publish (top-level url and path) and its title', () => {
    expect(
      parseClaudeArtifactPublish({
        url: URL_OK,
        path: '/w/report.html',
        title: '  Report  ',
        version: '2',
      }),
    ).toEqual({ url: URL_OK, title: 'Report' });
    expect(
      parseClaudeArtifactPublish({ url: URL_OK, path: '/w/r.md' }),
    ).toEqual({ url: URL_OK });
  });

  test('ignores other actions and malformed outputs', () => {
    for (const output of [
      { artifacts: [{ title: 't', url: URL_OK }] },
      { read: { url: URL_OK } },
      { url: URL_OK },
      { url: 'https://example.com/x', path: '/w/r.html' },
      [{ url: URL_OK, path: '/w' }],
      'https://claude.ai/artifact/x',
      null,
    ])
      expect(parseClaudeArtifactPublish(output)).toBeUndefined();
  });

  test('drops a title over the bound and keeps the link', () => {
    expect(CLAUDE_ARTIFACT_TITLE_MAX_CHARS).toBe(200);
    const title = 't'.repeat(CLAUDE_ARTIFACT_TITLE_MAX_CHARS);
    expect(
      parseClaudeArtifactPublish({ url: URL_OK, path: '/w', title })?.title,
    ).toBe(title);
    expect(
      parseClaudeArtifactPublish({
        url: URL_OK,
        path: '/w',
        title: `${title}t`,
      }),
    ).toEqual({ url: URL_OK });
  });
});

describe('claudeArtifactLinkView', () => {
  test('re-checks a stored link', () => {
    expect(claudeArtifactLinkView({ url: URL_OK, title: 'R' })).toEqual({
      url: URL_OK,
      title: 'R',
    });
    expect(
      claudeArtifactLinkView({ url: 'https://evil.example/', title: 'R' }),
    ).toBeUndefined();
    expect(claudeArtifactLinkView(undefined)).toBeUndefined();
  });
});
