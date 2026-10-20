/**
 * Tracked-file inventory and comment extraction for the code hygiene checks
 * (docs/guides/code-hygiene.md).
 *
 * The checks read what a reviewer reads: comments in code, and prose in
 * Markdown. Extraction is a small per-language scanner, not a parser. Its
 * known limits: a JavaScript regular-expression literal that contains a quote
 * can hide the rest of its line, and a Rust lifetime is not mistaken for a
 * character literal only because `'` is not treated as a string delimiter in
 * Rust. Both errors are bounded to one line and the checks are advisory.
 */
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { execFileSyncBounded } from '../bounded-capture.mjs';

/** Files above this size are generated data, not hand-maintained text. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const C_LIKE = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.rs',
  '.swift',
  '.kt',
  '.kts',
  '.java',
  '.go',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.m',
  '.scss',
  '.gradle',
]);
const BLOCK_ONLY = new Set(['.css']);
const HASH = new Set([
  '.yml',
  '.yaml',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.toml',
  '.ps1',
]);
const HASH_BASENAMES = new Set(['Dockerfile', 'Makefile', 'Caddyfile']);
const MARKUP = new Set(['.html', '.vue', '.svelte']);
const MARKDOWN = new Set(['.md', '.mdx']);

/**
 * How a path's text is read: `markdown` (prose), a comment syntax, or `null`
 * when the file carries neither (JSON, images, lockfiles).
 */
export function textKind(path) {
  const name = basename(path);
  const extension = extname(name).toLowerCase();
  if (MARKDOWN.has(extension)) return 'markdown';
  if (C_LIKE.has(extension)) return extension === '.rs' ? 'rust' : 'c-like';
  if (BLOCK_ONLY.has(extension)) return 'css';
  if (HASH.has(extension) || HASH_BASENAMES.has(name.split('.')[0]))
    return 'hash';
  if (MARKUP.has(extension)) return 'markup';
  return null;
}

const SEGMENT_TESTS = new Set([
  '__tests__',
  '__test-utils__',
  '__mocks__',
  'test-support',
  'test-utils',
]);

/** Fixture data: copied or generated shapes, never maintained prose. */
export function isFixturePath(path) {
  const segments = path.split('/');
  if (segments.some((segment) => /fixtures?$/i.test(segment))) return true;
  return /[.-]fixtures?\./i.test(segments.at(-1));
}

/** Test sources, test helpers and fixtures. */
export function isTestPath(path) {
  if (isFixturePath(path)) return true;
  const segments = path.split('/');
  if (segments[0] === 'tests' || segments[0] === 'e2e') return true;
  if (segments.some((segment) => SEGMENT_TESTS.has(segment))) return true;
  return /\.(test|spec|e2e)\.[cm]?[jt]sx?$/.test(segments.at(-1));
}

/**
 * Every tracked path under `root`. A root that is not a Git checkout cannot
 * be inventoried; the error propagates so the caller reports that the check
 * could not run instead of reporting an empty tree as clean.
 */
export function trackedFiles(root) {
  return execFileSyncBounded('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\0')
    .filter(Boolean);
}

/** The file's text, or `null` when it is missing, binary or oversized. */
export function readText(root, path) {
  let buffer;
  try {
    buffer = readFileSync(join(root, path));
  } catch {
    // A tracked path deleted in the working tree has nothing to scan.
    return null;
  }
  if (buffer.length > MAX_TEXT_BYTES || buffer.includes(0)) return null;
  return buffer.toString('utf8');
}

/**
 * Comment text of a code file as `{ line, text }` entries, one per physical
 * line (1-based). Strings are skipped so a literal that merely contains `//`
 * or `#` is not read as a comment.
 */
export function commentLines(kind, text) {
  if (kind === 'hash') return hashComments(text);
  if (kind === 'markup') return markupComments(text);
  return slashComments(text, {
    lineComments: kind !== 'css',
    quoteIsString: kind !== 'rust',
    templates: kind === 'c-like',
  });
}

function slashComments(text, { lineComments, quoteIsString, templates }) {
  const out = [];
  let line = 1;
  let state = 'code';
  let quote = '';
  let current = '';
  let currentLine = 1;
  const flush = () => {
    if (current.trim()) out.push({ line: currentLine, text: current });
    current = '';
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (state === 'line') {
      if (char === '\n') {
        flush();
        state = 'code';
        line += 1;
      } else current += char;
      continue;
    }
    if (state === 'block') {
      if (char === '*' && next === '/') {
        flush();
        state = 'code';
        index += 1;
      } else if (char === '\n') {
        flush();
        line += 1;
        currentLine = line;
      } else current += char;
      continue;
    }
    if (state === 'string') {
      if (char === '\\') {
        if (next === '\n') line += 1;
        index += 1;
      } else if (char === quote) state = 'code';
      else if (char === '\n') {
        line += 1;
        // An unterminated single-line string ends at the line break, which
        // bounds the damage of a misread quote to one line.
        if (quote !== '`') state = 'code';
      }
      continue;
    }
    if (char === '\n') {
      line += 1;
      continue;
    }
    if (lineComments && char === '/' && next === '/') {
      state = 'line';
      currentLine = line;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block';
      currentLine = line;
      index += 1;
      continue;
    }
    if (char === '"' || (quoteIsString && char === "'")) {
      state = 'string';
      quote = char;
      continue;
    }
    if (templates && char === '`') {
      state = 'string';
      quote = '`';
    }
  }
  if (state === 'line' || state === 'block') flush();
  return out;
}

function hashComments(text) {
  const out = [];
  for (const [index, raw] of text.split('\n').entries()) {
    let quote = '';
    for (let column = 0; column < raw.length; column += 1) {
      const char = raw[column];
      if (quote) {
        if (char === '\\') column += 1;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '#' && (column === 0 || /\s/.test(raw[column - 1]))) {
        const comment = raw.slice(column + 1);
        if (comment.trim()) out.push({ line: index + 1, text: comment });
        break;
      }
    }
  }
  return out;
}

function markupComments(text) {
  const out = [];
  const pattern = /<!--([\s\S]*?)-->/g;
  for (const match of text.matchAll(pattern)) {
    const startLine = text.slice(0, match.index).split('\n').length;
    for (const [offset, part] of match[1].split('\n').entries()) {
      if (part.trim()) out.push({ line: startLine + offset, text: part });
    }
  }
  return out;
}

/**
 * Markdown prose as `{ line, text }`: fenced blocks are dropped and inline
 * code spans are blanked, so documented examples of a pattern are not read
 * as instances of it.
 */
export function markdownProse(text) {
  const out = [];
  let fence = '';
  for (const [index, raw] of text.split('\n').entries()) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (
        opener &&
        opener[1][0] === fence[0] &&
        opener[1].length >= fence.length
      )
        fence = '';
      continue;
    }
    if (opener) {
      fence = opener[1];
      continue;
    }
    const prose = raw.replace(/(`+)[^`]*?\1/g, (span) =>
      ' '.repeat(span.length),
    );
    if (prose.trim()) out.push({ line: index + 1, text: prose });
  }
  return out;
}

/** Readable lines of a tracked file for the hygiene checks, or `[]`. */
export function scannableLines(root, path) {
  const kind = textKind(path);
  if (!kind) return [];
  const text = readText(root, path);
  if (text === null) return [];
  return kind === 'markdown' ? markdownProse(text) : commentLines(kind, text);
}
