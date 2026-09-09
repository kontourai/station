/**
 * Path-read pin discovery (#1807).
 *
 * A test that reads a source file with `readFileSync(join(__dirname, ...))`
 * asserts something about that file's TEXT while having no import edge to it.
 * Neither `vitest related` nor the changed-verification selector can see the
 * dependency, so the pinned file can move and the pin stays unscheduled until
 * somebody runs the whole corpus. #1785 moved `useOutboundQueueSnapshot(...)`
 * out of `ChatDock.tsx`, and its pin sat red on `main` for exactly this
 * reason.
 *
 * This module recovers those edges from the pinning tests themselves. In a
 * test file that reads by path, it resolves every module-anchored path
 * expression — anything rooted at `__dirname`, `__filename`, or
 * `import.meta.url`, directly or through a `const` — and reports the
 * repository files those expressions name.
 *
 * Two deliberate choices:
 *
 * - It resolves EXPRESSIONS, not just the argument at the read call. The
 *   argument is frequently a callback parameter
 *   (`[join(__dirname, a), join(__dirname, b)].map((p) => readFileSync(p))`,
 *   `conversationContextBoundaryStatusCache.test.tsx`), and a dataflow
 *   evaluator good enough for that is a much larger thing to trust than a
 *   superset that over-selects. Over-selection costs a scheduled test; the
 *   omission this exists to prevent costs a silent red on `main`.
 * - Resolution is total-or-nothing. An expression this evaluator cannot fully
 *   resolve (a temp directory, a helper's return value) contributes no pin
 *   rather than a guessed one.
 *
 * WHAT THIS DOES NOT SEE. The scan is a partial derivation, not a census of
 * path-read pins, and it must not be read as one. 142 test files read by path
 * with a module anchor; this reports 79. Two idioms account for most of the
 * remainder, and both are missed by construction rather than by accident:
 *
 * - A HELPER PARAMETER. `const read = (p) => readFileSync(join(UI_SRC, p))`
 *   called with a literal never puts that literal syntactically inside an
 *   anchored expression, so nothing resolves. At least 14 files use this
 *   form, and the pins it hides include `ChatDockHeader.tsx`,
 *   `DockShell.tsx` and `ProjectLayoutRenderer.tsx` — the same directory and
 *   the same family of file as the #1785 incident this module exists to
 *   prevent recurring.
 * - A CWD-RELATIVE LITERAL. `readFileSync('src-ui/src/…')` is refused
 *   because an unanchored path is not a repository fact for this evaluator,
 *   and refusing it is what keeps `resolve('a/b')` from being read as a repo
 *   path.
 *
 * Those pins are no worse off than before this module existed, but they are
 * NOT covered: a green `path-read-pin-boundary` gate is evidence about the 79,
 * not about the class. Closing the helper form needs real intra-file
 * dataflow.
 *
 * The scan is the authority for the pins it does report:
 * `scripts/test-impact-manifest.mjs` derives its pin edges from it at gate
 * time, so a reported pin cannot be forgotten and a deleted one cannot
 * linger.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_FILE_PATTERN = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Roots that hold Vitest suites.
 *
 * `tests/` is deliberately absent. A Playwright spec there can read source by
 * path, but a pin is only useful if the selector can SCHEDULE the pinning
 * test, and `selection.tests` is fed straight to Vitest — which
 * `vitest.config.ts` excludes `tests/**` from. A spec importing
 * `node:child_process` would additionally fail the resource-classification
 * preflight (Playwright specs are never in `vitest-resource-manifest.mjs`),
 * turning an ordinary source change into an infrastructure error. The repo
 * schedules `tests/` through the `verify-e2e-full` LANE, and a supplemental
 * edge may not carry a lane, so a Playwright pin has no correct expression
 * here. Their pins are therefore out of scope for this mechanism.
 */
export const PIN_SCAN_ROOTS = Object.freeze([
  'packages',
  'scripts',
  'src-server',
  'src-ui',
]);

/**
 * Never scanned, never pinned. `fixtures` holds deliberate copies (including
 * the known-bad guardrail inputs) whose whole point is that they are data
 * rather than the source under test.
 *
 * The rest are roots `.gitignore` generates. A pin is reported whether or not
 * its target exists, so a resolved path under a generated root would pass on
 * the machine that built it and red the existence gate on a clean checkout —
 * with a message prescribing the wrong remedy.
 */
