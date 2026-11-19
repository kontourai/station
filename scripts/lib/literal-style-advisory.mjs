import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript-api';
import { unquoteGitPath } from '../test-realtime-wait-gate.mjs';
import { execFileSyncBounded, spawnSyncBounded } from './bounded-capture.mjs';
import { cssDeclarations } from './css-declarations.mjs';

const ROOTS = [
  'src-ui/src',
  'src-ui/public',
  'packages/sdk/src',
  'packages/connect/src',
  'packages/basis-pane/src',
  'packages/board-pane/src',
];
const SOURCE_PATHS = ROOTS.flatMap((root) =>
  ['css', 'tsx', 'jsx'].map((ext) => `:(glob)${root}/**/*.${ext}`),
);
const EXCLUDED =
  /(?:^|\/)(?:__tests__|__fixtures__|__mocks__)\/|\.(?:test|spec|generated)\./;
const PROPERTY =
  /^(?:font-size|(?:row-|column-)?gap|padding(?:-(?:top|right|bottom|left|(?:block|inline)(?:-start|-end)?))?)$/;
const LENGTH = /^([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)(px|rem|em)$/i;

function literalLengths(value) {
  if (typeof value === 'number') return value === 0 ? [] : [`${value}px`];
  let depth = 0;
  const lengths = [];
  const tokens = value
    .replace(/\s*!\s*important\s*$/i, '')
    .matchAll(/[()]|[^\s()]+/g);
  for (const [token] of tokens) {
    if (token === '(') depth += 1;
    else if (token === ')') depth -= 1;
    else if (depth === 0) {
      const match = token.match(LENGTH);
      if (match && Number(match[1]) !== 0)
        lengths.push(Number(match[1]) + match[2].toLowerCase());
    }
  }
  return lengths;
}

function declarations(file, source) {
  if (file.endsWith('.css'))
    return cssDeclarations(source, { positions: true });
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.jsx') ? ts.ScriptKind.JSX : ts.ScriptKind.TSX,
  );
  const found = [];
  function visit(node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(ast) === 'style' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isObjectLiteralExpression(node.initializer.expression)
    ) {
      for (const member of node.initializer.expression.properties) {
        if (
          !ts.isPropertyAssignment(member) ||
          !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
        )
          continue;
        const { initializer } = member;
        if (
          !ts.isNumericLiteral(initializer) &&
          !ts.isStringLiteralLike(initializer)
        )
          continue;
        found.push({
          property: member.name.text.replace(
            /[A-Z]/g,
            (letter) => `-${letter.toLowerCase()}`,
          ),
          value: ts.isNumericLiteral(initializer)
            ? Number(initializer.text)
            : initializer.text,
          offset: member.getStart(ast),
          end: member.end,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return found;
}

function literalStyles(file, source) {
  const starts = ts.computeLineStarts(source);
  return declarations(file, source).flatMap(
    ({ property, value, offset, end }) => {
      if (!PROPERTY.test(property)) return [];
      const lengths = literalLengths(value);
      if (lengths.length === 0) return [];
      const first =
        ts.computeLineAndCharacterOfPosition(starts, offset).line + 1;
      const last =
        ts.computeLineAndCharacterOfPosition(starts, end - 1).line + 1;
      return [{ property, value: lengths.join(' '), first, last }];
    },
  );
}

function changedFiles(diff) {
  const files = new Map();
  let oldPath;
  let lines;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = undefined;
      lines = undefined;
    } else if (!lines && line.startsWith('--- ')) {
      const from = unquoteGitPath(line.slice(4).replace(/\t$/, ''));
      if (from.startsWith('a/')) oldPath = from.slice(2);
    } else if (!lines && line.startsWith('+++ ')) {
      const path = unquoteGitPath(line.slice(4).replace(/\t$/, ''));
      if (!path.startsWith('b/') || EXCLUDED.test(path)) continue;
      lines = new Set();
      files.set(path.slice(2), { oldPath, lines });
    } else if (lines) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!hunk) continue;
      const first = Number(hunk[1]);
      const count = Number(hunk[2] ?? 1);
      for (let offset = 0; offset < count; offset += 1)
        lines.add(first + offset);
    }
  }
  return files;
}

