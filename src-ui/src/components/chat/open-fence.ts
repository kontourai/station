/**
 * archive#3354 — split an unclosed trailing code fence out of streaming
 * markdown BEFORE it reaches the markdown renderer.
 *
 * Why at this layer: react-markdown/remark does NOT expose whether a fence
 * was closed — an unterminated fence parses as a code node running to end of
 * input, indistinguishable from a closed one inside the renderer. The only
 * reliable place to know is the raw text, where fence pairing is fully
 * deterministic per the CommonMark fence rules this scanner implements
 * (0–3 leading spaces; ``` or ~~~ runs; closer is the same character, at
 * least as long, trailing spaces only; a backtick fence's info string may
 * not contain a backtick).
 *
 * Line endings are normalised to `\n` before scanning. Without that neither
 * pattern can match a CRLF line at all — JS `.` does not match `\r` and `$`
 * is not multiline here — so the scanner degraded to a NO-OP on CRLF text
 * and reported every such document fully closed.
 *
 * Known blind spots, disclosed rather than fixed. This scanner has no
 * block-container state, so it does not recognise:
 *   - a fence inside a blockquote (`> ```js`) — the `>` marker means the
 *     line never matches an opener;
 *   - a fence indented 4+ spaces, which inside a list item is an ordinary
 *     fence but at top level is indented-code content. The opener pattern
 *     cannot tell those apart without container state, and accepting both
 *     would misread real top-level indented code, so neither is recognised.
 * Those two err in the costly direction: the document is reported CLOSED
 * while a fence is really still open, so the partial block reaches the
 * highlighter and is re-tokenized under a fresh content-addressed key on
 * every flush. That cost is NOT bounded to the streaming render. The
 * highlight LRU is module-global — one 300-entry cache in
 * `highlight/highlight-client.ts`, shared by every code block on the page —
 * so a blind-spot block flushing at ~80ms over a long stream writes hundreds
 * of distinct keys and evicts the cached HTML of settled messages elsewhere
 * in the transcript. It is a page-wide cache flush, which is exactly the harm
 * `StreamingMarkdown`'s own docstring names.
 *
 * A third blind spot errs the OTHER way and costs nothing: a fence line
 * inside a raw HTML block (`<div>\n```js\n…\n</div>`) is read as an opener
 * here, while this repo's remark parses the whole run as one `html` node with
 * no code node at all — so a document reported OPEN has no code block to
 * churn, and there is no `rehype-raw`, so that content is stripped from the
 * rendered output anyway. `<details>`/`<table>` wrappers written with the
 * blank lines markdown needs to work inside them do yield a real code node,
 * and the two agree there.
 *
 * The tests pin the two costly shapes, so a future container-aware scanner
 * shows up as a deliberate change rather than a surprise.
 */

export interface OpenFenceTail {
  /** Code after the opening fence line, verbatim. */
  code: string;
  /** First token of the info string, e.g. "ts" for ```ts foo=1. */
  lang?: string;
}

export interface SplitOpenFenceResult {
  /**
   * Markdown up to the open fence: every fence this scanner CAN see is
   * closed here. Not a guarantee that no partial block reaches the
   * highlighter — see the blind spots above.
   */
  closed: string;
  /** The in-progress trailing block, or null when every fence is closed. */
  openTail: OpenFenceTail | null;
}

const OPEN_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

export function splitOpenFence(markdown: string): SplitOpenFenceResult {
  // CommonMark counts \r\n and a lone \r as line endings; OPEN_FENCE and
  // CLOSE_FENCE cannot match either. Normalise before scanning — the returned
  // slices are of the normalised text, so they differ from the input in
  // exactly the \r bytes this replaces. That is invisible in the render (CSS
  // shows either as one break), but it is not a no-op INSIDE a code block:
  // this repo's remark keeps a lone \r as code content ('```txt\nx\ry\n```'
  // parses to the value "x\ry"), so for such input the streaming `openTail`
  // and the settled markdown path hand `CodeBlockFrame` different bytes, and
  // its copy button copies the `code` prop verbatim.
  const text =
    markdown.indexOf('\r') === -1 ? markdown : markdown.replace(/\r\n?/g, '\n');

  let inside = false;
  let openChar = '`';
  let openLength = 0;
  let openLineStart = 0;

  let lineStart = 0;
  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const line = text.slice(lineStart, lineEnd);

    if (!inside) {
      const match = OPEN_FENCE.exec(line);
      const info = match?.[3] ?? '';
      const fence = match?.[2] ?? '';
      const isBacktickFence = fence.startsWith('`');
      // A backtick fence's info string must not contain a backtick;
      // otherwise the line is just text (CommonMark §4.5).
      if (match && (!isBacktickFence || !info.includes('`'))) {
        inside = true;
        openChar = fence[0];
        openLength = fence.length;
        openLineStart = lineStart;
      }
    } else {
      const closer = CLOSE_FENCE.exec(line);
      if (closer?.[1].startsWith(openChar) && closer[1].length >= openLength) {
        inside = false;
      }
    }

    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  if (!inside) return { closed: text, openTail: null };

  const openBlock = text.slice(openLineStart);
  const firstNewline = openBlock.indexOf('\n');
  // A flush that ends exactly ON the opening fence line still knows its
  // language: the whole slice IS the header and the code is empty. Reading
  // the header as '' there dropped the language for one flush, so the frame
  // announced itself as `text` and then changed label on the next token.
  const header =
    firstNewline === -1 ? openBlock : openBlock.slice(0, firstNewline);
  const code = firstNewline === -1 ? '' : openBlock.slice(firstNewline + 1);
  const info = OPEN_FENCE.exec(header)?.[3]?.trim() ?? '';
  const lang = info ? info.split(/\s+/)[0] : undefined;
  return { closed: text.slice(0, openLineStart), openTail: { code, lang } };
}