const EXCLUDED_DIRECTORIES = Object.freeze(
  new Set([
    '.amazonq',
    '.fallow',
    '.flow',
    '.flow-agents',
    '.git',
    '.kiro',
    '.kontour',
    '.kontourai',
    '.omx',
    '.station',
    '.surface',
    '__fixtures__',
    '__snapshots__',
    'binaries',
    'coverage',
    'event_persistence',
    'fixtures',
    'node_modules',
    'playwright-report',
    'qa-reports',
    'target',
    'test-results',
  ]),
);

/** Generated roots `.gitignore` names that are not a bare directory name. */
const EXCLUDED_PATH_PREFIXES = Object.freeze([
  'docs/audits/',
  'src-desktop/gen/',
]);

/** Build output roots: `dist`, `dist-ui`, `dist-server-<name>`, and friends. */
function isBuildOutputSegment(segment) {
  return segment === 'dist' || segment.startsWith('dist-');
}

/** Generated sources, e.g. `packages/basis-pane/src/*.generated.ts`. */
const GENERATED_FILE_PATTERN = /\.generated\.[cm]?[jt]sx?$/;

/** Pure `node:path` helpers plus the URL bridge. */
const PATH_HELPERS = Object.freeze(
  new Set(['join', 'resolve', 'normalize', 'dirname', 'fileURLToPath']),
);

/** Objects a `path` helper may be called on. */
const PATH_NAMESPACES = Object.freeze(new Set(['path', 'nodePath', 'posix']));

const MODULE_ANCHORS = Object.freeze(
  new Set(['__dirname', '__filename', 'import.meta.url']),
);

const READ_CALL_PATTERN = /\b(?:readFileSync|readFile)\s*\(/;

/**
 * Calls whose path arguments name something the test CREATES or REMOVES. A
 * planted negative control (`client-entry-portability`) resolves like any
 * other module-anchored path, but it is the test's own output, not a file the
 * repository has — so it is not a pin, and the existence gate must not demand
 * it.
 */
const WRITE_CALLS = Object.freeze(
  new Map([
    ['appendFile', [0]],
    ['appendFileSync', [0]],
    ['copyFile', [1]],
    ['copyFileSync', [1]],
    ['cp', [1]],
    ['cpSync', [1]],
    ['mkdir', [0]],
    ['mkdirSync', [0]],
    ['mkdtemp', [0]],
    ['mkdtempSync', [0]],
    ['rename', [1]],
    ['renameSync', [1]],
    ['rm', [0]],
    ['rmSync', [0]],
    ['symlink', [1]],
    ['symlinkSync', [1]],
    ['unlink', [0]],
    ['unlinkSync', [0]],
    ['writeFile', [0]],
    ['writeFileSync', [0]],
  ]),
);

function isExcludedPath(relativePath) {
  if (GENERATED_FILE_PATTERN.test(relativePath)) return true;
  if (EXCLUDED_PATH_PREFIXES.some((prefix) => relativePath.startsWith(prefix)))
    return true;
  return relativePath
    .split('/')
    .some(
      (segment) =>
        EXCLUDED_DIRECTORIES.has(segment) || isBuildOutputSegment(segment),
    );
}

function listTestFiles(root, scanRoots) {
  const found = [];
  const walk = (absolute) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (
          EXCLUDED_DIRECTORIES.has(entry.name) ||
          isBuildOutputSegment(entry.name) ||
          entry.name.startsWith('.')
        )
          continue;
        walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const repoPath = relative(root, child).split(sep).join('/');
      if (TEST_FILE_PATTERN.test(repoPath)) found.push(repoPath);
    }
  };
  for (const scanRoot of scanRoots) walk(join(root, scanRoot));
  return found.sort();
}

/* ------------------------------------------------------------------ *
 * A very small expression reader.
 *
 * It understands only the shapes a path pin is written in: string and
 * template literals, `__dirname`, `__filename`, `import.meta.url`, the pure
 * `node:path` helpers, `fileURLToPath`, `new URL(relative, base)`, and
 * identifiers bound to one of those by a `const`/`let` in the same file.
 * Every value carries whether it is ANCHORED — derived from this module's own
 * location — because only an anchored value names a repository path
 * deterministically. `resolve('a/b')` is cwd-relative and must not be read as
 * a repository path.
 * ------------------------------------------------------------------ */

