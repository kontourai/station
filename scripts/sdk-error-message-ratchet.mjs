#!/usr/bin/env node
// Zero-tolerance gate for #3749 (hand-rolled refusal messages in the SDK).
//
// The shared zod middleware answers a rejected body with
// `{ error: 'Validation failed', details: { fieldErrors } }`. The sentence
// naming the broken rule is in `details`, so a caller that reads `result.error`
// alone can only ever show the user "Validation failed" — the refusal arrives
// with its reason removed. `apiErrorMessage` (packages/sdk/src/client/
// api-error-message.ts) reads the details and falls back to the envelope's own
// message; it existed for two call sites while 152 others hand-rolled
// `result.error || 'Something failed'` beside it.
//
// The whole package was swept in #3749, so this is zero-tolerance rather than a
// counted ceiling: there is no migration left to stage, and one new hook
// written the old way is one more refusal that reaches a user with nothing to
// say. A helper nobody is required to use is a helper that goes unadopted —
// that is the state this gate was written out of.
//
// Follows the established ratchet family (pure exported functions + a `main()`
// behind `invokedDirectly(import.meta.url)`, `git ls-files`-scoped,
// SCOPE_SENTINELS so a pathspec that stops matching fails instead of reporting
// vacuously green).
//
// #2708 adds a second, COUNTED rule over `packages/sdk/src/client/**`: a
// fetcher that builds its own error from an envelope drops what the shared
// helper keeps (`envelopeError` in client/api-error-message.ts: the observed
// status, `code`, `details`, `Retry-After`). The regex above never saw
// `new Error(result.error)`, `result.message ||`, or a `typeof x.error ===
// 'string' ? …` ternary, and it cannot see an error built from a
// `response.status` at all. So an AST rule finds every `new *Error(...)` whose
// arguments read an envelope, and three regexes catch the spellings outside a
// constructor call. Those sites existed when the rule was written, so it is a
// per-file baseline (sdk-envelope-read-baseline.json) that may only fall:
// later #2708 slices migrate clients and lower it with `--update`, which
// refuses to raise a row or add a file. The ratchet is two-sided: a count
// BELOW its row fails too, telling the author to run `--update`. Without that,
// a rule that silently stops counting (a broken AST walk reads 0 everywhere)
// would pass forever over a baseline nothing enforces any more. The cost is
// that two merges that each lower the same row conflict on the baseline file,
// which is a visible merge conflict rather than a silent pass.
//
// What the rule cannot see: a message computed into a variable first and
// passed to `new Error(message)` (the read happens outside the call), an
// aliased helper import, or an error built in one module and thrown from
// another. It routes new code to the helper; it is not a proof.
//
//   node scripts/sdk-error-message-ratchet.mjs [--update]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
import { invokedDirectly } from './lib/module-entry.mjs';

export const SCAN_PATHSPECS = ['packages/sdk/src'];

/**
 * `api-error-message.ts` IS the helper (its own doc comment quotes the banned
 * shape), and tests must be free to construct the envelopes the helper reads.
 */
export const EXEMPT_FILES = ['packages/sdk/src/client/api-error-message.ts'];

/**
 * Files that held a hand-rolled refusal when this gate was written. If a
 * pathspec change drops one out of scope the gate fails rather than going
 * quietly green over a smaller tree (station#1559 class).
 */
export const SCOPE_SENTINELS = [
  'packages/sdk/src/query-domains/workspaceConnections.ts',
  'packages/sdk/src/query-domains/chatRuntimeOrchestration.ts',
  'packages/sdk/src/client/conversations.ts',
  'packages/sdk/src/query-domains/plugin-queries.ts',
];

/**
 * `<anything>.error ||` / `<anything>.error ??` — the envelope read that
 * discards `details`. Deliberately not anchored to `result`: the same line is
 * written against `payload`, `json`, `j`, `data` and `current` in this package,
 * and the receiver is matched as "an expression ending in a name or a closing
 * bracket" so a nested one (`state.result.error ||`) cannot slip past by being
 * spelled differently.
 */
export const HAND_ROLLED_REFUSAL = /[\w$)\]]\??\.error\s*(\|\||\?\?)/g;

