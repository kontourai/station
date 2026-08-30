/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  MarkdownRenderer,
  type MarkdownRenderProbe,
} from '../components/chat/MarkdownRenderer';
import { splitMarkdownBlocks } from '../components/chat/markdown-blocks';
import {
  DEFINITION_DEPENDENT_MARKDOWN,
  REAL_TRANSCRIPT_DERIVED_MARKDOWN,
} from './fixtures/incremental-markdown-corpus';

afterEach(cleanup);

function baselineHtml(source: string): string {
  return render(
    <ReactMarkdown components={{}} remarkPlugins={[remarkGfm]}>
      {source}
    </ReactMarkdown>,
  ).container.innerHTML;
}

function incrementalHtml(source: string): string {
  return render(
    <MarkdownRenderer incremental components={{}}>
      {source}
    </MarkdownRenderer>,
  ).container.innerHTML;
}

const DEFINITION_CASES = [
  [
    DEFINITION_DEPENDENT_MARKDOWN[0],
    'a[href="https://example.invalid/guide"]',
    'release guide',
  ],
  [
    DEFINITION_DEPENDENT_MARKDOWN[1],
    'img[src="https://example.invalid/diagram.png"]',
    null,
  ],
  [
    DEFINITION_DEPENDENT_MARKDOWN[2],
    'section[data-footnotes="true"]',
    'definition-only block must remain available',
  ],
] as const;

