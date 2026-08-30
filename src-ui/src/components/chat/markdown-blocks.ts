export type MarkdownBlockKind = 'settled' | 'provisional';

export type MarkdownBlockFlavor = 'plain' | 'fence' | 'table';

export type MarkdownBlockProvisionalReason =
  | 'tail'
  | 'open-fence'
  | 'incomplete-table';

export interface MarkdownBlock {
  /** Zero-based, inclusive source line. Stable while text is appended. */
  startLine: number;
  /** Zero-based, inclusive source line. */
  endLine: number;
  /** Exact source bytes for this block, including its line endings. */
  text: string;
  kind: MarkdownBlockKind;
  flavor: MarkdownBlockFlavor;
  provisionalReason?: MarkdownBlockProvisionalReason;
}

type SourceLine = {
  content: string;
  raw: string;
  number: number;
};

type FenceState = {
  character: '`' | '~';
  length: number;
  nested: boolean;
};

type LineShape = {
  blank: boolean;
  blockquote: boolean;
  listMarker: boolean;
  listContentIndent: number | null;
  normalized: string;
  sourceIndent: number;
};

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_MARKER = /^( {0,3})(?:[-+*]|\d{1,9}[.)])([ \t]+)(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const PARTIAL_TABLE_DELIMITER = /^[\s|:-]*$/;

function sourceLines(text: string): SourceLine[] {
  const result: SourceLine[] = [];
  let offset = 0;
  let number = 0;

  while (offset < text.length) {
    let end = offset;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
      end += 1;
    }

    let rawEnd = end;
    if (text[end] === '\r' && text[end + 1] === '\n') rawEnd = end + 2;
    else if (text[end] === '\r' || text[end] === '\n') rawEnd = end + 1;

    result.push({
      content: text.slice(offset, end),
      raw: text.slice(offset, rawEnd),
      number,
    });
    offset = rawEnd;
    number += 1;
  }

  return result;
}

function leadingSpaces(value: string): number {
  let count = 0;
  while (value[count] === ' ') count += 1;
  return count;
}

/**
 * Remove the block-container prefixes that may legally precede a fenced block.
 * This is deliberately a scanner, not a CommonMark parser: it recognizes the
 * container shapes needed to keep a growing list/blockquote fence in the same
 * stable source block without pulling markdown dependencies into the entry.
 */
function lineShape(line: string, activeListIndent: number | null): LineShape {
  let rest = line;
  let blockquote = false;

  while (true) {
    const quote = /^( {0,3})>[ \t]?/.exec(rest);
    if (!quote) break;
    blockquote = true;
    rest = rest.slice(quote[0].length);
  }

  const sourceIndent = leadingSpaces(rest);
  const marker = LIST_MARKER.exec(rest);
  if (marker) {
    const markerWidth = marker[0].length - marker[3].length;
    return {
      blank: marker[3].trim().length === 0,
      blockquote,
      listMarker: true,
      listContentIndent: markerWidth,
      normalized: marker[3],
      sourceIndent,
    };
  }

  let normalized = rest;
  if (activeListIndent !== null && sourceIndent >= activeListIndent) {
    normalized = rest.slice(activeListIndent);
  }

  return {
    blank: line.trim().length === 0,
    blockquote,
    listMarker: false,
    listContentIndent: null,
    normalized,
    sourceIndent,
  };
}

function fenceOpener(normalized: string): FenceState | null {
  const match = FENCE_OPEN.exec(normalized);
  if (!match) return null;
  const run = match[2];
  const info = match[3];
  if (run[0] === '`' && info.includes('`')) return null;
  return {
    character: run[0] as '`' | '~',
    length: run.length,
    nested: false,
  };
}

function closesFence(normalized: string, fence: FenceState): boolean {
  const match = FENCE_CLOSE.exec(normalized);
  const run = match?.[1];
  return Boolean(
    run && run[0] === fence.character && run.length >= fence.length,
  );
}