const UNRESOLVED = Object.freeze({ value: undefined, anchored: false });

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const code = source.charCodeAt(index);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '/' && isRegexPosition(tokens)) {
      const next = skipRegexLiteral(source, index);
      if (next !== undefined) {
        tokens.push({ type: 'other', value: '/' });
        index = next;
        continue;
      }
    }
    if (char === "'" || char === '"') {
      const { value, next } = readQuoted(source, index, char);
      // An unterminated quote is a mis-read, not a parse failure: emit an
      // opaque token and carry on. Aborting the file would silently discard
      // every pin in it.
      if (value === undefined) {
        tokens.push({ type: 'other', value: char });
        index += 1;
        continue;
      }
      tokens.push({ type: 'string', value });
      index = next;
      continue;
    }
    if (char === '`') {
      const { parts, next } = readTemplate(source, index);
      if (!parts) {
        tokens.push({ type: 'other', value: char });
        index += 1;
        continue;
      }
      tokens.push({ type: 'template', parts });
      index = next;
      continue;
    }
    if (isNameStart(code)) {
      let end = index + 1;
      while (end < source.length && isNamePart(source.charCodeAt(end)))
        end += 1;
      tokens.push({ type: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if ('(),.[]!'.includes(char)) {
      tokens.push({ type: 'punct', value: char });
      index += 1;
      continue;
    }
    tokens.push({ type: 'other', value: char });
    index += 1;
  }
  return tokens;
}

function isNameStart(code) {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    code === 36
  );
}

function isNamePart(code) {
  return isNameStart(code) || (code >= 48 && code <= 57);
}

/**
 * A `/` starts a regex literal only where a value is expected. Getting this
 * wrong costs a few opaque tokens, never a wrong path: resolution is
 * total-or-nothing.
 */
function isRegexPosition(tokens) {
  const previous = tokens[tokens.length - 1];
  if (!previous) return true;
  if (previous.type === 'string' || previous.type === 'template') return false;
  if (previous.type === 'name') return false;
  return previous.value !== ')' && previous.value !== ']';
}

function skipRegexLiteral(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '\n') return undefined;
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return undefined;
}

function readQuoted(source, start, quote) {
  let index = start + 1;
  let value = '';
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      value += source[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (char === quote) return { value, next: index + 1 };
    if (char === '\n') return { value: undefined, next: index + 1 };
    value += char;
    index += 1;
  }
  return { value: undefined, next: source.length };
}

function readTemplate(source, start) {
  const parts = [];
  let literal = '';
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      literal += source[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (char === '`') {
      parts.push({ type: 'literal', value: literal });
      return { parts, next: index + 1 };
    }
    if (char === '$' && source[index + 1] === '{') {
      parts.push({ type: 'literal', value: literal });
      literal = '';
      let depth = 1;
      let end = index + 2;
      while (end < source.length && depth > 0) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') depth -= 1;
        if (depth > 0) end += 1;
      }
      if (depth !== 0) return { parts: undefined, next: source.length };
      parts.push({ type: 'expression', source: source.slice(index + 2, end) });
      index = end + 1;
      continue;
    }
    literal += char;
    index += 1;
  }
  return { parts: undefined, next: source.length };
}

