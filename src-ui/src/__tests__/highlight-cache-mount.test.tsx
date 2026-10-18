// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';
import { markdownCodeComponents } from '../components/chat/HighlightedCodeBlock';
import { highlightCode } from '../highlight/highlight-client';

const Code = markdownCodeComponents.code;
afterEach(() => vi.unstubAllGlobals());

test('a remounted code block includes its cached highlighting in its first render', async () => {
  vi.stubGlobal('Worker', undefined);
  const code = 'const remounted: number = 42;';
  // Populate the actual client cache through the real Shiki fallback.
  const highlighted = await highlightCode(code, 'typescript');
  expect(highlighted).toContain('<span');
  const first = () =>
    renderToStaticMarkup(<Code className="language-typescript">{code}</Code>);
  expect(first()).toContain(highlighted);
  // Different source and language do not borrow the warm entry. Static
  // rendering never runs the passive highlighting request for these misses.
  expect(
    renderToStaticMarkup(
      <Code className="language-typescript">const different = 7;</Code>,
    ),
  ).not.toContain('class="shiki');
  expect(
    renderToStaticMarkup(<Code className="language-javascript">{code}</Code>),
  ).not.toContain('class="shiki');
});
