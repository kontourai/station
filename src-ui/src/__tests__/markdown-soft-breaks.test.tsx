/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { MarkdownRenderer } from '../components/chat/MarkdownRenderer';

/**
 * #4385: an agent that answers one item per line means those lines. The
 * renderer keeps a single newline in prose as a line break, in settled and
 * streaming (incremental) answers, and leaves code and paragraph boundaries
 * alone. A stored document opts out and keeps CommonMark folding.
 */
afterEach(cleanup);

const COUNT = Array.from({ length: 5 }, (_, i) => String(i + 1)).join('\n');

function paragraphLines(container: HTMLElement): string[][] {
  return [...container.querySelectorAll('p')].map((p) =>
    p.innerHTML.split('<br>').map((line) => line.trim()),
  );
}

describe('MarkdownRenderer soft line breaks', () => {
  test.each([
    ['settled', false],
    ['streaming', true],
  ])('a %s answer keeps one number per line', (_label, incremental) => {
    const { container } = render(
      <MarkdownRenderer incremental={incremental}>{COUNT}</MarkdownRenderer>,
    );
    expect(paragraphLines(container)).toEqual([['1', '2', '3', '4', '5']]);
    expect(container.querySelectorAll('br')).toHaveLength(4);
  });

  test('blank lines still separate paragraphs and code keeps its newlines', () => {
    const { container } = render(
      <MarkdownRenderer>
        {
          'roses are red\nviolets are blue\n\nnext stanza\n\n```\na\nb\n```\n\nrun `x\ny` now'
        }
      </MarkdownRenderer>,
    );
    expect(paragraphLines(container).slice(0, 2)).toEqual([
      ['roses are red', 'violets are blue'],
      ['next stanza'],
    ]);
    expect(container.querySelector('pre')?.textContent).toContain('a\nb');
    // Inline code is not prose: its newline is not turned into a break.
    expect(container.querySelector('p:last-of-type code')?.innerHTML).toBe(
      'x y',
    );
  });

  test('a stored document can keep CommonMark paragraph folding', () => {
    const { container } = render(
      <MarkdownRenderer softBreaks={false}>{COUNT}</MarkdownRenderer>,
    );
    expect(container.querySelectorAll('br')).toHaveLength(0);
    expect(container.querySelector('p')?.textContent).toBe(COUNT);
  });
});
