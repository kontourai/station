/**
 * Links found in terminal text. Only `http:` and `https:` URLs are links;
 * any other scheme stays plain text. Paths with a line (and column) become
 * editor targets. Detection works on one row's cells, so a match maps back
 * to exact columns even across wide characters.
 */

import { Attr, type RowCells } from './engine/frame';

export type TerminalLinkTarget =
  | { kind: 'url'; url: string }
  | { kind: 'path'; path: string; line: number; column?: number };

export interface TerminalLink {
  target: TerminalLinkTarget;
  /** Inclusive cell columns. */
  start: number;
  end: number;
}

/** Row text with, for every UTF-16 index, the cell column it came from. */
export function rowTextWithColumns(row: RowCells): {
  text: string;
  columns: number[];
} {
  let text = '';
  const columns: number[] = [];
  for (let x = 0; x < row.codepoints.length; x += 1) {
    const wide = (row.attrs[x]! & Attr.WIDE_MASK) >> Attr.WIDE_SHIFT;
    if (wide === 2 || wide === 3) continue;
    const cp = row.codepoints[x]!;
    const piece =
      row.clusters[x] ?? (cp === 0 ? ' ' : String.fromCodePoint(cp));
    for (let i = 0; i < piece.length; i += 1) columns.push(x);
    text += piece;
  }
  return { text, columns };
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/giu;
/** `src/a.ts:12`, `./x/y.py:3:7`, `C:\\dir\\f.rs:9:1`, `/abs/p.go:10`. */
const PATH_PATTERN =
  /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+\.[A-Za-z0-9]+:(\d+)(?::(\d+))?/gu;
const TRAILING = /[).,;:!?\]}>'"]+$/u;

/** Returns a URL only when it parses as http(s); everything else is text. */
export function safeHttpUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function findLinks(row: RowCells): TerminalLink[] {
  const { text, columns } = rowTextWithColumns(row);
  const links: TerminalLink[] = [];
  const taken: [number, number][] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING, '');
    const url = safeHttpUrl(raw);
    if (!url) continue;
    const from = match.index!;
    const to = from + raw.length - 1;
    taken.push([from, to]);
    links.push({
      target: { kind: 'url', url },
      start: columns[from]!,
      end: columns[to]!,
    });
  }
  for (const match of text.matchAll(PATH_PATTERN)) {
    const from = match.index!;
    const to = from + match[0].length - 1;
    if (taken.some(([a, b]) => from <= b && to >= a)) continue;
    const [whole, line, column] = match;
    const path = whole.slice(
      0,
      whole.length - (column ? `:${line}:${column}` : `:${line}`).length,
    );
    links.push({
      target: {
        kind: 'path',
        path,
        line: Number(line),
        ...(column ? { column: Number(column) } : {}),
      },
      start: columns[from]!,
      end: columns[to]!,
    });
  }
  return links;
}

export function linkAt(row: RowCells, x: number): TerminalLink | null {
  return (
    findLinks(row).find((link) => x >= link.start && x <= link.end) ?? null
  );
}
