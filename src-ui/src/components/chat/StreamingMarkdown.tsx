import { memo } from 'react';
import { LazyMarkdown } from './LazyMarkdown';

/**
 * archive#3354 — markdown for text that is still growing.
 *
 * The lazy renderer splits definition-free append-only source into keyed
 * blocks. Completed blocks retain memoized parser output; only the growing tail
 * is reconsidered. If any reference-link/image or footnote definition appears,
 * the renderer automatically uses one canonical whole parse because those
 * constructs share context across blocks. Open fences and incomplete table
 * headers stay visible as plain source until enough bytes arrive to parse them
 * honestly. Settled messages use the normal full-render path in `LazyMarkdown`.
 */
function StreamingMarkdownComponent({ content }: { content: string }) {
  return <LazyMarkdown incremental>{content}</LazyMarkdown>;
}

export const StreamingMarkdown = memo(StreamingMarkdownComponent);
