import ReactMarkdown from 'react-markdown';

/**
 * Deliberately isolated behind the rendered-preview lazy boundary: Markdown
 * parsing is only needed after a user selects the bounded rendered mode.
 */
export function InertRenderedMarkdown({ content }: { content: string }) {
  return (
    <section aria-label="Rendered Markdown preview">
      <ReactMarkdown
        skipHtml
        components={{
          a: ({ children }) => (
            <span data-markdown-link-omitted="true">{children}</span>
          ),
          img: ({ alt }) => (
            <span data-markdown-image-omitted="true">
              {alt ? `[Image omitted: ${alt}]` : '[Image omitted]'}
            </span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </section>
  );
}
