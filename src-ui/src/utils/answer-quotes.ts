import type { OrchestrationQuoteSource } from '@kontourai/station-contracts/orchestration';

export const MAX_DRAFT_QUOTES = 3;
export const MAX_QUOTE_CHARS = 4096;
/** Terminal output is longer than an answer excerpt; it is sent as a literal block. */
export const MAX_TERMINAL_QUOTE_CHARS = 32 * 1024;
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

/**
 * Terminal output the person added to the draft ("Add to chat", #3994). It
 * names the directory the shell was in; it is context, not a source link.
 */
export interface SavedTerminalQuote {
  version: 1;
  kind: 'terminal';
  /** The Station the terminal ran on. */
  origin: string;
  /** Absent when the host could not tell the shell's directory. */
  cwd?: string;
  excerpt: string;
}

/** What a draft can quote: part of an answer, or terminal output. */
export type DraftQuote = SavedAnswerQuote | SavedTerminalQuote;

export function isTerminalQuote(
  quote: DraftQuote,
): quote is SavedTerminalQuote {
  return 'kind' in quote && quote.kind === 'terminal';
}

export function parseDraftQuote(value: unknown): DraftQuote | null {
  if (
    value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'terminal'
  ) {
    const row = value as Record<string, unknown>;
    const cwd = row.cwd;
    return row.version === 1 &&
      typeof row.origin === 'string' &&
      row.origin.length <= 2048 &&
      (cwd === undefined ||
        (typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 4096)) &&
      typeof row.excerpt === 'string' &&
      row.excerpt.trim() &&
      row.excerpt.length <= MAX_TERMINAL_QUOTE_CHARS
      ? {
          version: 1,
          kind: 'terminal',
          origin: row.origin,
          ...(typeof cwd === 'string' ? { cwd } : {}),
          excerpt: row.excerpt,
        }
      : null;
  }
  return parseSavedAnswerQuote(value);
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
/** A fence longer than any backtick run in `text`, so the text stays literal. */
function literalFence(text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return '`'.repeat(Math.max(3, longest + 1));
}

export function composeQuotedReply(
  text: string,
  quotes: readonly DraftQuote[],
): string {
  if (!quotes.length) return text;
  // Escape markdown metacharacters: a copied excerpt cannot create a live image,
  // instruction link or HTML element when the user's reply renders later.
  const escaped = (value: string) =>
    value.replace(/[\\`*_{}[\]()<>!#|]/g, '\\$&');
  return [
    text,
    ...quotes.map((quote) => {
      if (isTerminalQuote(quote)) {
        const fence = literalFence(quote.excerpt);
        return [
          quote.cwd
            ? `Terminal output (working directory: ${JSON.stringify(quote.cwd)}):`
            : 'Terminal output:',
          fence,
          quote.excerpt,
          fence,
        ].join('\n');
      }
      return `[Quoted answer](${quoteHref(quote)})\n\n${escaped(quote.excerpt)
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}`;
    }),
  ]
    .filter(Boolean)
    .join('\n\n');
}
