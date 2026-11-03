import { type DraftQuote, isTerminalQuote } from '../../utils/answer-quotes';
import { Button } from '../Button';
import { QuoteSourceLink } from './QuoteSourceLink';

export function SourceQuoteDrafts({
  quotes,
  origin,
  onRemove,
}: {
  quotes: readonly DraftQuote[];
  origin: string;
  onRemove: (index: number) => void;
}) {
  if (!quotes.length) return null;
  return (
    <section className="source-quote-drafts" aria-label="Quoted context">
      {quotes.map((quote, index) => {
        const elsewhere = quote.origin !== origin;
        if (isTerminalQuote(quote))
          return (
            <div
              className="source-quote-draft source-quote-draft--terminal"
              key={`terminal:${index}`}
            >
              <p className="source-quote-draft__label" title={quote.cwd}>
                Terminal · {quote.cwd}
              </p>
              {elsewhere ? (
                <blockquote>This output belongs to another Station.</blockquote>
              ) : (
                <pre className="source-quote-draft__output">
                  {quote.excerpt}
                </pre>
              )}
              <Button
                variant="ghost"
                onClick={() => onRemove(index)}
                aria-label={`Remove terminal output ${index + 1}`}
              >
                Remove
              </Button>
            </div>
          );
        return (
          <div
            className="source-quote-draft"
            key={`${quote.sessionId}:${quote.messageId}:${index}`}
          >
            <blockquote>
              {elsewhere
                ? 'This quote belongs to another Station.'
                : quote.excerpt}
            </blockquote>
            <QuoteSourceLink quote={quote}>Inspect source</QuoteSourceLink>
            <Button
              variant="ghost"
              onClick={() => onRemove(index)}
              aria-label={`Remove quote ${index + 1}`}
            >
              Remove
            </Button>
          </div>
        );
      })}
    </section>
  );
}
