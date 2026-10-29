/**
 * Line tokens for the File Preview pane, produced by the same Shiki grammar
 * set the chat highlighter uses (worker first, main thread as its fallback).
 *
 * The preview does not take Shiki's HTML: it renders every token as a React
 * text node, so workspace content is never parsed as markup, and it keeps its
 * own per-line anchors, requested-line tint and wrap. Tokens therefore carry
 * only text and the syntax role Shiki chose. The shared theme
 * (`station-syntax-theme.ts`) spells every role as a Station variable, so a
 * token's colour is already the measured rung (`var(--syntax-keyword)`,
 * #2140) and follows the light theme and palette themes through the cascade.
 * Ordinary text (`SYNTAX_FOREGROUND`) carries no colour and inherits.
 *
 * Entry-safe: type-only imports, no Shiki at runtime.
 */
import type { HighlighterCore } from './core-highlighter';
import { SYNTAX_FOREGROUND, THEME } from './shared';

/** One run of same-coloured text; `color` is a `var(--syntax-*)` role. */
export interface PreviewToken {
  content: string;
  color?: string;
}

const SYNTAX_ROLE = /^var\(--syntax-[a-z]+\)$/;

/**
 * Whether `color` is a Station syntax role the pane may paint. Tokens cross a
 * worker boundary and land in `style`, so anything else, including the plain
 * foreground, renders as ordinary text.
 */
export function isPreviewSyntaxRole(color: string | undefined): boolean {
  return (
    color !== undefined &&
    color !== SYNTAX_FOREGROUND &&
    SYNTAX_ROLE.test(color)
  );
}

export type PreviewTokenLine = PreviewToken[];

/**
 * Lines longer than this are left untokenized by Shiki (they come back as one
 * plain token). Minified bundles otherwise cost the grammar seconds per line.
 */
const PREVIEW_TOKENIZE_MAX_LINE_LENGTH = 2_000;
/** Per-line grammar time limit; a line that exceeds it stays plain. */
const PREVIEW_TOKENIZE_TIME_LIMIT_MS = 200;

/**
 * Tokenize `code` for the preview. Adjacent runs of the same colour are
 * merged, so a line costs one React node per colour change, not per scope.
 */
export function tokenizeForPreview(
  highlighter: Pick<HighlighterCore, 'codeToTokensBase'>,
  code: string,
  lang: string,
): PreviewTokenLine[] {
  const lines = highlighter.codeToTokensBase(code, {
    lang,
    theme: THEME,
    tokenizeMaxLineLength: PREVIEW_TOKENIZE_MAX_LINE_LENGTH,
    tokenizeTimeLimit: PREVIEW_TOKENIZE_TIME_LIMIT_MS,
  });
  return lines.map((line) => {
    const merged: PreviewTokenLine = [];
    for (const token of line) {
      const color = isPreviewSyntaxRole(token.color) ? token.color : undefined;
      const previous = merged.at(-1);
      if (previous && previous.color === color) {
        previous.content += token.content;
      } else {
        merged.push(
          color
            ? { content: token.content, color }
            : { content: token.content },
        );
      }
    }
    return merged;
  });
}