/** Splits a token list on top-level commas. */
function splitArguments(tokens) {
  const groups = [];
  let depth = 0;
  let current = [];
  for (const token of tokens) {
    if (token.type === 'punct' && '(['.includes(token.value)) depth += 1;
    if (token.type === 'punct' && ')]'.includes(token.value)) depth -= 1;
    if (depth === 0 && token.type === 'punct' && token.value === ',') {
      groups.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length) groups.push(current);
  return groups;
}

function matchingBracket(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'punct') continue;
    if (token.value === '(' || token.value === '[') depth += 1;
    else if (token.value === ')' || token.value === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripDecoration(tokens) {
  const asIndex = tokens.findIndex(
    (token, index) =>
      index > 0 && token.type === 'name' && token.value === 'as',
  );
  const trimmed = asIndex === -1 ? tokens : tokens.slice(0, asIndex);
  return trimmed.filter(
    (token) => !(token.type === 'punct' && token.value === '!'),
  );
}

/**
 * Evaluates a token list to `{ value, anchored }`. `value` is `undefined`
 * whenever any part of the expression is outside the supported grammar.
 */
function evaluateTokens(tokens, context) {
  const trimmed = stripDecoration(tokens);
  if (!trimmed.length) return UNRESOLVED;

  if (
    trimmed.length === 5 &&
    trimmed[0].value === 'import' &&
    trimmed[1].value === '.' &&
    trimmed[2].value === 'meta' &&
    trimmed[3].value === '.' &&
    trimmed[4].value === 'url'
  )
    return { value: context.moduleUrl, anchored: true };

  const [first] = trimmed;

  if (trimmed.length === 1) {
    if (first.type === 'string') return { value: first.value, anchored: false };
    if (first.type === 'template') return evaluateTemplate(first, context);
    if (first.type === 'name') return resolveBinding(first.value, context);
    return UNRESOLVED;
  }

  if (
    first.type === 'name' &&
    first.value === 'new' &&
    trimmed[1]?.value === 'URL'
  )
    return evaluateUrl(trimmed.slice(2), context);

  let nameIndex = 0;
  if (
    first.type === 'name' &&
    trimmed[1]?.value === '.' &&
    trimmed[2]?.type === 'name'
  ) {
    if (!PATH_NAMESPACES.has(first.value)) return UNRESOLVED;
    nameIndex = 2;
  }
  const callee = trimmed[nameIndex];
  const open = trimmed[nameIndex + 1];
  if (
    callee?.type !== 'name' ||
    open?.value !== '(' ||
    !PATH_HELPERS.has(callee.value)
  )
    return UNRESOLVED;
  const close = matchingBracket(trimmed, nameIndex + 1);
  if (close !== trimmed.length - 1) return UNRESOLVED;
  const args = splitArguments(trimmed.slice(nameIndex + 2, close)).map(
    (group) => evaluateTokens(group, context),
  );
  if (!args.length || args.some(({ value }) => value === undefined))
    return UNRESOLVED;
  return applyHelper(
    callee.value,
    args.map(({ value }) => value),
    args.some(({ anchored }) => anchored),
  );
}

function applyHelper(name, args, anchored) {
  try {
    if (name === 'join') return { value: join(...args), anchored };
    if (name === 'resolve') return { value: resolve(...args), anchored };
    if (name === 'normalize') return { value: join(args[0]), anchored };
    if (name === 'dirname') return { value: dirname(args[0]), anchored };
    if (name === 'fileURLToPath') {
      if (!args[0].startsWith('file:')) return UNRESOLVED;
      return { value: fileURLToPath(args[0]), anchored };
    }
  } catch {
    return UNRESOLVED;
  }
  return UNRESOLVED;
}

function evaluateUrl(tokens, context) {
  if (tokens[0]?.value !== '(') return UNRESOLVED;
  const close = matchingBracket(tokens, 0);
  if (close !== tokens.length - 1) return UNRESOLVED;
  const args = splitArguments(tokens.slice(1, close)).map((group) =>
    evaluateTokens(group, context),
  );
  if (!args.length || args.some(({ value }) => value === undefined))
    return UNRESOLVED;
  const anchored = args.some(({ anchored: flag }) => flag);
  try {
    const href =
      args.length === 1
        ? new URL(args[0].value).href
        : new URL(args[0].value, args[1].value).href;
    return { value: href, anchored };
  } catch {
    return UNRESOLVED;
  }
}

function evaluateTemplate(token, context) {
  let value = '';
  let anchored = false;
  for (const part of token.parts) {
    if (part.type === 'literal') {
      value += part.value;
      continue;
    }
    const tokens = tokenize(part.source);
    if (!tokens) return UNRESOLVED;
    const resolved = evaluateTokens(tokens, context);
    if (resolved.value === undefined) return UNRESOLVED;
    value += resolved.value;
    anchored = anchored || resolved.anchored;
  }
  return { value, anchored };
}

function resolveBinding(name, context) {
  if (name === '__dirname')
    return { value: context.moduleDirectory, anchored: true };
  if (name === '__filename')
    return { value: context.modulePath, anchored: true };
  const binding = context.bindings.get(name);
  if (!binding) return UNRESOLVED;
  if (context.resolving.has(name)) return UNRESOLVED;
  if (binding.evaluated) return binding.result;
  context.resolving.add(name);
  binding.result = evaluateTokens(binding.tokens, context);
  binding.evaluated = true;
  context.resolving.delete(name);
  return binding.result;
}

/**
 * Collects `const`/`let` bindings. A name bound more than once is poisoned
 * rather than resolved to one of its definitions.
 */
function collectBindings(source) {
  const bindings = new Map();
  const pattern =
    /(?:^|[;{}\n)])[ \t]*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*/g;
  let match;
  while ((match = pattern.exec(source))) {
    const name = match[1];
    if (bindings.has(name)) {
      bindings.set(name, { tokens: [], evaluated: true, result: UNRESOLVED });
      continue;
    }
    const expression = readExpression(source, pattern.lastIndex);
    const tokens = expression === undefined ? undefined : tokenize(expression);
    bindings.set(
      name,
      tokens
        ? { tokens, evaluated: false, result: UNRESOLVED }
        : { tokens: [], evaluated: true, result: UNRESOLVED },
    );
  }
  return bindings;
}

function readExpression(source, start) {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === "'" || char === '"') {
      const { value, next } = readQuoted(source, index, char);
      if (value === undefined) return undefined;
      index = next;
      continue;
    }
    if (char === '`') {
      const { parts, next } = readTemplate(source, index);
      if (!parts) return undefined;
      index = next;
      continue;
    }
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) {
      if (depth === 0) return source.slice(start, index);
      depth -= 1;
    } else if (depth === 0 && (char === ';' || char === '\n')) {
      const candidate = source.slice(start, index).trim();
      // A trailing operator means the expression continues on the next line.
      if (char === '\n' && /[,+([{?:.]$/.test(candidate)) {
        index += 1;
        continue;
      }
      return candidate;
    }
    index += 1;
  }
  return source.slice(start).trim();
}

/**
 * Token positions where a supported path expression begins: `helper(`,
 * `path.helper(`, `fileURLToPath(`, and `new URL(`.
 */
function pathExpressionStarts(tokens) {
  const starts = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'name') continue;
    if (token.value === 'new' && tokens[index + 1]?.value === 'URL') {
      if (tokens[index + 2]?.value === '(')
        starts.push({ index, openIndex: index + 2 });
      continue;
    }
    if (!PATH_HELPERS.has(token.value)) continue;
    if (tokens[index + 1]?.value !== '(') continue;
    const isMember = tokens[index - 1]?.value === '.';
    if (isMember) {
      const namespace = tokens[index - 2];
      if (namespace?.type !== 'name' || !PATH_NAMESPACES.has(namespace.value))
        continue;
      starts.push({ index: index - 2, openIndex: index + 1 });
      continue;
    }
    starts.push({ index, openIndex: index + 1 });
  }
  return starts;
}