export function listScannedFiles() {
  const output = execFileSync('git', ['ls-files', '--', ...SCAN_PATHSPECS], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return output
    .split('\n')
    .filter((line) => line.endsWith('.ts') || line.endsWith('.tsx'))
    .filter((line) => !line.includes('__tests__'))
    .filter((line) => !EXEMPT_FILES.includes(line));
}

export function countHandRolledRefusals(
  files,
  read = (file) => readFileSync(file, 'utf8'),
) {
  const occurrences = [];
  for (const file of files) {
    const matches = read(file).match(HAND_ROLLED_REFUSAL);
    if (matches) occurrences.push({ file, count: matches.length });
  }
  return occurrences;
}

export function evaluate(occurrences, files) {
  const total = occurrences.reduce((sum, entry) => sum + entry.count, 0);
  const missingSentinels = SCOPE_SENTINELS.filter(
    (sentinel) => !files.includes(sentinel),
  );
  return {
    total,
    occurrences,
    missingSentinels,
    ok: missingSentinels.length === 0 && total === 0,
  };
}

// ---------------------------------------------------------------------------
// #2708: envelope reads that build their own error, counted per file.
// ---------------------------------------------------------------------------

export const ENVELOPE_BASELINE_PATH = 'scripts/sdk-envelope-read-baseline.json';

export const ENVELOPE_SCAN_PATHSPECS = ['packages/sdk/src/client'];

/**
 * The helper itself is where envelopes are SUPPOSED to be read. It is the
 * only exemption: every other client file is counted.
 */
export const ENVELOPE_EXEMPT_FILES = [
  'packages/sdk/src/client/api-error-message.ts',
];

/**
 * Client files that held an envelope-read error when the rule was written.
 * Losing one from the scanned set fails rather than reporting green over a
 * smaller tree (station#1559 class).
 */
export const ENVELOPE_SCOPE_SENTINELS = [
  'packages/sdk/src/client/skills.ts',
  'packages/sdk/src/client/agents.ts',
];

/** Calls whose result IS an envelope read: the historical message rules. */
export const ENVELOPE_MESSAGE_CALLS = new Set([
  'apiErrorMessage',
  'envelopeErrorMessage',
  'envelopeFailureMessage',
]);

/** Envelope fields whose read, inside an error constructor, is a violation. */
export const ENVELOPE_FIELDS = new Set(['error', 'message', 'code']);

/**
 * Receivers that conventionally hold a CAUGHT error, not a response body:
 * `new Error(error.message)` re-wraps a failure, it does not read an
 * envelope. The names are the ones this package uses in `catch` clauses.
 */
export const CAUGHT_ERROR_NAMES = new Set([
  'caught',
  'cause',
  'e',
  'err',
  'error',
  'reason',
]);

/** `response.status`, `res.status`, `listResponse.status`. */
function isResponseName(name) {
  return /^(response|res|resp)$/.test(name) || /Response$/.test(name);
}

/** The rightmost identifier of a receiver expression, when it has one. */
function receiverName(expression) {
  let current = expression;
  while (
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  if (ts.isIdentifier(current)) return current.text;
  if (ts.isPropertyAccessExpression(current)) return current.name.text;
  return undefined;
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** Does this subtree read a failure envelope? Returns the first read's kind. */
function envelopeRead(node) {
  let found;
  const visit = (child) => {
    if (found) return;
    if (ts.isCallExpression(child)) {
      const name = calleeName(child.expression);
      if (name && ENVELOPE_MESSAGE_CALLS.has(name)) {
        found = `${name}()`;
        return;
      }
    }
    if (ts.isPropertyAccessExpression(child)) {
      const field = child.name.text;
      const receiver = receiverName(child.expression);
      if (
        ENVELOPE_FIELDS.has(field) &&
        !(receiver && CAUGHT_ERROR_NAMES.has(receiver))
      ) {
        found = `.${field}`;
        return;
      }
      if (field === 'status' && receiver && isResponseName(receiver)) {
        found = `${receiver}.status`;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * `.message ||` / `.message ??` on a non-caught-error receiver: the envelope's
 * own message as a fallback, outside the shared order.
 */
const MESSAGE_FALLBACK = /([\w$]+)\??\.message\s*(?:\|\||\?\?)/g;
/** `new Error(result.error)` — the string shape assumed, `[object Object]` otherwise. */
const RAW_ERROR_ARGUMENT = /new\s+[\w$.]*Error\s*\(\s*[\w$.?\])]*\.error\s*\)/g;
/** `typeof x.error === 'string' ? …` (with `&& …` guards before the `?`). */
const STRING_ERROR_TERNARY =
  /typeof\s+[\w$.?\])]+\.error\s*===\s*['"]string['"](?:\s*&&[^?;]*)?\s*\?/g;

/** The source with every comment blanked (newlines kept), so prose never counts. */
export function stripComments(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  let output = '';
  let last = 0;
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      const start = scanner.getTokenStart();
      output += source.slice(last, start);
      output += scanner.getTokenText().replace(/[^\n]/g, ' ');
      last = scanner.getTokenEnd();
    }
  }
  return output + source.slice(last);
}

/**
 * Every envelope-reading error site in one source, as `{ line, kind }`. An
 * AST site is a `new *Error(...)` whose arguments read an envelope; a regex
 * site inside an already-counted constructor call is the same site and is
 * not counted twice.
 */
export function findEnvelopeReads(source, fileName = 'sample.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites = [];
  const ranges = [];
  const lineOf = (position) =>
    sourceFile.getLineAndCharacterOfPosition(position).line + 1;
  const visit = (node) => {
    if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      if (name && /Error$/.test(name)) {
        const read = (node.arguments ?? [])
          .map((argument) => envelopeRead(argument))
          .find(Boolean);
        if (read) {
          const start = node.getStart(sourceFile);
          sites.push({ line: lineOf(start), kind: `new ${name}(${read})` });
          ranges.push([start, node.getEnd()]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const code = stripComments(source);
  const insideCounted = (index) =>
    ranges.some(([start, end]) => index >= start && index < end);
  const scan = (pattern, kind, accept = () => true) => {
    for (const match of code.matchAll(pattern)) {
      if (insideCounted(match.index) || !accept(match)) continue;
      sites.push({ line: lineOf(match.index), kind });
    }
  };
  scan(
    MESSAGE_FALLBACK,
    '.message fallback',
    (match) => !CAUGHT_ERROR_NAMES.has(match[1]),
  );
  scan(RAW_ERROR_ARGUMENT, 'new Error(x.error)');
  scan(STRING_ERROR_TERNARY, "typeof x.error === 'string' ?");
  return sites.sort((a, b) => a.line - b.line);
}

export function listEnvelopeScannedFiles() {
  const output = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...ENVELOPE_SCAN_PATHSPECS,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  return [...new Set(output.split('\n'))]
    .filter((line) => line.endsWith('.ts') || line.endsWith('.tsx'))
    .filter((line) => !line.includes('__tests__'))
    .filter((line) => !ENVELOPE_EXEMPT_FILES.includes(line))
    .sort();
}

export function countEnvelopeReads(
  files,
  read = (file) => readFileSync(file, 'utf8'),
) {
  const counts = {};
  for (const file of files) {
    let source;
    try {
      source = read(file);
    } catch (error) {
      // Listed by git but deleted in the working tree: nothing to count.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const count = findEnvelopeReads(source, file).length;
    if (count > 0) counts[file] = count;
  }
  return counts;
}

export function evaluateEnvelopeReads(counts, files, baseline) {
  const allowed = baseline.files ?? {};
  const over = [];
  const under = [];
  for (const [file, count] of Object.entries(counts)) {
    const ceiling = allowed[file] ?? 0;
    if (count > ceiling) over.push({ file, count, ceiling });
  }
  for (const [file, ceiling] of Object.entries(allowed)) {
    const count = counts[file] ?? 0;
    if (count < ceiling) under.push({ file, count, ceiling });
  }
  const missingSentinels = ENVELOPE_SCOPE_SENTINELS.filter(
    (sentinel) => !files.includes(sentinel),
  );
  return {
    over,
    under,
    missingSentinels,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    ok:
      over.length === 0 && under.length === 0 && missingSentinels.length === 0,
  };
}

/** Lower-only: refuses any row that would rise or appear. */
export function lowerEnvelopeBaseline(counts, baseline) {
  const allowed = baseline.files ?? {};
  const refused = Object.entries(counts)
    .filter(([file, count]) => count > (allowed[file] ?? 0))
    .map(([file, count]) => ({ file, count, ceiling: allowed[file] ?? 0 }));
  if (refused.length > 0) return { ok: false, refused };
  const files = {};
  for (const file of Object.keys(allowed).sort()) {
    if (counts[file]) files[file] = counts[file];
  }
  return { ok: true, baseline: { ...baseline, files } };
}

function reportEnvelopeOver(rows, files) {
  console.error(
    'FAIL: client fetchers build their own error from an envelope above the baseline (#2708):',
  );
  for (const row of rows) {
    console.error(`  ${row.file}: ${row.count} (baseline ${row.ceiling})`);
    for (const site of files[row.file] ?? []) {
      console.error(`    line ${site.line}: ${site.kind}`);
    }
  }
  console.error(
    'A hand-built error keeps the words and drops the status, `code` and',
  );
  console.error(
    '`details`. Throw envelopeError(response, body, fallback) from',
  );
  console.error('packages/sdk/src/client/api-error-message.ts instead.');
}

function main(argv) {
  const files = listScannedFiles();
  const result = evaluate(countHandRolledRefusals(files), files);

  if (result.missingSentinels.length > 0) {
    console.error(
      `FAIL: sdk-error-message ratchet scope lost these files: ${result.missingSentinels.join(', ')}`,
    );
    return 1;
  }
  if (!result.ok) {
    console.error(
      `FAIL: ${result.total} hand-rolled refusal message(s) in packages/sdk/src.`,
    );
    console.error(
      'Reading `result.error` alone drops `details.fieldErrors`, so a schema',
    );
    console.error(
      'refusal reaches the user as "Validation failed" with the reason removed.',
    );
    console.error(
      "Use apiErrorMessage(result, '<fallback>') from packages/sdk/src/client/",
    );
    console.error('api-error-message.ts (re-exported by api-core).');
    for (const entry of result.occurrences) {
      console.error(`  ${entry.file}: ${entry.count}`);
    }
    return 1;
  }

  const clientFiles = listEnvelopeScannedFiles();
  const counts = countEnvelopeReads(clientFiles);
  const baseline = JSON.parse(readFileSync(ENVELOPE_BASELINE_PATH, 'utf8'));

  if (argv.includes('--update')) {
    const lowered = lowerEnvelopeBaseline(counts, baseline);
    if (!lowered.ok) {
      console.error(
        'FAIL: --update only lowers the SDK envelope-read baseline; these files would rise:',
      );
      for (const row of lowered.refused) {
        console.error(`  ${row.file}: ${row.count} (baseline ${row.ceiling})`);
      }
      console.error(
        'Throw envelopeError(response, body, fallback) from packages/sdk/src/client/api-error-message.ts.',
      );
      return 1;
    }
    writeFileSync(
      ENVELOPE_BASELINE_PATH,
      `${JSON.stringify(lowered.baseline, null, 2)}\n`,
    );
    console.log(`OK: wrote ${ENVELOPE_BASELINE_PATH}`);
    return 0;
  }

  const envelope = evaluateEnvelopeReads(counts, clientFiles, baseline);
  if (envelope.missingSentinels.length > 0) {
    console.error(
      `FAIL: sdk envelope-read ratchet scope lost these files: ${envelope.missingSentinels.join(', ')}`,
    );
    return 1;
  }
  if (envelope.over.length > 0) {
    const sites = Object.fromEntries(
      envelope.over.map((row) => [
        row.file,
        findEnvelopeReads(readFileSync(row.file, 'utf8'), row.file),
      ]),
    );
    reportEnvelopeOver(envelope.over, sites);
    return 1;
  }
  if (envelope.under.length > 0) {
    console.error(
      'FAIL: envelope-read errors fell below the baseline (#2708). Tighten it with',
    );
    console.error('`node scripts/sdk-error-message-ratchet.mjs --update`:');
    for (const row of envelope.under) {
      console.error(`  ${row.file}: ${row.count} (baseline ${row.ceiling})`);
    }
    console.error(
      'A migration lowers the row in the same change. A drop nobody made on',
    );
    console.error(
      'purpose means the rule stopped counting — do not --update over it.',
    );
    return 1;
  }
  console.log(
    `OK: 0 hand-rolled refusal messages across ${files.length} SDK source files; every refusal reads details.fieldErrors.`,
  );
  console.log(
    `OK: ${envelope.total} envelope-read error sites across ${clientFiles.length} client files, exactly at the baseline (#2708).`,
  );
  return 0;
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
