import { memo } from 'react';
import type { Options } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownCodeComponents } from './HighlightedCodeBlock';

function MarkdownRendererComponent(options: Options) {
  // station#3354 — code blocks highlight by default: the code component
  // lives here in the async renderer chunk, so eager callers never need to
  // import it (keeping the worker-backed highlight machinery out of the
  // entry bundle).
  //
  // The default is all-or-nothing: an explicit `components` prop REPLACES
  // this map entirely rather than merging into it, so a caller overriding
  // only `a` would silently lose highlighting. As of this change NO caller
  // passes `components` at all — the one component map left in the tree
  // (workspace-panes/InertRenderedMarkdown.tsx) renders its own
  // `ReactMarkdown` and never reaches here — so the trap is latent, not
  // live. It is documented because the first caller to override a single
  // element will hit it: such a caller must spread `markdownCodeComponents`
  // into its own map.
  return (
    <ReactMarkdown
      {...options}
      components={options.components ?? markdownCodeComponents}
      remarkPlugins={[remarkGfm]}
    />
  );
}

export const MarkdownRenderer = memo(MarkdownRendererComponent);
