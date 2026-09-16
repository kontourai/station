/**
 * #2093 — incremental re-highlight for growing streamed code blocks.
 *
 * A streamed block arrives flush by flush (~80ms), and every flush used to
 * re-tokenize the whole block: worker cost per block was O(frames × length),
 * and each intermediate full-code key entered the page-wide LRU (see the
 * cache-flush note on `highlight-client.ts`). This store resumes tokenization
 * from the previous flush's grammar state, so only appended lines are
 * tokenized and cost per block drops toward O(length).
 *
 * Soundness: tokenization of a prefix is fixed once the prefix is fixed, so
 * resuming from the end state of a `\n`-terminated prefix yields exactly the
 * full highlight. The `\n` requirement is structural, not cosmetic: a suffix
 * that continues the prefix's last line would need its own `<span
 * class="line">` merged into the previous line's span, so mid-line growth
 * takes the full path instead. `spliceHtml` returning null (unexpected Shiki
 * output shape) also falls back to full — correctness first, and the
 * merge-equality test trips loudly if Shiki's output shape ever changes.
 *
 * State capture costs a second tokenize pass on the full path (`codeToHast`
 * beside `codeToHtml`), so a block seen once costs two passes instead of one.
 * That is the whole price of admission: repeats are served from the store or
 * the client LRU, and every later flush of a growing block resumes instead of
 * re-tokenizing the prefix. Both the worker and the main-thread fallback
 * drive this same store, so degraded mode keeps the behavior.
 */

import type { GrammarState, HighlighterCore } from 'shiki/core';

/** The two Shiki operations a resume needs, over any highlighter instance. */
export interface SessionTokenizer {
  highlightFull(
    code: string,
    lang: string,
  ): { html: string; state: GrammarState | undefined };
  highlightSuffix(
    suffix: string,
    lang: string,
    state: GrammarState,
  ): { html: string; state: GrammarState | undefined };
}

function captureState(
  highlighter: HighlighterCore,
  text: string,
  lang: string,
  theme: string,
  state?: GrammarState,
): GrammarState | undefined {
  try {
    const hast =
      state === undefined
        ? highlighter.codeToHast(text, { lang, theme })
        : highlighter.codeToHast(text, { lang, theme, grammarState: state });
    return highlighter.getLastGrammarState(hast) ?? undefined;
  } catch {
    // State capture is an optimization: without it the next append takes the
    // full path, which is exactly today's behavior.
    return undefined;
  }
}

/**
 * Session tokenizer over a real Shiki core instance. One shared
 * implementation for the worker and the main-thread fallback, so degraded
 * mode keeps resume behavior instead of forking it.
 */
export function sessionTokenizerFor(
  highlighter: HighlighterCore,
  theme: string,
): SessionTokenizer {
  return {
    highlightFull: (code: string, lang: string) => ({
      html: highlighter.codeToHtml(code, { lang, theme }),
      state: captureState(highlighter, code, lang, theme),
    }),
    highlightSuffix: (suffix: string, lang: string, state: GrammarState) => ({
      html: highlighter.codeToHtml(suffix, {
        lang,
        theme,
        grammarState: state,
      }),
      state: captureState(highlighter, suffix, lang, theme, state),
    }),
  };
}

interface SessionEntry {
  code: string;
  lang: string;
  html: string;
  state: GrammarState | undefined;
}

const CODE_OPEN = '<code>';
const CODE_CLOSE = '</code>';

/**
 * A trailing `\n` opens an empty line span — the cursor the next flush will
 * fill. Verified against real Shiki output: `codeToHtml('a\n')` ends its
 * `<code>` with `\n<span class="line"></span>`, and `codeToHtml('a\nb\n')`
 * is that prefix with the empty span replaced by the continuation lines.
 * The `\n` itself is the line separator and stays; only the empty span goes.
 */
const CURSOR_LINE_SPAN = '<span class="line"></span>';

/**
 * Merge a suffix highlight into a previous full highlight. Both inputs are
 * `codeToHtml` outputs for the same language, theme, and options; the result
 * must equal `codeToHtml(previous.code + suffix)`. Returns null when either
 * side does not have the expected shape, and the caller falls back to full.
 */
function spliceHtml(
  previousFull: string,
  suffixFull: string,
): string | null {
  const previousClose = previousFull.lastIndexOf(CODE_CLOSE);
  const suffixOpen = suffixFull.indexOf(CODE_OPEN);
  const suffixClose = suffixFull.lastIndexOf(CODE_CLOSE);
  if (previousClose === -1 || suffixOpen === -1 || suffixClose === -1) {
    return null;
  }
  const suffixInnerStart = suffixOpen + CODE_OPEN.length;
  if (suffixClose <= suffixInnerStart) return null;
  const previousInner = previousFull.slice(
    previousFull.indexOf(CODE_OPEN) + CODE_OPEN.length,
    previousClose,
  );
  // The previous code ends with `\n`, so its inner must end with the `\n`
  // plus the empty cursor span; anything else means Shiki's shape changed and
  // this merge is not sound. Drop the cursor span — the suffix content fills
  // that line — but keep the `\n`, which separates it from the last real line.
  if (!previousInner.endsWith(`\n${CURSOR_LINE_SPAN}`)) return null;
  return (
    previousFull.slice(0, previousClose - CURSOR_LINE_SPAN.length) +
    suffixFull.slice(suffixInnerStart, suffixClose) +
    previousFull.slice(previousClose)
  );
}

/**
 * Bounded resume store. Matching is transparent (longest reusable prefix),
 * so callers keep posting full code and the store decides per request.
 */
export class IncrementalHighlightStore {
  private entries: SessionEntry[] = [];

  constructor(private readonly maxEntries = 16) {}

  /** Test-only visibility into the session bound. */
  get size(): number {
    return this.entries.length;
  }

  highlight(tokenizer: SessionTokenizer, code: string, lang: string): string {
    const exact = this.entries.find(
      (entry) => entry.lang === lang && entry.code === code,
    );
    if (exact) {
      this.touch(exact);
      return exact.html;
    }
    const reusable = this.findReusable(code, lang);
    if (reusable) {
      const suffix = code.slice(reusable.code.length);
      if (suffix === '') {
        this.touch(reusable);
        return reusable.html;
      }
      if (reusable.state !== undefined) {
        try {
          const part = tokenizer.highlightSuffix(suffix, lang, reusable.state);
          const merged = spliceHtml(reusable.html, part.html);
          if (merged !== null) {
            reusable.code = code;
            reusable.html = merged;
            reusable.state = part.state;
            this.touch(reusable);
            return merged;
          }
        } catch {
          // Suffix tokenization failed where the full path may still work.
        }
      }
    }
    const full = tokenizer.highlightFull(code, lang);
    this.store({ code, lang, html: full.html, state: full.state });
    return full.html;
  }

  private findReusable(code: string, lang: string): SessionEntry | undefined {
    let best: SessionEntry | undefined;
    for (const entry of this.entries) {
      if (entry.lang !== lang || entry.code === code) continue;
      if (!code.startsWith(entry.code)) continue;
      // Resume only from a complete last line; see the module comment.
      if (entry.code !== '' && !entry.code.endsWith('\n')) continue;
      if (!best || entry.code.length > best.code.length) best = entry;
    }
    return best;
  }

  private touch(entry: SessionEntry): void {
    const index = this.entries.indexOf(entry);
    if (index !== -1) this.entries.splice(index, 1);
    this.entries.push(entry);
  }

  private store(entry: SessionEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) this.entries.shift();
  }
}