/** True when the file reads a file by path at all. */
export function readsFileByPath(source) {
  return (
    READ_CALL_PATTERN.test(source) &&
    [...MODULE_ANCHORS].some((anchor) => source.includes(anchor))
  );
}

/**
 * Resolves every module-anchored path expression in one test file to the
 * repository paths it names. Returns repo-relative POSIX paths, sorted and
 * deduplicated.
 */
export function scanPathReadPinsInSource(source, { repoPath, root }) {
  const modulePath = join(root, repoPath);
  const context = {
    modulePath,
    moduleDirectory: dirname(modulePath),
    moduleUrl: pathToFileURL(modulePath).href,
    bindings: collectBindings(source),
    resolving: new Set(),
  };
  const pins = new Set();
  // Tokenize once: re-tokenizing the file tail at every call site is
  // quadratic, and this scan runs on every gate.
  const tokens = tokenize(source) ?? [];
  const lists = scannableTokenLists(tokens);
  const writeTargets = collectWriteTargets(lists, context);
  for (const list of lists)
    for (const start of pathExpressionStarts(list)) {
      const close = matchingBracket(list, start.openIndex);
      if (close === -1) continue;
      const { value, anchored } = evaluateTokens(
        list.slice(start.index, close + 1),
        context,
      );
      if (value === undefined || !anchored) continue;
      let resolved = value;
      if (resolved.startsWith('file:')) {
        try {
          resolved = fileURLToPath(resolved);
        } catch {
          continue;
        }
      }
      if (!isAbsolute(resolved)) continue;
      const relativePath = relative(root, resolved).split(sep).join('/');
      if (!relativePath || relativePath.startsWith('..')) continue;
      if (isExcludedPath(relativePath)) continue;
      if (relativePath === repoPath) continue;
      if (writeTargets.has(resolved)) continue;
      // A directory is a location, not a pinned file. `__dirname` itself and
      // every intermediate root resolve here.
      if (isDirectory(resolved)) continue;
      // An extensionless path that does not exist names a synthesized
      // location — `join(repoRoot, 'examples', 'some-plugin')` handed to a
      // pure resolver — not a file this repository could have renamed away
      // from. An extensionless file that DOES exist (`.githooks/commit-msg`)
      // is a real pin and is kept.
      if (!/\.[A-Za-z0-9]+$/.test(relativePath) && !pathExists(resolved))
        continue;
      pins.add(relativePath);
    }
  return [...pins].sort();
}

