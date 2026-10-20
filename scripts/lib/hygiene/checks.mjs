/**
 * The code hygiene checks (docs/guides/code-hygiene.md). Each derives its
 * answer from the tracked tree, the TypeScript syntax tree or GitHub issue
 * state; none compares against pinned text. All are advisory: a check returns
 * findings and the caller decides the exit status.
 *
 * A check that cannot reach its data sets `notVerified` to the reason, and
 * reports only what it could establish without that data.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { GithubUnavailableError } from './github.mjs';
import {
  isFixturePath,
  isTestPath,
  markdownProse,
  readText,
  scannableLines,
  trackedFiles,
} from './source-text.mjs';

/**
 * @typedef {{ kind: string, path: string, line?: number, detail: string }} Finding
 * @typedef {{ id: string, title: string, findings: Finding[], notVerified: string | null, summary: string }} CheckResult
 * @typedef {{ root: string, github: ReturnType<typeof import('./github.mjs').createGithub>, today: string, files?: string[] }} CheckContext
 */

// Loaded on first use: the tracking-issue upsert job imports this module
// without installing dependencies.
const require = createRequire(import.meta.url);
/** @type {typeof import('typescript-api')} */
let ts;

function filesOf(context) {
  context.files ??= trackedFiles(context.root);
  return context.files;
}

function result(id, title, findings, notVerified, summary) {
  return { id, title, findings, notVerified, summary };
}

/** Run a GitHub read, turning unavailability into a NOT_VERIFIED reason. */
function tryGithub(read) {
  try {
    return { value: read() };
  } catch (error) {
    if (error instanceof GithubUnavailableError)
      return { unavailable: error.message };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 1. Unfinished-work markers and feature flags
// ---------------------------------------------------------------------------

const MARKER_PATTERN = /\b(UNWIRED|SUNSET|TODO)\(([^)\n]*)\)(:?)(\s*\S?)/g;
const BARE_MARKER = /\b(UNWIRED|SUNSET)(?=\s*:)/g;
/** Documentation placeholders such as `(#N)` and `(#NNNN)` are not markers. */
const PLACEHOLDER = /^#N+$/;

/**
 * Parse the markers on one line. Returns well-formed markers and malformed
 * attempts; `TODO(...)` whose argument does not start with `#` or
 * `archive#` belongs to another convention (dated TODOs) and is ignored.
 */
function parseMarkers(text) {
  const markers = [];
  const malformed = [];
  for (const match of text.matchAll(MARKER_PATTERN)) {
    const [whole, name, argument, colon, following] = match;
    const value = argument.trim();
    if (PLACEHOLDER.test(value)) continue;
    if (name === 'TODO' && !/^(archive)?#/.test(value)) continue;
    const number = /^#([1-9]\d*)$/.exec(value);
    if (/^archive#/.test(value)) {
      malformed.push({
        text: whole.trim(),
        reason:
          'cites an archive issue; a marker must cite an open issue in this repository',
      });
    } else if (!number) {
      malformed.push({
        text: whole.trim(),
        reason: `the argument must be one issue number like (#1234), found (${value})`,
      });
    } else if (name !== 'TODO' && (!colon || !following.trim())) {
      malformed.push({
        text: whole.trim(),
        reason: `${name}(#N) must be followed by ": <what remains>"`,
      });
    } else markers.push({ name, number: Number(number[1]) });
  }
  for (const match of text.matchAll(BARE_MARKER)) {
    malformed.push({
      text: `${match[1]}:`,
      reason: `${match[1]} needs the owning issue: ${match[1]}(#N): <what remains>`,
    });
  }
  return { markers, malformed };
}

const FEATURE_ENV = 'STATION_FEATURES';
const FLAG_ROOT = 'src-server/';

/** A read of the environment value: `x.STATION_FEATURES` or `x['STATION_FEATURES']`. */
function isFeatureEnvRead(node) {
  return (
    (ts.isPropertyAccessExpression(node) && node.name.text === FEATURE_ENV) ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === FEATURE_ENV)
  );
}

const LIST_METHODS = new Set(['split', 'filter', 'map', 'trim', 'toLowerCase']);
const MEMBERSHIP = new Set(['includes', 'has', 'indexOf']);

/**
 * From an expression holding the feature list, step outward through
 * list-preserving wrappers: parentheses, `|| ''`/`?? ''` fallbacks and
 * `.split()`, `.filter()`, `.map()`, `.trim()` calls.
 */
function listChainTop(node) {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (ts.isParenthesizedExpression(parent)) current = parent;
    else if (
      ts.isBinaryExpression(parent) &&
      parent.left === current &&
      [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(
        parent.operatorToken.kind,
      )
    )
      current = parent;
    else if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current &&
      LIST_METHODS.has(parent.name.text) &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    )
      current = parent.parent;
    else return current;
  }
}

