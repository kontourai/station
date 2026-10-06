/**
 * The File Preview tokenizer's bounds, proven through `tokenizeForPreview`
 * (the one public function): a line longer than the length bound comes back
 * as one plain token from the real grammar engine, and the grammar runs
 * under a per-line time limit. The two literals are pinned here beside the
 * behaviour, since the module keeps them private.
 */
import { describe, expect, test } from 'vitest';
import { createChatHighlighter } from '../highlight/core-highlighter';
import { tokenizeForPreview } from '../highlight/preview-tokens';

const MAX_LINE_LENGTH = 2_000;
const TIME_LIMIT_MS = 200;

describe('tokenizeForPreview', () => {
  test('a line at the length bound is tokenized; one past it is left as a single plain token', async () => {
    const highlighter = await createChatHighlighter();
    // `const x = 1;` repeated: real TypeScript, so a tokenized line has runs
    // in more than one colour (keyword, identifier, number).
    const unit = 'const x = 1;';
    const atBound = unit.repeat(Math.floor(MAX_LINE_LENGTH / unit.length));
    const pastBound = `${atBound}${'/'.repeat(MAX_LINE_LENGTH + 1 - atBound.length)}`;
    expect(atBound.length).toBeLessThanOrEqual(MAX_LINE_LENGTH);
    expect(pastBound.length).toBe(MAX_LINE_LENGTH + 1);

    const [tokenized] = tokenizeForPreview(highlighter, atBound, 'typescript');
    const [plain] = tokenizeForPreview(highlighter, pastBound, 'typescript');

    expect(new Set(tokenized.map((token) => token.color)).size).toBeGreaterThan(
      1,
    );
    expect(plain).toHaveLength(1);
    expect(plain[0].content).toBe(pastBound);
  }, 30_000);

  test('the grammar runs with the per-line time limit and the length bound', () => {
    const seen: Array<Record<string, unknown>> = [];
    const highlighter = {
      codeToTokensBase: (code: string, options: Record<string, unknown>) => {
        seen.push(options);
        return code.split('\n').map((line) => [{ content: line }]);
      },
    };

    tokenizeForPreview(
      highlighter as unknown as Parameters<typeof tokenizeForPreview>[0],
      'a\nb',
      'typescript',
    );

    expect(seen).toEqual([
      expect.objectContaining({
        lang: 'typescript',
        tokenizeMaxLineLength: MAX_LINE_LENGTH,
        tokenizeTimeLimit: TIME_LIMIT_MS,
      }),
    ]);
  });

  test('adjacent runs of one colour merge into one token', () => {
    const highlighter = {
      codeToTokensBase: () => [
        [
          { content: 'con', color: '#ff7b72' },
          { content: 'st', color: '#FF7B72' },
          { content: ' x', color: '#c9d1d9' },
          { content: ' = 1' },
        ],
      ],
    };

    expect(
      tokenizeForPreview(
        highlighter as unknown as Parameters<typeof tokenizeForPreview>[0],
        'const x = 1',
        'typescript',
      ),
    ).toEqual([
      [
        { content: 'const', color: '#FF7B72' },
        { content: ' x', color: '#C9D1D9' },
        { content: ' = 1' },
      ],
    ]);
  });
});