/** Paths this file writes, creates, or removes. */
function collectWriteTargets(lists, context) {
  const targets = new Set();
  for (const list of lists)
    for (let index = 0; index < list.length; index += 1) {
      const token = list[index];
      if (token.type !== 'name') continue;
      // Only the CREATED argument. `symlinkSync(realScript, link)` reads its
      // first argument; excluding both would drop a genuine pin.
      const created = WRITE_CALLS.get(token.value);
      if (!created || list[index + 1]?.value !== '(') continue;
      const close = matchingBracket(list, index + 1);
      if (close === -1) continue;
      const args = splitArguments(list.slice(index + 2, close));
      for (const position of created) {
        const group = args[position];
        if (!group) continue;
        const { value, anchored } = evaluateTokens(group, context);
        if (value !== undefined && anchored) targets.add(value);
      }
    }
  return targets;
}

/**
 * The file's own tokens plus the tokens of every template interpolation,
 * recursively. A pin written inside a template — `server-build-portability`
 * builds an entry module whose text embeds `join(repoRoot, '...')` — is a
 * reference to that source just as much as a bare call is.
 */
function scannableTokenLists(tokens) {
  const lists = [tokens];
  for (let index = 0; index < lists.length; index += 1)
    for (const token of lists[index]) {
      if (token.type !== 'template') continue;
      for (const part of token.parts) {
        if (part.type !== 'expression') continue;
        const nested = tokenize(part.source);
        if (nested?.length) lists.push(nested);
      }
    }
  return lists;
}

/**
 * Scans the repository for path-read pins.
 *
 * Returns `{ test, pins }` entries sorted by test path. A pin is reported
 * whether or not its target still exists: a pin whose target was renamed away
 * is exactly what the existence gate must see, and dropping it silently would
 * make a broken pin invisible.
 *
 * @param {{
 *   root?: string,
 *   scanRoots?: readonly string[],
 *   readSource?: (absolute: string) => string,
 *   testFiles?: readonly string[],
 * }} [options]
 * @returns {{ test: string, pins: string[] }[]}
 */
export function scanPathReadPins({
  root = process.cwd(),
  scanRoots = PIN_SCAN_ROOTS,
  readSource = (absolute) => readFileSync(absolute, 'utf8'),
  testFiles,
} = {}) {
  const files = testFiles ?? listTestFiles(root, scanRoots);
  const entries = [];
  for (const repoPath of files) {
    let source;
    try {
      source = readSource(join(root, repoPath));
    } catch {
      continue;
    }
    if (!readsFileByPath(source)) continue;
    const pins = scanPathReadPinsInSource(source, { repoPath, root });
    if (pins.length) entries.push({ test: repoPath, pins });
  }
  return entries.sort((a, b) => a.test.localeCompare(b.test));
}

function pathExists(absolute) {
  try {
    statSync(absolute);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(absolute) {
  try {
    return statSync(absolute).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Inverts the scan into `{ pin, tests }` entries — the shape the impact
 * manifest needs, since selection keys on the CHANGED path.
 */
export function invertPathReadPins(entries) {
  const byPin = new Map();
  for (const { test, pins } of entries)
    for (const pin of pins) {
      const tests = byPin.get(pin) ?? new Set();
      tests.add(test);
      byPin.set(pin, tests);
    }
  return [...byPin.keys()]
    .sort()
    .map((pin) => ({ pin, tests: [...byPin.get(pin)].sort() }));
}
