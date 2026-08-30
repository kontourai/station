import { describe, expect, test } from 'vitest';
import {
  markdownBlocksRequireWholeParse,
  splitMarkdownBlocks,
} from '../components/chat/markdown-blocks';
import {
  DEFINITION_DEPENDENT_MARKDOWN,
  MARKDOWN_RENDER_CORPUS,
  REAL_TRANSCRIPT_DERIVED_MARKDOWN,
} from './fixtures/incremental-markdown-corpus';

const LOSSLESS_CORPUS = [
  ...MARKDOWN_RENDER_CORPUS,
  '',
  'one paragraph',
  'first\r\n\r\nsecond\r\n',
  '~~~js metadata=yes\nconst value = 1;\n~~~\n',
  '| left | right |\n| :--- | ---: |\n| a | b |',
  '- item\n\n    ```js\n    const nested = true;\n    ```\n\nnext',
  '> ```diff\n> + added\n> ```\n\nafter',
  '<div>\n```js\nsource\n```\n</div>',
];

describe('splitMarkdownBlocks', () => {
  test.each(LOSSLESS_CORPUS)('losslessly reassembles %#', (source) => {
    expect(
      splitMarkdownBlocks(source)
        .map((block) => block.text)
        .join(''),
    ).toBe(source);
  });

  test('keeps the separator out of the prior block body', () => {
    const first = splitMarkdownBlocks('alpha');
    const second = splitMarkdownBlocks('alpha\n\nbeta');

    expect(first[0].text).toBe('alpha');
    expect(second[0]).toMatchObject({
      startLine: 0,
      text: 'alpha\n',
      kind: 'settled',
    });
    expect(second[1]).toMatchObject({ startLine: 1, text: '\nbeta' });
  });

  test('holds an incomplete table until its delimiter row lands', () => {
    expect(splitMarkdownBlocks('| name | result |')[0]).toMatchObject({
      flavor: 'table',
      provisionalReason: 'incomplete-table',
    });
    expect(
      splitMarkdownBlocks('| name | result |\n| --- | --- |')[0],
    ).toMatchObject({ flavor: 'table', provisionalReason: 'tail' });
  });

  test.each(['Use `a | b` here.', 'Run cat file | grep x for the list.'])(
    'does not classify ordinary pipe prose as a table: %s',
    (source) => {
      expect(splitMarkdownBlocks(source)[0]).toMatchObject({
        flavor: 'plain',
        provisionalReason: 'tail',
      });
    },
  );

  test.each([
    'My Heading\n----------',
    'My Heading\n---',
    'Some prose line\n---\nmore prose',
  ])(
    'does not hold a setext underline as an incomplete table: %s',
    (source) => {
      expect(splitMarkdownBlocks(source)[0]).toMatchObject({
        flavor: 'plain',
      });
    },
  );

  test('still holds a pipeless GFM table forming under its delimiter', () => {
    expect(splitMarkdownBlocks('a | b\n---')[0]).toMatchObject({
      flavor: 'table',
      provisionalReason: 'incomplete-table',
    });
  });

  test.each(DEFINITION_DEPENDENT_MARKDOWN)(
    'requires a whole parse for document-scoped definition %#',
    (source) => {
      const blocks = splitMarkdownBlocks(source);
      expect(
        blocks.some((block) => /^\s*\[(?:\^)?[^\]]+\]:/m.test(block.text)),
      ).toBe(true);
      expect(markdownBlocksRequireWholeParse(blocks)).toBe(true);
    },
  );

  test('keeps definition-free blocks on the incremental path', () => {
    expect(
      markdownBlocksRequireWholeParse(
        splitMarkdownBlocks('A [direct link](https://example.invalid).'),
      ),
    ).toBe(false);
  });

  test('recognizes info strings and preserves an unclosed fence as source', () => {
    const blocks = splitMarkdownBlocks(
      'intro\n```ts title=sample\nconst x = 1;',
    );
    const block = blocks.at(-1);
    expect(block).toMatchObject({
      startLine: 1,
      flavor: 'fence',
      kind: 'provisional',
      provisionalReason: 'open-fence',
    });
  });

  test('station#365: a fenced block inside a list remains in that list block', () => {
    const source = '- item\n\n    ```js\n    const nested = true;\n';
    expect(splitMarkdownBlocks(source)).toEqual([
      expect.objectContaining({
        startLine: 0,
        endLine: 3,
        text: source,
        flavor: 'fence',
        provisionalReason: 'open-fence',
      }),
    ]);
  });

  test('recognizes a growing fence inside a blockquote', () => {
    const source = '> note\n> ```diff\n> + pending\n';
    expect(splitMarkdownBlocks(source)).toEqual([
      expect.objectContaining({
        text: source,
        flavor: 'fence',
        provisionalReason: 'open-fence',
      }),
    ]);
  });

  test('derived transcript fixtures contain no sampled private identifiers', () => {
    const fixtures = REAL_TRANSCRIPT_DERIVED_MARKDOWN.join('\n');
    expect(fixtures).not.toMatch(
      /(?:\/Users\/|@[a-z0-9.-]+\.[a-z]{2,}|brian|fairview|clickoptimize|myftpupload)/i,
    );
  });
});
