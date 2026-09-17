/**
 * Syntax-highlighted code block for ReactMarkdown.
 *
 * Usage:
 *   <ReactMarkdown components={markdownComponents}>...</ReactMarkdown>
 *
 * archive#3354 — highlighting is async and worker-backed: the Shiki call runs
 * in the highlight worker pool (loaded via dynamic import, so the worker
 * bootstrap stays out of the entry bundle) and the block renders a plain
 * <pre> until the HTML arrives. StreamingMarkdown owns unfinished fences.
 *
 * This module is referenced only from the async MarkdownRenderer chunk —
 * never from the entry bundle.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { CodeBlockFrame } from './CodeBlockFrame';

const LANG_REGEX = /language-(\S+)/;

function extractLang(className?: string): string | undefined {
  const match = className?.match(LANG_REGEX);
  return match?.[1];
}

/**
 * Requests worker-backed highlighting for a CLOSED code block. Resolves null
 * while pending and stays null on failure — the caller's plain <pre> is the
 * honest rendering in both cases (archive#3354: a wedged worker times out
 * and is recycled by the client, so pending is always bounded).
 *
 * #2093 — stale-while-revalidate with superseded-request coalescing.
 *
 * Before, every code change nulled the HTML (a flash of plain `<pre>` per
 * ~80ms flush) and fired its own worker request, so a burst queued one
 * full-block highlight per frame. Now the previous HTML stays up until its
 * replacement arrives, and while a highlight is in flight only the latest
 * code is remembered — intermediate flushes never reach the worker, so a
 * burst costs one in-flight plus one pending request. Out-of-order answers
 * are impossible (single worker, sequential handling) but the generation
 * check keeps that an invariant rather than an assumption.
 */
function useHighlightedHtml(code: string, lang?: string): string | null {
  const [html, setHtml] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  const trackingRef = useRef({
    generation: 0,
    inFlight: false,
    pending: null as string | null,
    settledLang: undefined as string | undefined,
  });

  useEffect(() => {
    if (!lang) return;
    const tracking = trackingRef.current;
    // A new language is a new block: drop stale HTML rather than showing
    // another language's colors until the new highlight arrives, and retire
    // any in-flight highlight for the old language so its answer cannot land
    // on this block.
    if (tracking.settledLang !== lang) {
      tracking.settledLang = lang;
      tracking.generation++;
      tracking.inFlight = false;
      tracking.pending = null;
      setHtml(null);
    }
    const request = (text: string) => {
      const generation = ++tracking.generation;
      tracking.inFlight = true;
      void import('../../highlight/highlight-client')
        .then(({ highlightCode }) => highlightCode(text, lang))
        .then(
          (result) => {
            if (!mountedRef.current || tracking.generation !== generation) {
              return;
            }
            tracking.inFlight = false;
            setHtml(result);
            const next = tracking.pending;
            tracking.pending = null;
            if (next !== null && next !== text) request(next);
          },
          () => {
            if (!mountedRef.current || tracking.generation !== generation) {
              return;
            }
            tracking.inFlight = false;
            tracking.pending = null;
            // Rejection with changed code: fall back to the plain <pre>,
            // which renders the CURRENT code honestly.
            setHtml(null);
          },
        );
    };
    if (tracking.inFlight) {
      tracking.pending = code;
    } else {
      request(code);
    }
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