function newLiteralStyles(current, previous, lines) {
  const inherited = new Map();
  const keyOf = ({ property, value }) => `${property}:${value}`;
  for (const declaration of previous) {
    const key = keyOf(declaration);
    inherited.set(key, (inherited.get(key) ?? 0) + 1);
  }
  const candidates = new Map();
  for (const declaration of current) {
    let line = declaration.first;
    while (lines && !lines.has(line) && line <= declaration.last) line += 1;
    const key = keyOf(declaration);
    if (line > declaration.last) {
      inherited.set(key, (inherited.get(key) ?? 0) - 1);
      continue;
    }
    const group = candidates.get(key) ?? [];
    group.push({ ...declaration, line });
    candidates.set(key, group);
  }
  // Unchanged occurrences consume inheritance first. Several changed lines
  // can still share a signature, so the remaining count may be ambiguous.
  return [...candidates].flatMap(([key, group]) => {
    const remaining = Math.max(0, inherited.get(key) ?? 0);
    if (remaining >= group.length) return [];
    if (remaining === 0) return group;
    const candidateLines = [...new Set(group.map(({ line }) => line))];
    return [{ ...group[0], candidateLines, count: group.length - remaining }];
  });
}

export function reportLiteralStyles(root = process.cwd()) {
  const options = { cwd: root, encoding: 'utf8' };
  const git = (args) => execFileSyncBounded('git', args, options);
  const target = process.env.STATION_CI_FAST_BASE || 'origin/main';
  const ref = (args) => {
    const result = spawnSyncBounded('git', args, options);
    if (result.error) throw result.error;
    return result.status === 0 ? result.stdout.trim() : undefined;
  };
  const mergeBase = ref(['merge-base', '--', 'HEAD', target]);
  const base = mergeBase ?? ref(['rev-parse', '--verify', 'HEAD']);
  if (!mergeBase) {
    const scope = base
      ? 'working-tree changes against HEAD'
      : 'untracked files';
    console.warn(
      `Literal style advisory: no merge base for ${target}; reviewing ${scope}.`,
    );
  }
  const files = base
    ? changedFiles(
        git([
          'diff',
          '--find-renames',
          '--unified=0',
          '--no-color',
          '--no-ext-diff',
          '--no-textconv',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          '--diff-filter=AMR',
          base,
          '--',
          ...SOURCE_PATHS,
        ]),
      )
    : new Map();
  for (const file of git([
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...SOURCE_PATHS,
  ]).split('\0')) {
    if (file && !EXCLUDED.test(file)) files.set(file, {});
  }
  for (const [file, { oldPath, lines }] of files) {
    if (lines?.size === 0) continue;
    const current = literalStyles(
      file,
      readFileSync(resolve(root, file), 'utf8'),
    );
    if (current.length === 0) continue;
    const previous = oldPath
      ? literalStyles(oldPath, git(['show', `${base}:${oldPath}`]))
      : [];
    for (const {
      line,
      property,
      value,
      candidateLines,
      count,
    } of newLiteralStyles(current, previous, lines)) {
      const guidance =
        property === 'font-size'
          ? 'Check the shared text role or published --k-text-* size token in both density modes.'
          : 'Check the owning component’s spacing recipe or published --k-space-* token.';
      if (candidateLines) {
        const noun = count === 1 ? 'declaration' : 'declarations';
        const singleLine = candidateLines.length === 1;
        const location = singleLine ? `${file}:${line}` : file;
        const candidates = singleLine
          ? ''
          : ` among changed lines ${candidateLines.join(', ')}`;
        console.warn(
          `${location}: literal style advisory: ${count} new ${property} ${noun} using ${value}${candidates}. ${guidance}`,
        );
      } else {
        console.warn(
          `${file}:${line}: literal style advisory: ${property} uses ${value}. ${guidance}`,
        );
      }
    }
  }
}