describe('incremental Markdown rendering', () => {
  test.each(REAL_TRANSCRIPT_DERIVED_MARKDOWN)(
    'matches one full GFM parse for complete derived transcript %#',
    (source) => {
      const expected = baselineHtml(source);
      cleanup();
      expect(incrementalHtml(source)).toBe(expected);
    },
  );

  test.each(DEFINITION_CASES)(
    'uses one canonical parse for definition-dependent construct %#',
    (source, selector, expectedText) => {
      const expected = baselineHtml(source);
      cleanup();
      const onBlockRender = vi.fn();
      const view = render(
        <MarkdownRenderer
          incremental
          components={{}}
          renderProbe={{ onBlockRender }}
        >
          {source}
        </MarkdownRenderer>,
      );

      expect(onBlockRender).not.toHaveBeenCalled();
      expect(view.container.innerHTML).toBe(expected);
      const resolvedConstruct = view.container.querySelector(selector);
      expect(resolvedConstruct).not.toBeNull();
      if (expectedText) {
        expect(resolvedConstruct?.textContent).toContain(expectedText);
      }
    },
  );

  test('settled mode takes the immediate canonical full-parse path', () => {
    const source = 'paragraph\n\n- list\n- list\n\n```ts\nconst x = 1;\n```';
    const splitBlocks = vi.fn(splitMarkdownBlocks);
    const view = render(
      <MarkdownRenderer splitBlocks={splitBlocks} components={{}}>
        {source}
      </MarkdownRenderer>,
    );
    expect(splitBlocks).not.toHaveBeenCalled();
    expect(view.container.innerHTML).toBe(baselineHtml(source));
  });

  test('re-parses only the growing tail and never re-renders settled blocks', () => {
    const parseCounts = new Map<number, number>();
    const renderCounts = new Map<number, number>();
    const probe: MarkdownRenderProbe = {
      onParse: (line) =>
        parseCounts.set(line, (parseCounts.get(line) ?? 0) + 1),
      onBlockRender: (line) =>
        renderCounts.set(line, (renderCounts.get(line) ?? 0) + 1),
    };
    const components = {};
    const settled = Array.from(
      { length: 12 },
      (_, index) => `Block ${index}`,
    ).join('\n\n');
    const view = render(
      <MarkdownRenderer incremental components={components} renderProbe={probe}>
        {`${settled}\n\ntail`}
      </MarkdownRenderer>,
    );
    const initialParses = Array.from(parseCounts.values()).reduce(
      (sum, count) => sum + count,
      0,
    );

    for (let flush = 1; flush <= 20; flush += 1) {
      view.rerender(
        <MarkdownRenderer
          incremental
          components={components}
          renderProbe={probe}
        >
          {`${settled}\n\ntail${'.'.repeat(flush)}`}
        </MarkdownRenderer>,
      );
    }

    const finalParses = Array.from(parseCounts.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
    expect(finalParses - initialParses).toBe(20);
    for (const block of splitMarkdownBlocks(settled)) {
      expect(renderCounts.get(block.startLine)).toBe(1);
    }
  });

  test('keeps the keyed tail component mounted across fence flavor growth', () => {
    const mounts = vi.fn();
    const unmounts = vi.fn();
    const probe: MarkdownRenderProbe = {
      onBlockMount: mounts,
      onBlockUnmount: unmounts,
    };
    const components = {};
    const view = render(
      <MarkdownRenderer incremental components={components} renderProbe={probe}>
        {'`'}
      </MarkdownRenderer>,
    );
    view.rerender(
      <MarkdownRenderer incremental components={components} renderProbe={probe}>
        {'```diff\n+ growing'}
      </MarkdownRenderer>,
    );

    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
  });

  test('renders incomplete tables and open fences as visible source', () => {
    const table = render(
      <MarkdownRenderer incremental components={{}}>
        {'| name | result |'}
      </MarkdownRenderer>,
    );
    expect(
      table.container.querySelector('[data-markdown-provisional="table"]')
        ?.textContent,
    ).toBe('| name | result |');
    cleanup();

    const fence = render(
      <MarkdownRenderer incremental components={{}}>
        {'```ts\nconst pending = true;'}
      </MarkdownRenderer>,
    );
    expect(
      fence.container.querySelector('[data-markdown-provisional="fence"]')
        ?.textContent,
    ).toContain('const pending = true;');
  });

  test('renders ordinary pipe prose as a paragraph while it is the tail', () => {
    const view = render(
      <MarkdownRenderer incremental components={{}}>
        {'Use `a | b` here.'}
      </MarkdownRenderer>,
    );
    expect(view.container.querySelector('pre')).toBeNull();
    expect(view.container.querySelector('p')?.textContent).toBe(
      'Use a | b here.',
    );
  });

  test('holds a table header, then parses it without replacing the keyed block', () => {
    const mounts = vi.fn();
    const unmounts = vi.fn();
    const probe: MarkdownRenderProbe = {
      onBlockMount: mounts,
      onBlockUnmount: unmounts,
    };
    const components = {};
    const view = render(
      <MarkdownRenderer incremental components={components} renderProbe={probe}>
        {'| name | result |'}
      </MarkdownRenderer>,
    );
    expect(view.container.querySelector('table')).toBeNull();

    view.rerender(
      <MarkdownRenderer incremental components={components} renderProbe={probe}>
        {'| name | result |\n| --- | --- |\n| check | pass |'}
      </MarkdownRenderer>,
    );
    expect(view.container.querySelector('table')?.textContent).toContain(
      'checkpass',
    );
    expect(mounts).toHaveBeenCalledTimes(1);
    expect(unmounts).not.toHaveBeenCalled();
  });

  test('station#365: a closed nested fence renders inside its list item', () => {
    const source = '- item\n\n    ```js\n    const nested = true;\n    ```';
    const view = render(
      <MarkdownRenderer incremental components={{}}>
        {source}
      </MarkdownRenderer>,
    );
    const item = view.container.querySelector('li');
    expect(item?.querySelector('pre code.language-js')?.textContent).toContain(
      'const nested = true;',
    );
  });

  // The console.warn latch is MODULE-GLOBAL and never resets: this must stay
  // the only fallback-triggering test in this file, or an earlier trigger
  // consumes the single warn and this test reds pointing at the wrong subject.
  test('splitter failure visibly falls back to the whole-text parser', () => {
    const error = new Error('injected splitter failure');
    const onFallback = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const view = render(
      <MarkdownRenderer
        incremental
        components={{}}
        splitBlocks={() => {
          throw error;
        }}
        renderProbe={{ onFallback }}
      >
        {'Still **visible**'}
      </MarkdownRenderer>,
    );

    expect(onFallback).toHaveBeenCalledWith(error);
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      'Incremental markdown splitter failed; using the canonical whole parse:',
      'injected splitter failure',
    );
    expect(view.container.querySelector('strong')?.textContent).toBe('visible');
    warning.mockRestore();
  });
});
