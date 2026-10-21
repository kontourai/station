import githubDark from '@shikijs/themes/github-dark';
import { describe, expect, test } from 'vitest';
import { createChatHighlighter } from '../highlight/core-highlighter';
import { THEME } from '../highlight/shared';
import {
  createStationDiffTheme,
  createStationSyntaxTheme,
  GITHUB_DARK_ROLE_BY_COLOR,
} from '../highlight/station-syntax-theme';

/**
 * The highlighters used to emit github-dark's literal pigments, so a chat
 * code block stayed dark-on-dark in the light theme and no palette could
 * reach it. The shared theme now spells every colour as a Station variable.
 */
describe('station syntax theme', () => {
  test('every colour github-dark uses has a Station role', () => {
    const used = new Set<string>();
    for (const rule of githubDark.tokenColors ?? []) {
      for (const color of [rule.settings.foreground, rule.settings.background])
        if (color) used.add(color.toLowerCase());
    }
    expect(used.size).toBeGreaterThan(5);
    const unmapped = [...used].filter(
      (color) => !(color in GITHUB_DARK_ROLE_BY_COLOR),
    );
    expect(unmapped).toEqual([]);
  });

  test('both derived themes carry no literal colour', () => {
    for (const theme of [
      createStationSyntaxTheme(),
      createStationDiffTheme(),
    ]) {
      const serialized = JSON.stringify(theme);
      expect(serialized, theme.name).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(serialized).toContain('var(--syntax-keyword)');
    }
    expect(createStationDiffTheme().colors).toMatchObject({
      'editor.background': 'var(--diff-background)',
      'gitDecoration.addedResourceForeground': 'var(--diff-addition)',
      'gitDecoration.deletedResourceForeground': 'var(--diff-deletion)',
    });
  });

  test('chat highlighting emits Station variables, never pigments', async () => {
    const highlighter = await createChatHighlighter();
    const html = highlighter.codeToHtml(
      "// note\nexport const greet = (name: string) => 'hi ' + name;\n",
      // No time limit: a loaded test host must not end tokenization early
      // and leave a line in one colour.
      { lang: 'typescript', theme: THEME, tokenizeTimeLimit: 0 },
    );
    expect(html).toContain(
      'style="background-color:var(--syntax-background);color:var(--syntax-foreground)"',
    );
    expect(html).toContain('color:var(--syntax-keyword)');
    expect(html).toContain('color:var(--syntax-comment)');
    expect(html).toContain('color:var(--syntax-string)');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  }, 30_000);
});
