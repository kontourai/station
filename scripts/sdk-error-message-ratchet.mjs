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
// `response.status` at all. So a TypeScript AST walk counts, per file:
//   - `new *Error(...)` whose arguments read an envelope: a message-rule call
//     (apiErrorMessage / envelopeErrorMessage / envelopeFailureMessage), an
//     `.error`/`.message`/`.code` read on anything but a caught failure, a
//     field destructured from a body (`const { error } = body`), or a
//     Response's `.status` (`r`/`res`/`resp`/`response`/`*Response`, or a
//     parameter typed `Response`);
//   - every other message-rule call, so `const message = apiErrorMessage(…);
//     throw new Error(message)` and `Object.assign(new Error(m), …)` count;
//   - `x.message ||` / `x.message ??`, and `typeof x.error === 'string' ?`.
// A caught failure is decided by binding, not by name: only a `catch (x)`
// variable or a `.catch((x) => …)` parameter is exempt, so an `error` pulled
// out of a body is still an envelope read. A site inside a counted site is
// the same site and counts once. Type-only wrappers (`as`, `<T>x`,
// `satisfies`) are looked through, and a caught failure may be aliased
// (`const err = caught as Error`) or be a `.then(ok, (err) => …)` rejection
// handler's parameter.
//
// Those sites existed when the rule was written, so it is a per-file baseline
// (sdk-envelope-read-baseline.json) that may only fall: later #2708 slices
// migrate clients and lower it with `--update`, which refuses to raise a row
// or add a file. The ratchet is two-sided: a count BELOW its row fails too,
// telling the author to run `--update`. Without that, a rule that silently
// stops counting (a broken AST walk reads 0 everywhere) would pass forever
// over a baseline nothing enforces any more. The cost is that two merges that
// each lower the same row conflict on the baseline file, which is a visible
// merge conflict rather than a silent pass.
//
// Renaming a baselined file (`git mv`): `--update` refuses the new path,
// because it never adds a row. Move the row by hand in the same commit — the
// old path's key renamed to the new one, the count unchanged — and say so in
// the commit message. That is the only hand edit the baseline takes; the
// reviewer checks the diff is a pure key rename. A split file is migrated to
// the helper instead of re-baselined.
//
// Widening the rule itself (as #2708's review round did) raises counts the
// rule could not see before; that is a rule change, not a regression, and the
// baseline is regenerated in the same commit with the new total stated.
//
// Deliberately opaque errors (decided for A-2): several fetchers withhold the
// server's words on purpose — `new StationHttpError(response.status, 'Input
// request unavailable')` in input-reply.ts and quote-source.ts, and the
// `Task*RequestError(response.status)` family. They are counted like any
// other site. Their migration is `envelopeError(response, body, fallback,
// { message: '<fixed text>' })`, which keeps the observed status, `code` and
// `Retry-After` while withholding the server's message and `details`. There
// is no allow-comment: an opaque error still owes its caller the status and
// code, so there is nothing to exempt.
//
// What the rule cannot see: a message built from an envelope field by any
// other function; an element access (`body['error']`); a fetch result held in
// an arbitrarily named local (`const reply = await fetch(…)` then
// `reply.status` is seen only when `reply` is typed `Response`); a destructured
// field whose source is not a recognised body read (`const { error } = x`
// with an arbitrary `x`); an aliased helper import; or an error built in one
// module and thrown from another. It routes new code to the helper; it is not
// a proof.
//
//   node scripts/sdk-error-message-ratchet.mjs [--update]