/** `<list>.includes('flag')`: the flag literal, or undefined. */
function membershipFlag(list) {
  const access = list.parent;
  if (
    ts.isPropertyAccessExpression(access) &&
    access.expression === list &&
    MEMBERSHIP.has(access.name.text) &&
    ts.isCallExpression(access.parent) &&
    access.parent.expression === access &&
    access.parent.arguments.length === 1 &&
    ts.isStringLiteralLike(access.parent.arguments[0])
  )
    return access.parent.arguments[0];
  return undefined;
}

/**
 * Feature flags are the string literals tested for membership in the
 * `STATION_FEATURES` list. There is no declared flag registry: Station reads
 * the environment value and tests it for literals. So every read in the file
 * must reach a membership test through shapes this function understands: a
 * test on the read itself, a `const` list variable whose every use is a
 * test, or an unexported function returning the list whose every call is a
 * test. Any other read (destructuring, aliasing, passing the list on, an
 * exported list function) is returned in `unsupported`, so the check reports
 * NOT_VERIFIED instead of an incomplete flag set.
 *
 * A flag has an adjacent sunset when a `SUNSET(#N):` comment leads the
 * statement that tests it or any statement or declaration enclosing it.
 */
function featureFlagsInSource(path, text) {
  if (!text.includes(FEATURE_ENV)) return { flags: [], unsupported: [] };
  ts ??= require('typescript-api');
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lineOf = (node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const flags = [];
  const unsupported = [];
  const refuse = (node, why) =>
    unsupported.push({ path, line: lineOf(node), why });
  const leadingSunset = (node) => {
    // Leading trivia of the test itself and of every enclosing node, up to
    // the top-level statement, covers a comment above the `if`, above the
    // declaration, and the docblock of the enclosing function.
    for (let current = node; current; current = current.parent) {
      if (ts.isSourceFile(current)) break;
      const trivia = text.slice(
        current.getFullStart(),
        current.getStart(source),
      );
      if (/\bSUNSET\(#[1-9]\d*\):/.test(trivia)) return true;
    }
    return false;
  };
  const addFlag = (literal) =>
    flags.push({
      flag: literal.text,
      line: lineOf(literal),
      sunset: leadingSunset(literal),
    });
  /** Every reference to `name` except `declared` must be a membership test of `use(ref)`. */
  const everyUseTests = (name, declared, use, what) => {
    let uses = 0;
    const visit = (node) => {
      if (
        ts.isIdentifier(node) &&
        node.text === name &&
        node !== declared &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        )
      ) {
        uses += 1;
        const list = use(node);
        const literal = list && membershipFlag(list);
        if (literal) addFlag(literal);
        else
          refuse(
            node,
            `${what} '${name}' is used other than as a membership test`,
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return uses;
  };
  const isExported = (node) =>
    ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export ||
    (ts.isVariableDeclaration(node) &&
      ts.getCombinedModifierFlags(node.parent.parent) &
        ts.ModifierFlags.Export);
  const visit = (node) => {
    if (
      ts.isBindingElement(node) &&
      (node.propertyName ?? node.name)?.getText?.(source) === FEATURE_ENV
    )
      refuse(node, `${FEATURE_ENV} is destructured`);
    if (isFeatureEnvRead(node)) {
      const top = listChainTop(node);
      const parent = top.parent;
      const literal = membershipFlag(top);
      if (literal) addFlag(literal);
      else if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === top &&
        ts.isIdentifier(parent.name)
      )
        everyUseTests(parent.name.text, parent.name, (ref) => ref, 'list');
      else {
        const fn = ts.isReturnStatement(parent)
          ? ts.findAncestor(parent, ts.isFunctionLike)
          : ts.isArrowFunction(parent) && parent.body === top
            ? parent
            : undefined;
        const owner =
          fn && ts.isFunctionDeclaration(fn)
            ? fn
            : fn && ts.isVariableDeclaration(fn.parent)
              ? fn.parent
              : undefined;
        if (!owner?.name || !ts.isIdentifier(owner.name))
          refuse(
            node,
            `${FEATURE_ENV} is read in a shape the check does not follow`,
          );
        else if (isExported(owner))
          refuse(
            node,
            `exported function '${owner.name.text}' returns the ${FEATURE_ENV} list`,
          );
        else
          everyUseTests(
            owner.name.text,
            owner.name,
            (ref) =>
              ts.isCallExpression(ref.parent) && ref.parent.expression === ref
                ? ref.parent
                : undefined,
            'function',
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { flags, unsupported };
}

/**
 * `STATION_FEATURES` flags read by non-test `src-server` code, one finding
 * per flag that no reading site marks with a sunset.
 * @param {CheckContext} context
 */
function flagFindings(context) {
  const flags = new Map();
  const unsupported = [];
  for (const path of filesOf(context)) {
    if (
      !path.startsWith(FLAG_ROOT) ||
      !/\.(ts|tsx|mts|cts)$/.test(path) ||
      isTestPath(path) ||
      path.endsWith('.d.ts')
    )
      continue;
    const text = readText(context.root, path);
    if (text === null) continue;
    const parsed = featureFlagsInSource(path, text);
    unsupported.push(...parsed.unsupported);
    for (const flag of parsed.flags) {
      const entry = flags.get(flag.flag) ?? { sites: [], sunset: false };
      entry.sites.push({ path, line: flag.line });
      entry.sunset ||= flag.sunset;
      flags.set(flag.flag, entry);
    }
  }
  const findings = [...flags]
    .filter(([, entry]) => !entry.sunset)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([flag, entry]) => ({
      kind: 'flag-without-sunset',
      path: entry.sites[0].path,
      line: entry.sites[0].line,
      detail: `${FEATURE_ENV} flag '${flag}' has no SUNSET(#N): comment leading the statement that reads it (${entry.sites.length} site${entry.sites.length === 1 ? '' : 's'})`,
    }));
  const notVerified = unsupported.length
    ? `${FEATURE_ENV} flags: ${unsupported.map((site) => `${site.path}:${site.line} ${site.why}`).join('; ')}`
    : null;
  return { findings, count: flags.size, notVerified };
}

/** @param {CheckContext} context @returns {CheckResult} */
function checkMarkers(context) {
  const flags = flagFindings(context);
  const findings = [...flags.findings];
  const located = [];
  for (const path of filesOf(context)) {
    if (isFixturePath(path)) continue;
    for (const { line, text } of scannableLines(context.root, path)) {
      const parsed = parseMarkers(text);
      for (const marker of parsed.markers)
        located.push({ ...marker, path, line });
      for (const bad of parsed.malformed)
        findings.push({
          kind: 'malformed',
          path,
          line,
          detail: `${bad.text}: ${bad.reason}`,
        });
    }
  }
  const resolved = tryGithub(() =>
    context.github.resolve(located.map((marker) => marker.number)),
  );
  if (resolved.value) {
    for (const marker of located) {
      const issue = resolved.value.get(marker.number);
      const label = `${marker.name}(#${marker.number})`;
      if (issue.kind === 'missing')
        findings.push({
          kind: 'not-an-issue',
          path: marker.path,
          line: marker.line,
          detail: `${label}: #${marker.number} does not exist in ${context.github.repository}`,
        });
      else if (issue.kind === 'pull')
        findings.push({
          kind: 'not-an-issue',
          path: marker.path,
          line: marker.line,
          detail: `${label}: #${marker.number} is a pull request; cite the issue that owns the remaining work`,
        });
      else if (issue.state === 'CLOSED')
        findings.push({
          kind: 'closed-issue',
          path: marker.path,
          line: marker.line,
          detail: `${label}: issue #${marker.number} is closed ("${issue.title}"); wire or delete the code, or cite the open issue that now owns it`,
        });
    }
  }
  return result(
    'markers',
    'Unfinished-work markers and feature flags',
    sortFindings(findings),
    [flags.notVerified, resolved.unavailable].filter(Boolean).join('; ') ||
      null,
    `${located.length} markers, ${flags.count} ${FEATURE_ENV} flags`,
  );
}

// ---------------------------------------------------------------------------
// 2. Issue references beyond the repository's highest number
// ---------------------------------------------------------------------------

/**
 * `#N`, `station#N` and `kontourai/station#N` name this repository;
 * `archive#N` and other `owner/repo#N` forms do not. Numbers have no leading
 * zero and at most five digits, which keeps hex colours (`#111111`) and
 * anchors (`#123-heading`) out.
 */
const ISSUE_REF =
  /(?<![\w/&#.:@-])(?:kontourai\/station|station)?#([1-9]\d{0,4})(?![\w-])/g;
const ISSUE_URL =
  /github\.com\/kontourai\/station\/(?:issues|pull)\/([1-9]\d{0,5})(?!\d)/g;

function issueReferences(text) {
  const out = [];
  for (const match of text.matchAll(ISSUE_REF))
    out.push({ number: Number(match[1]), text: match[0] });
  for (const match of text.matchAll(ISSUE_URL))
    out.push({ number: Number(match[1]), text: match[0] });
  return out;
}

/**
 * Append-only release records quote commit and pull request titles verbatim
 * as they were written; they are history, not maintained prose.
 */
const RELEASE_RECORD =
  /(^|\/)CHANGELOG\.md$|^docs\/reference\/deploy-ledger\.md$/;
const ISSUE_NUMBER_MAP = 'docs/migration/issue-number-map.json';

/** Archive issue number to re-filed number, from the cutover record. */
function refiledNumbers(root) {
  try {
    const { mapping } = JSON.parse(
      readFileSync(join(root, ISSUE_NUMBER_MAP), 'utf8'),
    );
    return new Map(
      Object.entries(mapping ?? {}).map(([from, to]) => [Number(from), to]),
    );
  } catch {
    // The map only adds a hint; a tree without it still gets every finding.
    return new Map();
  }
}

/** @param {CheckContext} context @returns {CheckResult} */
function checkIssueReferences(context) {
  const refs = [];
  for (const path of filesOf(context)) {
    if (isFixturePath(path) || RELEASE_RECORD.test(path)) continue;
    for (const { line, text } of scannableLines(context.root, path))
      for (const ref of issueReferences(text))
        refs.push({ ...ref, path, line });
  }
  if (!refs.length)
    return result('issue-refs', 'Issue references', [], null, '0 references');
  const max = tryGithub(() => context.github.maxNumber());
  if (max.unavailable)
    return result(
      'issue-refs',
      'Issue references',
      [],
      max.unavailable,
      `${refs.length} references`,
    );
  const refiled = refiledNumbers(context.root);
  const findings = refs
    .filter((ref) => ref.number > max.value)
    .map((ref) => ({
      kind: 'beyond-latest',
      path: ref.path,
      line: ref.line,
      detail: `${ref.text} is above the highest issue or pull request number in ${context.github.repository} (#${max.value}). Qualify it: archive#${ref.number} for a pre-reset Station issue${refiled.has(ref.number) ? ` (re-filed here as #${refiled.get(ref.number)})` : ''}, owner/repo#${ref.number} for another repository`,
    }));
  return result(
    'issue-refs',
    'Issue references',
    sortFindings(findings),
    null,
    `${refs.length} references, highest number #${max.value}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Private plan and review labels
// ---------------------------------------------------------------------------

const LABEL_PATTERNS = Object.freeze([
  ['plan-id', /\bs\d{3}-[a-z][a-z0-9-]*/],
  ['plan-file', /--plan\.md\b/],
  ['wave', /\bWave \d+\b/],
  ['track', /\bTrack \d+\b/],
  ['review-round', /\breview round \d+\b/i],
  ['delta-review', /\bdelta-review\b/i],
  ['severity-tag', /\b(?:HIGH|MED|MEDIUM|LOW)-\d+\b/],
]);

/** Dated records keep the labels they were written with. */
const LABEL_EXEMPT = [
  'docs/reviews/',
  'docs/strategy/',
  'docs/adr/',
  '.changeset/',
];

function planLabels(text) {
  const out = [];
  for (const [kind, pattern] of LABEL_PATTERNS) {
    const match = pattern.exec(text);
    if (match) out.push({ kind, text: match[0] });
  }
  return out;
}

/** @param {CheckContext} context @returns {CheckResult} */
function checkPlanLabels(context) {
  const findings = [];
  let scanned = 0;
  for (const path of filesOf(context)) {
    if (isTestPath(path) || RELEASE_RECORD.test(path)) continue;
    if (LABEL_EXEMPT.some((prefix) => path.startsWith(prefix))) continue;
    const lines = scannableLines(context.root, path);
    if (lines.length) scanned += 1;
    for (const { line, text } of lines)
      for (const label of planLabels(text))
        findings.push({
          kind: label.kind,
          path,
          line,
          detail: `"${label.text}": replace the private label with the constraint it encodes and the issue that owns it`,
        });
  }
  return result(
    'plan-labels',
    'Plan and review labels',
    sortFindings(findings),
    null,
    `${scanned} files scanned`,
  );
}

// ---------------------------------------------------------------------------
// 4. Module ownership
// ---------------------------------------------------------------------------

const MODULE_MAP = 'docs/architecture/module-map.md';
const OWNED_PARENTS = ['src-server/services/', 'packages/'];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {CheckContext} context @returns {CheckResult} */
function checkModuleOwnership(context) {
  const files = filesOf(context);
  const directories = new Set();
  for (const path of files)
    for (const parent of OWNED_PARENTS) {
      if (!path.startsWith(parent)) continue;
      const rest = path.slice(parent.length).split('/');
      if (rest.length > 1) directories.add(`${parent}${rest[0]}`);
    }
  const mapPath = join(context.root, MODULE_MAP);
  if (!existsSync(mapPath))
    return result(
      'module-ownership',
      'Module ownership',
      [],
      `${MODULE_MAP} does not exist`,
      `${directories.size} directories`,
    );
  const moduleMap = readFileSync(mapPath, 'utf8');
  const tracked = new Set(files);
  const findings = [];
  for (const directory of [...directories].sort()) {
    if (tracked.has(`${directory}/README.md`)) continue;
    const named = new RegExp(`${escapeRegExp(directory)}(?![\\w.-])`);
    if (named.test(moduleMap)) continue;
    findings.push({
      kind: 'unowned-module',
      path: directory,
      detail: `named neither in ${MODULE_MAP} nor by its own README.md`,
    });
  }
  return result(
    'module-ownership',
    'Module ownership',
    findings,
    null,
    `${directories.size} directories`,
  );
}

// ---------------------------------------------------------------------------
// 5. Design and plan document lifecycle
// ---------------------------------------------------------------------------

const LIFECYCLE_DIRS = ['docs/design/', 'docs/plans/'];
/** The header region a status banner must appear in. */
const STATUS_WINDOW = 40;
const STATUS_LINE =
  /^\s*(?:>\s*)?(?:\*\*)?(?:Reading status|Status)(?:\s*\([^)]*\))?\s*(?:\*\*)?\s*:/i;
const OPEN_STATUS =
  /\b(?:proposed|proposal|draft|in[ -]progress|active|under (?:design|review)|blocked|not (?:yet )?(?:shipped|implemented|built))\b/i;
const SETTLED_LEAD = /^(?:historical|superseded|retired|archived)\b/i;

/**
 * The status banner of a design or plan document: its first status line and
 * the paragraphs of every status line in the header, plus the issues they
 * cite in this repository and in the archive.
 */
function parseStatus(text) {
  const lines = text.split('\n').slice(0, STATUS_WINDOW);
  let first = null;
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!STATUS_LINE.test(lines[index])) continue;
    const block = [lines[index]];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (!lines[next].replace(/^\s*>\s?/, '').trim()) break;
      block.push(lines[next]);
    }
    const value = block
      .join(' ')
      .replace(/^.*?status(?:\s*\([^)]*\))?\s*:?/i, '')
      .replace(/[*_>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    first ??= { line: index + 1, value };
    blocks.push(block.join('\n'));
  }
  if (!first) return null;
  const cited = blocks.flatMap((block) =>
    issueReferences(block).map((ref) => ref.number),
  );
  const archived = blocks.some((block) =>
    /archive#\d|station-archive\/issues\/\d/.test(block),
  );
  const lead = first.value.split(/[.;—]|\s-\s/)[0];
  const open =
    OPEN_STATUS.test(lead) &&
    !SETTLED_LEAD.test(lead.replace(/^[^A-Za-z]+/, ''));
  return { ...first, lead, open, cited: [...new Set(cited)], archived };
}

/** @param {CheckContext} context @returns {CheckResult} */
function checkDesignStatus(context) {
  const findings = [];
  const pending = [];
  const documents = filesOf(context).filter(
    (path) =>
      LIFECYCLE_DIRS.some(
        (dir) => path.startsWith(dir) && !path.slice(dir.length).includes('/'),
      ) &&
      path.endsWith('.md') &&
      !path.endsWith('/README.md'),
  );
  for (const path of documents) {
    const text = readText(context.root, path);
    if (text === null) continue;
    // Banners in fenced examples are not the document's own status; line
    // numbers are kept so a finding points at the banner.
    const prose = new Map(
      markdownProse(text).map((entry) => [entry.line, entry.text]),
    );
    const status = parseStatus(
      Array.from(
        { length: STATUS_WINDOW },
        (_, index) => prose.get(index + 1) ?? '',
      ).join('\n'),
    );
    if (!status) {
      findings.push({
        kind: 'no-status',
        path,
        detail: `no "Status:" or "Reading status:" line in the first ${STATUS_WINDOW} lines`,
      });
      continue;
    }
    if (!status.open) continue;
    if (!status.cited.length) {
      findings.push({
        kind: 'untracked-open-status',
        path,
        line: status.line,
        detail: `status "${status.lead}" cites no issue in this repository${status.archived ? ' (only archive issues, which are closed history)' : ''}, so nothing records when it ends`,
      });
      continue;
    }
    pending.push({ path, status });
  }
  const resolved = tryGithub(() =>
    context.github.resolve(pending.flatMap(({ status }) => status.cited)),
  );
  if (resolved.value) {
    for (const { path, status } of pending) {
      const states = status.cited.map((number) => ({
        number,
        ...resolved.value.get(number),
      }));
      if (states.some((state) => state.state === 'OPEN')) continue;
      findings.push({
        kind: 'closed-tracking-issue',
        path,
        line: status.line,
        detail: `status "${status.lead}" but every issue it cites is closed or absent (${states.map((state) => `#${state.number} ${state.kind === 'missing' ? 'missing' : state.state.toLowerCase()}`).join(', ')}); update the status`,
      });
    }
  }
  return result(
    'design-status',
    'Design and plan document status',
    sortFindings(findings),
    resolved.unavailable ?? null,
    `${documents.length} documents`,
  );
}

// ---------------------------------------------------------------------------
// 6. Evidence retention
// ---------------------------------------------------------------------------

const EVIDENCE_FIXED = ['docs/strategy/dogfood', 'docs/strategy/catches'];
const DATED_DIRECTORY = /-\d{8}$/;
/** Ledger paths mirror documentation paths; they are not evidence sets. */
const RETENTION_EXCLUDED = ['docs/learn/review-ledger/'];
const RETENTION_LINE =
  /^Retention: (?:until (\d{4}-\d{2}-\d{2})|permanent — \S.*)$/;

function evidenceDirectories(files) {
  const candidates = new Set();
  for (const path of files) {
    if (RETENTION_EXCLUDED.some((prefix) => path.startsWith(prefix))) continue;
    // A dated fixture directory is test input, not a retained evidence set.
    if (isTestPath(path)) continue;
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join('/');
      if (
        EVIDENCE_FIXED.includes(directory) ||
        (directory.startsWith('docs/reviews/') && depth === 3) ||
        (directory.startsWith('docs/strategy/onboarding-') && depth === 3) ||
        DATED_DIRECTORY.test(segments[depth - 1])
      ) {
        candidates.add(directory);
        break;
      }
    }
  }
  return [...candidates].sort();
}

function validDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

/** @param {CheckContext} context @returns {CheckResult} */
function checkEvidenceRetention(context) {
  const files = filesOf(context);
  const tracked = new Set(files);
  const directories = evidenceDirectories(files);
  const findings = [];
  for (const directory of directories) {
    const readme = `${directory}/README.md`;
    if (!tracked.has(readme)) {
      findings.push({
        kind: 'missing-retention',
        path: directory,
        detail: `no README.md; add one with "Retention: until YYYY-MM-DD" or "Retention: permanent — <reason>"`,
      });
      continue;
    }
    const text = readText(context.root, readme) ?? '';
    const lines = text.split('\n').filter((line) => /^Retention:/.test(line));
    const valid = lines
      .map((line) => RETENTION_LINE.exec(line.trimEnd()))
      .filter(Boolean);
    if (!valid.length) {
      findings.push({
        kind: 'missing-retention',
        path: readme,
        detail: lines.length
          ? `"${lines[0].trim()}" is not "Retention: until YYYY-MM-DD" or "Retention: permanent — <reason>"`
          : 'no "Retention:" line',
      });
      continue;
    }
    const until = valid[0][1];
    if (!until) continue;
    if (!validDate(until))
      findings.push({
        kind: 'missing-retention',
        path: readme,
        detail: `${until} is not a calendar date`,
      });
    else if (until < context.today)
      findings.push({
        kind: 'expired-retention',
        path: readme,
        detail: `retention ended ${until}; delete the evidence set or extend it with a reason`,
      });
  }
  return result(
    'evidence-retention',
    'Evidence retention',
    findings,
    null,
    `${directories.length} evidence directories`,
  );
}

// ---------------------------------------------------------------------------

function sortFindings(findings) {
  return findings.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      a.kind.localeCompare(b.kind),
  );
}

export const CHECKS = Object.freeze({
  markers: checkMarkers,
  'issue-refs': checkIssueReferences,
  'plan-labels': checkPlanLabels,
  'module-ownership': checkModuleOwnership,
  'design-status': checkDesignStatus,
  'evidence-retention': checkEvidenceRetention,
});

/** Is `root` a directory the checks can inventory? */
export function assertRoot(root) {
  if (!existsSync(root) || !statSync(root).isDirectory())
    throw new Error(`--root ${root} is not a directory`);
}
