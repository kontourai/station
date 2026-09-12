import type { OrchestrationQuoteSource } from '@kontourai/station-contracts/orchestration';

export const MAX_DRAFT_QUOTES = 3;
export const MAX_QUOTE_CHARS = 4096;
const PREFIX = '#station-quote=';

export interface SavedAnswerQuote {
  version: 1;
  origin: string;
  sessionId: string;
  turnId: string;
  messageId: string;
  revision: string;
  excerpt: string;
}

/** Quotation is the user's saved context, never a grant or a verification claim. */
export function parseSavedAnswerQuote(value: unknown): SavedAnswerQuote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    typeof row.origin !== 'string' ||
    row.origin.length > 2048 ||
    !['sessionId', 'turnId', 'messageId'].every(
      (key) =>
        typeof row[key] === 'string' &&
        (row[key] as string).length > 0 &&
        (row[key] as string).length <= 1024,
    ) ||
    typeof row.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.revision) ||
    typeof row.excerpt !== 'string' ||
    !row.excerpt.trim() ||
    row.excerpt.length > MAX_QUOTE_CHARS
  )
    return null;
  try {
    const url = new URL(row.origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
  } catch {
    return null;
  }
  return {
    version: 1,
    origin: row.origin,
    sessionId: row.sessionId as string,
    turnId: row.turnId as string,
    messageId: row.messageId as string,
    revision: row.revision,
    excerpt: row.excerpt,
  };
}

export function quoteHref(quote: SavedAnswerQuote): string {
  const href = PREFIX + encodeURIComponent(JSON.stringify(quote));
  if (href.length > 48_000)
    throw new Error(
      'This quote is too large to retain its source link. Select a shorter excerpt.',
    );
  return href;
}
export function quoteFromHref(
  href: string | undefined,
): SavedAnswerQuote | null {
  if (!href?.startsWith(PREFIX) || href.length > 48_000) return null;
  try {
    return parseSavedAnswerQuote(
      JSON.parse(decodeURIComponent(href.slice(PREFIX.length))),
    );
  } catch {
    return null;
  }
}
export function quoteMatchesSource(
  quote: SavedAnswerQuote,
  source: OrchestrationQuoteSource,
): boolean {
  return (
    quote.sessionId === source.sessionId &&
    quote.turnId === source.turnId &&
    quote.messageId === source.messageId &&
    quote.revision === source.revision
  );
}
export function composeQuotedReply(
  text: string,
  quotes: readonly SavedAnswerQuote[],
): string {
  if (!quotes.length) return text;
  // Escape markdown metacharacters: a copied excerpt cannot create a live image,
  // instruction link or HTML element when the user's reply renders later.
  const escaped = (value: string) =>
    value.replace(/[\\`*_{}[\]()<>!#|]/g, '\\$&');
  return [
    text,
    ...quotes.map(
      (quote) =>
        `[Quoted answer](${quoteHref(quote)})\n\n${escaped(quote.excerpt)
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}