import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript-api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
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
  const output = execFileSyncBounded(
    'git',
    ['ls-files', '--', ...SCAN_PATHSPECS],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
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

/** `response.status`, `r.status`, `res.status`, `listResponse.status`. */
const RESPONSE_NAME = /^(r|res|resp|response)$|Response$/;

function unwrap(expression) {
  let current = expression;
  while (
    ts.isNonNullExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function parametersOf(node) {
  return ts.isFunctionLike(node) ? (node.parameters ?? []) : [];
}

/**
 * Is this identifier bound by a `catch (x)` clause or as the first parameter
 * of a `.catch((x) => …)` callback? Only those hold a CAUGHT failure, whose
 * `.message` re-wraps an error rather than reading an envelope. The binding
 * is resolved by walking outward: the nearest function that declares the
 * name as an ordinary parameter shadows any catch further out.
 */
export function isCaughtBinding(identifier, seen = new Set()) {
  const name = identifier.text;
  for (let node = identifier.parent; node; node = node.parent) {
    if (
      ts.isCatchClause(node) &&
      node.variableDeclaration &&
      ts.isIdentifier(node.variableDeclaration.name) &&
      node.variableDeclaration.name.text === name
    ) {
      return true;
    }
    const declares = parametersOf(node).some(
      (parameter) =>
        ts.isIdentifier(parameter.name) && parameter.name.text === name,
    );
    if (declares) return isRejectionHandler(node, name);
    const alias = aliasInitializer(node, name);
    if (alias) {
      // `const err = caught as Error`: the alias is caught iff its source is.
      const source = unwrap(alias);
      if (!ts.isIdentifier(source) || seen.has(source.text)) return false;
      seen.add(name);
      return isCaughtBinding(source, seen);
    }
  }
  return false;
}

/**
 * Is `fn` a rejection handler whose FIRST parameter is `name`? That is a
 * `.catch(fn)` callback, or the second argument of `.then(onOk, fn)`.
 */
function isRejectionHandler(fn, name) {
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return false;
  const first = fn.parameters[0];
  if (!first || !ts.isIdentifier(first.name) || first.name.text !== name) {
    return false;
  }
  const call = fn.parent;
  if (!call || !ts.isCallExpression(call)) return false;
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  return (
    (method === 'catch' && call.arguments[0] === fn) ||
    (method === 'then' && call.arguments[1] === fn)
  );
}

/** The initializer of a `const name = …` declared directly in this block. */
function aliasInitializer(node, name) {
  if (!ts.isBlock(node) && !ts.isSourceFile(node)) return undefined;
  for (const statement of node.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer
      ) {
        return declaration.initializer;
      }
    }
  }
  return undefined;
}

function enclosingScope(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) {
    current = current.parent;
  }
  return current;
}

/**
 * A value that plausibly holds a response body: `await response.json()`,
 * `await readJsonBody(response)`, or a local named like one
 * (`body`, `payload`, `result`, `json`, `data`, `envelope`).
 */
const BODY_NAME = /^(body|payload|result|json|data|envelope|parsed)$/;

function isBodyRead(expression) {
  let current = unwrap(expression);
  if (ts.isAwaitExpression(current)) current = unwrap(current.expression);
  if (ts.isIdentifier(current)) return BODY_NAME.test(current.text);
  if (ts.isCallExpression(current)) {
    const name = calleeName(current.expression);
    return name === 'json' || name === 'readJsonBody';
  }
  return false;
}

/**
 * Does `name` come out of an object destructuring of an envelope field, from
 * a body read (`const { error } = body`, `const { error } = await
 * response.json()`)? A destructuring of any other object (`const { message }
 * = options`) is not an envelope read, and a caught failure never is.
 */
