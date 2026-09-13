import type { SavedAnswerQuote } from '../../utils/answer-quotes';
import { Button } from '../Button';
import { QuoteSourceLink } from './QuoteSourceLink';

export function SourceQuoteDrafts({
  quotes,
  origin,
  onRemove,
}: {
  quotes: readonly SavedAnswerQuote[];
  origin: string;
  onRemove: (index: number) => void;
}) {
  if (!quotes.length) return null;
  return (
    <section className="source-quote-drafts" aria-label="Quoted context">
      {quotes.map((quote, index) => (
        <div
          className="source-quote-draft"
          key={`${quote.sessionId}:${quote.messageId}:${index}`}
        >
          <blockquote>
            {quote.origin === origin
              ? quote.excerpt
              : 'This quote belongs to another Station.'}
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
      ))}
    </section>
  );
}
