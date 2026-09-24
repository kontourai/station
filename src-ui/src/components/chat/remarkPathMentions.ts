/**
 * Path mentions in prose (`src/app.ts:42`, `` `README.md` ``) as link
 * CANDIDATES.
 *
 * A model names files far more often in running text and inline code than
 * in markdown links, and none of those were clickable. This plugin wraps
 * each path-shaped token in a link node marked `data-path-mention`; whether it
 * renders as a link at all is decided later, by `ChatMarkdownAnchor`, once the
 * server has said the file exists in the conversation's checkout. The pattern
 * can therefore afford to be generous — `Node.js` and `e.g.` match it and are
 * left as text because no such file exists — while a hallucinated or stale
 * path never becomes something to click.
 *
 * What it never touches: text already inside a link, fenced code, and HTML.
 * An inline-code span is a candidate only when the WHOLE span is one path, so
 * `` `npm run build` `` stays code.
 */

/** The attribute a candidate link carries into the rendered anchor. */
export const PATH_MENTION_ATTRIBUTE = 'data-path-mention';

/**
 * How many candidates one parse may produce. Bounds the existence checks a
 * single message can cause; later mentions stay text.
 */
export const PATH_MENTION_MAX_PER_PARSE = 64;

/**
 * An optional leading `/` or `./`, directory segments, and a last segment
 * whose extension starts with a letter, optionally followed by `:line`,
 * `:line:col` or `:start-end`. Segment lengths are bounded so a long run of
 * dotted text cannot make matching quadratic.
 */
const PATH_CORE = String.raw`(?:\/|\.\/)?(?:[\w@.+-]{1,255}\/){0,64}[\w@+-][\w@.+-]{0,254}\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d{1,9}(?::\d{1,9}|-\d{1,9})?)?`;

/**
 * The boundaries keep a mention from starting inside a word, a URL or another
 * path, and from ending before a further path segment.
 */
const PATH_MENTION = new RegExp(
  String.raw`(?<![\w/.@~:-])(${PATH_CORE})(?![\w/])`,
  'g',
);

/** The whole-string form, for inline code. */
const WHOLE_PATH_MENTION = new RegExp(`^${PATH_CORE}$`);

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hProperties?: Record<string, unknown> };
};

/** Exported for tests: the path-shaped tokens in one run of text. */
export function findPathMentions(
  text: string,
): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const match of text.matchAll(PATH_MENTION)) {
    const token = match[1] ?? '';
    // A bare `name.ext` with no directory must not be a sentence's last word
    // followed by the next one (`done.Next`) — require a lowercase-or-digit
    // extension there, which is what file extensions are.
    if (!token.includes('/') && !/\.[a-z][a-z0-9]*(?::|$)/.test(token))
      continue;
    const start = match.index ?? 0;
    found.push({ start, end: start + token.length });
  }
  return found;
}

export function isWholePathMention(value: string): boolean {
  return WHOLE_PATH_MENTION.test(value) && findPathMentions(value).length === 1;
}

function mentionLink(url: string, children: MdNode[]): MdNode {
  return {
    type: 'link',
    url,
    children,
    data: { hProperties: { [PATH_MENTION_ATTRIBUTE]: '' } },
  };
}

const SKIP = new Set(['link', 'linkReference', 'code', 'html', 'definition']);

export function remarkPathMentions() {
  return (tree: MdNode) => {
    let budget = PATH_MENTION_MAX_PER_PARSE;
    const visit = (node: MdNode) => {
      if (!node.children || SKIP.has(node.type)) return;
      const next: MdNode[] = [];
      for (const child of node.children) {
        if (budget <= 0) {
          next.push(child);
          continue;
        }
        if (child.type === 'inlineCode' && child.value) {
          if (isWholePathMention(child.value)) {
            budget -= 1;
            next.push(mentionLink(child.value, [child]));
          } else next.push(child);
          continue;
        }
        if (child.type === 'text' && child.value) {
          const value = child.value;
          let cursor = 0;
          for (const { start, end } of findPathMentions(value)) {
            if (budget <= 0) break;
            budget -= 1;
            if (start > cursor)
              next.push({ type: 'text', value: value.slice(cursor, start) });
            const token = value.slice(start, end);
            next.push(mentionLink(token, [{ type: 'text', value: token }]));
            cursor = end;
          }
          if (cursor === 0) next.push(child);
          else if (cursor < value.length)
            next.push({ type: 'text', value: value.slice(cursor) });
          continue;
        }
        visit(child);
        next.push(child);
      }
      node.children = next;
    };
    visit(tree);
  };
}