function isDestructuredEnvelopeField(identifier) {
  if (isCaughtBinding(identifier)) return false;
  const scope = enclosingScope(identifier);
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isBindingElement(node) &&
      ts.isObjectBindingPattern(node.parent) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier.text
    ) {
      const property = node.propertyName ?? node.name;
      const declaration = node.parent.parent;
      if (
        ts.isIdentifier(property) &&
        ENVELOPE_FIELDS.has(property.text) &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        isBodyRead(declaration.initializer)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (scope) visit(scope);
  return found;
}

/** A receiver that names a `Response`, by convention or by declared type. */
function isResponseReceiver(expression) {
  const receiver = unwrap(expression);
  if (!ts.isIdentifier(receiver)) return false;
  if (RESPONSE_NAME.test(receiver.text)) return true;
  for (let node = receiver.parent; node; node = node.parent) {
    const parameter = parametersOf(node).find(
      (candidate) =>
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === receiver.text,
    );
    if (parameter) {
      return Boolean(
        parameter.type && /\bResponse\b/.test(parameter.type.getText()),
      );
    }
  }
  return false;
}

/** `x.error` / `x.message` / `x.code`, unless `x` is a caught failure. */
function isEnvelopeFieldRead(node) {
  if (!ts.isPropertyAccessExpression(node)) return false;
  if (!ENVELOPE_FIELDS.has(node.name.text)) return false;
  const receiver = unwrap(node.expression);
  return !(ts.isIdentifier(receiver) && isCaughtBinding(receiver));
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
    if (isEnvelopeFieldRead(child)) {
      found = `.${child.name.text}`;
      return;
    }
    if (
      ts.isPropertyAccessExpression(child) &&
      child.name.text === 'status' &&
      isResponseReceiver(child.expression)
    ) {
      found = `${unwrap(child.expression).getText()}.status`;
      return;
    }
    if (
      ts.isIdentifier(child) &&
      ENVELOPE_FIELDS.has(child.text) &&
      isDestructuredEnvelopeField(child)
    ) {
      found = `destructured ${child.text}`;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** `typeof x.error === 'string'` anywhere in a condition. */
function hasStringErrorCheck(node) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (
      ts.isBinaryExpression(child) &&
      (child.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        child.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    ) {
      const [left, right] = [unwrap(child.left), unwrap(child.right)];
      const typeofSide = ts.isTypeOfExpression(left) ? left : right;
      const literal = typeofSide === left ? right : left;
      if (
        ts.isTypeOfExpression(typeofSide) &&
        ts.isStringLiteral(literal) &&
        literal.text === 'string' &&
        isEnvelopeFieldRead(unwrap(typeofSide.expression)) &&
        unwrap(typeofSide.expression).name.text === 'error'
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * What kind of envelope-read site this node is, if any:
 * - `new *Error(...)` whose arguments read an envelope (a message-rule call,
 *   an `.error`/`.message`/`.code` read on anything but a caught failure, a
 *   destructured envelope field, or a Response's `.status`);
 * - any other call to a message-rule function — the message is computed into
 *   a variable and thrown later, or wrapped in `Object.assign(new Error(m))`;
 * - `x.message ||` / `x.message ??`: the envelope's message as a fallback;
 * - `typeof x.error === 'string' ? … : …`: the string shape hand-checked.
 */
function siteKind(node) {
  if (ts.isNewExpression(node)) {
    const name = calleeName(node.expression);
    if (!name || !/Error$/.test(name)) return undefined;
    const read = (node.arguments ?? [])
      .map((argument) => envelopeRead(argument))
      .find(Boolean);
    return read ? `new ${name}(${read})` : undefined;
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression);
    return name && ENVELOPE_MESSAGE_CALLS.has(name)
      ? `${name}() call`
      : undefined;
  }
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    const left = unwrap(node.left);
    return isEnvelopeFieldRead(left) && left.name.text === 'message'
      ? '.message fallback'
      : undefined;
  }
  if (ts.isConditionalExpression(node) && hasStringErrorCheck(node.condition)) {
    return "typeof x.error === 'string' ?";
  }
  return undefined;
}

/**
 * Every envelope-reading error site in one source, as `{ line, kind }`. The
 * walk is top-down and does not descend into a counted site, so a ternary or
 * a message-rule call inside a counted constructor is the same site, counted
 * once. Comments are never nodes, so prose that names a banned shape never
 * counts; import and export declarations are not calls, so neither do they.
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
  const visit = (node) => {
    const kind = siteKind(node);
    if (kind) {
      sites.push({
        line:
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1,
        kind,
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

export function listEnvelopeScannedFiles() {
  const output = execFileSyncBounded(
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