function classifyBlock(
  lines: SourceLine[],
  start: number,
  end: number,
  openFence: boolean,
): Pick<MarkdownBlock, 'flavor' | 'provisionalReason'> {
  if (openFence) {
    return { flavor: 'fence', provisionalReason: 'open-fence' };
  }

  let activeListIndent: number | null = null;
  let sawFence = false;
  const contentLines: string[] = [];
  for (let index = start; index < end; index += 1) {
    const shape = lineShape(lines[index].content, activeListIndent);
    if (shape.listContentIndent !== null) {
      activeListIndent = shape.listContentIndent;
    }
    const opener = fenceOpener(shape.normalized);
    if (opener) sawFence = true;
    if (!shape.blank) contentLines.push(shape.normalized);
  }

  if (sawFence) return { flavor: 'fence', provisionalReason: 'tail' };

  const header = contentLines[0]?.trim() ?? '';
  const delimiter = contentLines[1]?.trim();
  if (
    header.includes('|') &&
    (delimiter === undefined ||
      (PARTIAL_TABLE_DELIMITER.test(delimiter) &&
        !TABLE_DELIMITER.test(delimiter)))
  ) {
    return { flavor: 'table', provisionalReason: 'incomplete-table' };
  }
  if (header.includes('|') && delimiter && TABLE_DELIMITER.test(delimiter)) {
    return { flavor: 'table', provisionalReason: 'tail' };
  }

  return { flavor: 'plain', provisionalReason: 'tail' };
}

/**
 * Losslessly split growing markdown at source-stable block boundaries.
 *
 * Separator blank lines prefix the following block. The preceding source line
 * may still acquire its terminating newline, but its rendered markdown is
 * unchanged; the renderer's memo comparison treats that terminator as equal.
 */
export function splitMarkdownBlocks(markdown: string): MarkdownBlock[] {
  if (typeof markdown !== 'string') {
    throw new TypeError('Markdown source must be a string');
  }
  if (!markdown) return [];

  const lines = sourceLines(markdown);
  const blocks: MarkdownBlock[] = [];
  let blockStart = 0;
  let activeListIndent: number | null = null;
  let blockHasList = false;
  let blockHasBlockquote = false;
  let fence: FenceState | null = null;

  const finish = (end: number, settled: boolean, hasOpenFence = false) => {
    if (end <= blockStart) return;
    const classification = classifyBlock(lines, blockStart, end, hasOpenFence);
    blocks.push({
      startLine: lines[blockStart].number,
      endLine: lines[end - 1].number,
      text: lines
        .slice(blockStart, end)
        .map((line) => line.raw)
        .join(''),
      kind: settled ? 'settled' : 'provisional',
      flavor: classification.flavor,
      provisionalReason: settled ? undefined : classification.provisionalReason,
    });
  };

  const resetBlockState = () => {
    activeListIndent = null;
    blockHasList = false;
    blockHasBlockquote = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const shape = lineShape(lines[index].content, activeListIndent);
    if (shape.listContentIndent !== null) {
      activeListIndent = shape.listContentIndent;
      blockHasList = true;
    }
    if (shape.blockquote) blockHasBlockquote = true;

    if (fence) {
      if (closesFence(shape.normalized, fence)) {
        const wasNested = fence.nested;
        fence = null;
        if (!wasNested) {
          finish(index + 1, true);
          blockStart = index + 1;
          resetBlockState();
        }
      }
      continue;
    }

    const opener = fenceOpener(shape.normalized);
    if (opener) {
      if (!blockHasList && !blockHasBlockquote && index > blockStart) {
        finish(index, true);
        blockStart = index;
        resetBlockState();
      }
      opener.nested = blockHasList || blockHasBlockquote;
      fence = opener;
      continue;
    }

    if (!shape.blank) continue;

    let blockContainsOnlyBlanks = true;
    for (let prior = blockStart; prior < index; prior += 1) {
      if (lines[prior].content.trim().length > 0) {
        blockContainsOnlyBlanks = false;
        break;
      }
    }
    if (blockContainsOnlyBlanks) continue;

    let nextIndex = index + 1;
    while (
      nextIndex < lines.length &&
      lines[nextIndex].content.trim().length === 0
    ) {
      nextIndex += 1;
    }
    const next =
      nextIndex < lines.length
        ? lineShape(lines[nextIndex].content, activeListIndent)
        : null;
    const staysInList = Boolean(
      blockHasList &&
        next &&
        (next.listMarker ||
          (activeListIndent !== null && next.sourceIndent >= activeListIndent)),
    );
    const staysInQuote = Boolean(blockHasBlockquote && next?.blockquote);

    if (!staysInList && !staysInQuote) {
      // The blank separator belongs to the next block. The preceding line's
      // terminator stays on the preceding block for lossless line accounting.
      finish(index, true);
      blockStart = index;
      resetBlockState();
    }
  }

  finish(lines.length, false, fence !== null);
  return blocks;
}
