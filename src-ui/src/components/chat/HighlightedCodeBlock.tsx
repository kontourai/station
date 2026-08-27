/**
 * Syntax-highlighted code block for ReactMarkdown.
 *
 * Usage:
 *   <ReactMarkdown components={markdownComponents}>...</ReactMarkdown>
 *
 * station#3354 — highlighting is async and worker-backed: the Shiki call runs
 * in the highlight worker pool (loaded via dynamic import, so the worker
 * bootstrap stays out of the entry bundle) and the block renders a plain
 * <pre> until the HTML arrives. Streaming callers additionally render an
 * in-progress (unclosed-fence) block via `StreamingOpenFence`, so a growing
 * block is never tokenized at all.
 *
 * This module is referenced only from the async MarkdownRenderer chunk —
 * never from the entry bundle.
 */

import { memo, useEffect, useState } from 'react';
import { CodeBlockFrame } from './CodeBlockFrame';

const LANG_REGEX = /language-(\S+)/;

function extractLang(className?: string): string | undefined {
  const match = className?.match(LANG_REGEX);
  return match?.[1];
}

/**
 * Requests worker-backed highlighting for a CLOSED code block. Resolves null
 * while pending and stays null on failure — the caller's plain <pre> is the
 * honest rendering in both cases (station#3354: a wedged worker times out
 * and is recycled by the client, so pending is always bounded).
 */
function useHighlightedHtml(code: string, lang?: string): string | null {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (!lang) return;
    let cancelled = false;
    setHtml(null);
    import('../../highlight/highlight-client')
      .then(({ highlightCode }) => highlightCode(code, lang))
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Worker wedge or failure: keep the plain <pre>.
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);
  return html;
}

const HighlightedCode = memo(function HighlightedCode({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const code = String(children).replace(/\n$/, '');
  const lang = extractLang(className);
  const html = useHighlightedHtml(code, lang);

  // Inline code (no language class) — render as-is
  if (!lang) {
    return <code className={className}>{children}</code>;
  }

  return <CodeBlockFrame lang={lang} code={code} html={html} />;
});

/**
 * ReactMarkdown components override — pass to `components` prop.
 */
export const markdownCodeComponents = {
  code: HighlightedCode,
};
