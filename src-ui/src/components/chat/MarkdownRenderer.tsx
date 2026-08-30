import { memo, useEffect, useMemo } from 'react';
import type { Options } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { markdownCodeComponents } from './HighlightedCodeBlock';
import {
  type MarkdownBlock,
  markdownBlocksRequireWholeParse,
  splitMarkdownBlocks,
} from './markdown-blocks';

export type MarkdownRenderProbe = {
  onBlockMount?: (startLine: number) => void;
  onBlockRender?: (startLine: number) => void;
  onBlockUnmount?: (startLine: number) => void;
  onFallback?: (error: unknown) => void;
  onParse?: (startLine: number) => void;
};

export type MarkdownRendererProps = Options & {
  /**
   * Append-only streaming mode. Definition-free content uses memoized blocks;
   * reference/footnote definitions and settled callers use the full parser.
   */
  incremental?: boolean;
  /** Deterministic test seam for splitter failure and render-cost probes. */
  splitBlocks?: typeof splitMarkdownBlocks;
  renderProbe?: MarkdownRenderProbe;
};

const remarkPlugins: NonNullable<Options['remarkPlugins']> = [remarkGfm];

function FullMarkdown(options: Options) {
  return (
    <ReactMarkdown
      {...options}
      components={options.components ?? markdownCodeComponents}
      remarkPlugins={remarkPlugins}
    />
  );
}

type MarkdownBlockViewProps = {
  block: MarkdownBlock;
  options: Options;
  probe?: MarkdownRenderProbe;
};

function rendersAsSource(block: MarkdownBlock): boolean {
  return (
    block.provisionalReason === 'open-fence' ||
    block.provisionalReason === 'incomplete-table'
  );
}

function parsedTextIsEquivalent(previous: string, next: string): boolean {
  return previous.replace(/[\r\n]+$/, '') === next.replace(/[\r\n]+$/, '');
}

const MarkdownBlockView = memo(
  function MarkdownBlockView({
    block,
    options,
    probe,
  }: MarkdownBlockViewProps) {
    probe?.onBlockRender?.(block.startLine);
    useEffect(() => {
      probe?.onBlockMount?.(block.startLine);
      return () => probe?.onBlockUnmount?.(block.startLine);
    }, [block.startLine, probe]);

    if (rendersAsSource(block)) {
      return (
        <pre data-markdown-provisional={block.flavor}>
          <code>{block.text}</code>
        </pre>
      );
    }

    probe?.onParse?.(block.startLine);
    return <FullMarkdown {...options}>{block.text}</FullMarkdown>;
  },
  (previous, next) =>
    previous.block.startLine === next.block.startLine &&
    (previous.block.text === next.block.text ||
      (!rendersAsSource(previous.block) &&
        !rendersAsSource(next.block) &&
        parsedTextIsEquivalent(previous.block.text, next.block.text))) &&
    previous.block.flavor === next.block.flavor &&
    rendersAsSource(previous.block) === rendersAsSource(next.block) &&
    previous.options === next.options &&
    previous.probe === next.probe,
);

let warnedSplitterFallback = false;

/**
 * Canonical markdown renderer with an append-only optimization for streaming.
 * Definition-free streaming content is parsed as memoized source blocks; any
 * reference-link/image or footnote definition automatically escapes to one
 * whole-document parse so cross-block resolution stays canonical. Settled
 * content always takes that canonical whole-document path immediately.
 */
function MarkdownRendererComponent({
  incremental = false,
  splitBlocks = splitMarkdownBlocks,
  renderProbe,
  children,
  allowElement,
  allowedElements,
  components,
  disallowedElements,
  rehypePlugins,
  remarkRehypeOptions,
  skipHtml,
  unwrapDisallowed,
  urlTransform,
}: MarkdownRendererProps) {
  // archive#3354 — code blocks highlight by default: the code component
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
  const options = useMemo<Options>(
    () => ({
      allowElement,
      allowedElements,
      components: components ?? markdownCodeComponents,
      disallowedElements,
      rehypePlugins,
      remarkRehypeOptions,
      skipHtml,
      unwrapDisallowed,
      urlTransform,
    }),
    [
      allowElement,
      allowedElements,
      components,
      disallowedElements,
      rehypePlugins,
      remarkRehypeOptions,
      skipHtml,
      unwrapDisallowed,
      urlTransform,
    ],
  );

  // Settled messages must never show an incremental intermediate. This is an
  // early render path, so the first non-streaming commit is the canonical full
  // parse rather than an effect-driven correction after paint.
  if (!incremental || typeof children !== 'string') {
    return <FullMarkdown {...options}>{children}</FullMarkdown>;
  }

  let blocks: MarkdownBlock[];
  try {
    blocks = splitBlocks(children);
  } catch (error) {
    // Deterministic splitter failures recur every ~80ms flush; warn once so
    // the fallback is observable without flooding the console.
    if (!warnedSplitterFallback) {
      warnedSplitterFallback = true;
      console.warn(
        'Incremental markdown splitter failed; using the canonical whole parse:',
        error instanceof Error ? error.message : String(error),
      );
    }
    renderProbe?.onFallback?.(error);
    return <FullMarkdown {...options}>{children}</FullMarkdown>;
  }

  // Definitions are document-scoped: a link/image in one block may resolve
  // against a definition-only block elsewhere. Preserve canonical semantics by
  // escaping incremental parsing for these rare messages before any block is
  // rendered; definition-free content keeps the incremental fast path.
  if (markdownBlocksRequireWholeParse(blocks)) {
    return <FullMarkdown {...options}>{children}</FullMarkdown>;
  }

  const renderableBlocks = blocks.filter(
    (block) => block.text.trim().length > 0 || rendersAsSource(block),
  );
  return renderableBlocks.flatMap((block, index) => [
    index > 0 ? '\n' : null,
    <MarkdownBlockView
      key={block.startLine}
      block={block}
      options={options}
      probe={renderProbe}
    />,
  ]);
}

export const MarkdownRenderer = memo(MarkdownRendererComponent);
