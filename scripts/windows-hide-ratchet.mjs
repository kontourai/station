#!/usr/bin/env node
/**
 * Child-process calls without `windowsHide` may only decrease.
 *
 * On Windows, a console program launched without `windowsHide: true` opens a
 * console window. From the desktop app, the supervisor or an installed
 * service that is a window flashing over the user's work for every `git`,
 * `ssh` or engine probe; in Windows CI it is a window per test child. Node
 * defaults the option to `false`, so the omission is silent everywhere else.
 *
 * `src-server/AGENTS.md` and `scripts/AGENTS.md` stated "every new launch
 * must set `windowsHide: true`" as prose, and reviewers checked it by hand:
 * review-ledger notes recorded that check on more than sixty changes. This
 * computes it instead. It holds the number of calls per file that provably
 * omit the option at or below a checked-in baseline, so a new omission fails
 * in the file that adds it.
 *
 * What it reads. TypeScript syntax of every scanned file that mentions
 * `child_process`. A call counts when its callee is `spawn`, `spawnSync`,
 * `execFile`, `execFileSync`, `exec`, `execSync` or `fork` bound from
 * `child_process` or `node:child_process` (named import, renamed import,
 * namespace or default import, `require` or `await import` destructuring, or
 * `promisify(...)` of one of those) AND its options are visibly missing the
 * key: no options argument at all, or an object literal (inline, or a `const`
 * in the same file) without a `windowsHide` property.
 *
 * What it does not count, on purpose. An options object with a spread
 * (`{ ...base }`), or one passed as a parameter or other expression, may
 * carry the key, and the gate cannot see it; counting it would make every
 * wrapper a false positive. Wrappers such as `spawnSyncBounded`
 * (`scripts/lib/bounded-capture.mjs`) set the option themselves and are not
 * `child_process` callees. `spawn(cmd, argsVariable)` with exactly two
 * arguments is ambiguous between arguments and options and is not counted.
 * An explicit `windowsHide: false` is a visible decision and is accepted.
 *
 * The baseline is per file, like `test-temp-dir-ratchet.mjs`: a count below
 * its row is reported but does not fail (two changes that each lower a row
 * merge into a count below both), and `--update` only lowers or removes rows.
 *
 *   node scripts/windows-hide-ratchet.mjs [--update]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript-api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

export const BASELINE_PATH = 'scripts/windows-hide-baseline.json';

export const SCAN_ROOTS = [
  'src-server',
  'src-shared',
  'packages',
  'scripts',
  'tests',
  'examples',
];

const CODE_PATH = /\.[cm]?[jt]sx?$/;

/**
 * Files that launch processes and are expected to stay in scope. If a
 * pathspec change drops one, the gate fails rather than going green over a
 * smaller tree (station#1559 class).
 */
export const SCOPE_SENTINELS = [
  'src-server/utils/git-exec.ts',
  'scripts/lib/bounded-capture.mjs',
  'packages/cli/src/commands/open-browser.ts',
];

const CHILD_PROCESS_MODULE = /^(?:node:)?child_process$/;

const LAUNCHERS = new Set([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork',
]);

/** `exec(command, options?, callback?)`: options sit right after the command. */
const COMMAND_STRING_LAUNCHERS = new Set(['exec', 'execSync']);

function isChildProcessSpecifier(node) {
  return (
    node !== undefined &&
    ts.isStringLiteralLike(node) &&
    CHILD_PROCESS_MODULE.test(node.text)
  );
}

/** `require('child_process')` or `await import('node:child_process')`. */
function isChildProcessLoad(node) {
  let expression = node;
  while (
    expression &&
    (ts.isAwaitExpression(expression) ||
      ts.isParenthesizedExpression(expression))
  ) {
    expression = expression.expression;
  }
  if (!expression || !ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  const isLoader =
    (ts.isIdentifier(callee) && callee.text === 'require') ||
    callee.kind === ts.SyntaxKind.ImportKeyword;
  return isLoader && isChildProcessSpecifier(expression.arguments[0]);
}

function isPromisify(callee) {
  return (
    (ts.isIdentifier(callee) && callee.text === 'promisify') ||
    (ts.isPropertyAccessExpression(callee) && callee.name.text === 'promisify')
  );
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * The calls in one source that launch a child process without a visible
 * `windowsHide`. Returns `{ line, launcher, text }` per call.
 */
export function findOmissions(source, file = 'source.ts') {
  if (!source.includes('child_process')) return [];
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(file),
  );

  /** Local name -> child_process launcher it is bound to. */
  const launchers = new Map();
  /** Local names bound to the whole module. */
  const namespaces = new Set();
  /** Local name -> object literal it was declared with (`const opts = {}`). */
  const objectConsts = new Map();

  const bindDestructured = (pattern) => {
    for (const element of pattern.elements) {
      const imported = (element.propertyName ?? element.name).getText(sf);
      if (LAUNCHERS.has(imported) && ts.isIdentifier(element.name)) {
        launchers.set(element.name.text, imported);
      }
    }
  };

  const launcherOf = (callee) => {
    if (ts.isIdentifier(callee)) return launchers.get(callee.text);
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text) &&
      LAUNCHERS.has(callee.name.text)
    ) {
      return callee.name.text;
    }
    return undefined;
  };

  // Pass 1: bindings. Imports are hoisted; `require`/`promisify` bindings
  // are collected wherever they are declared.
  const bind = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      isChildProcessSpecifier(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      const named = clause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (LAUNCHERS.has(imported)) {
            launchers.set(element.name.text, imported);
          }
        }
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isChildProcessSpecifier(node.moduleReference.expression)
    ) {
      namespaces.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (isChildProcessLoad(init)) {
        if (ts.isIdentifier(node.name)) namespaces.add(node.name.text);
        else if (ts.isObjectBindingPattern(node.name)) {
          bindDestructured(node.name);
        }
      } else if (ts.isIdentifier(node.name)) {
        if (ts.isObjectLiteralExpression(init)) {
          if (!objectConsts.has(node.name.text)) {
            objectConsts.set(node.name.text, init);
          }
        } else if (
          ts.isCallExpression(init) &&
          isPromisify(init.expression) &&
          init.arguments[0]
        ) {
          const wrapped = launcherOf(init.arguments[0]);
          if (wrapped) launchers.set(node.name.text, wrapped);
        }
      }
    }
    ts.forEachChild(node, bind);
  };
  bind(sf);
  // A `promisify` binding declared before its import line is rare but legal;
  // a second pass picks up wrappers of names bound later in the file.
  bind(sf);

  if (launchers.size === 0 && namespaces.size === 0) return [];

  const isCallback = (node) =>
    ts.isArrowFunction(node) || ts.isFunctionExpression(node);

  /** The options argument, `null` when provably absent, `undefined` if unknown. */
  const optionsArgument = (launcher, args) => {
    const rest = args.slice(1).filter((arg) => !isCallback(arg));
    if (COMMAND_STRING_LAUNCHERS.has(launcher)) return rest[0] ?? null;
    const second = rest[0];
    if (second === undefined) return null;
    if (ts.isArrayLiteralExpression(second)) return rest[1] ?? null;
    if (ts.isObjectLiteralExpression(second)) return second;
    // `spawn(cmd, argsOrOptions)`: cannot tell which without types.
    return rest.length >= 2 ? rest[1] : undefined;
  };

  /** true: has the key; false: provably lacks it; undefined: cannot see. */
  const declaresWindowsHide = (options) => {
    let literal = options;
    if (ts.isIdentifier(options)) literal = objectConsts.get(options.text);
    if (!literal || !ts.isObjectLiteralExpression(literal)) return undefined;
    let sawSpread = false;
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        sawSpread = true;
        continue;
      }
      const name = property.name;
      if (!name) continue;
      const key =
        ts.isIdentifier(name) || ts.isStringLiteralLike(name)
          ? name.text
          : undefined;
      if (key === 'windowsHide') return true;
    }
    return sawSpread ? undefined : false;
  };

  const omissions = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const launcher = launcherOf(node.expression);
      if (launcher) {
        const options = optionsArgument(launcher, node.arguments);
        const missing =
          options === null ||
          (options !== undefined && declaresWindowsHide(options) === false);
        if (missing) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          omissions.push({
            line: line + 1,
            launcher,
            text: node.getText(sf).split('\n')[0].trim().slice(0, 120),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return omissions;
}

export function listScannedFiles(cwd = process.cwd()) {
  // Tracked AND untracked-but-not-ignored: a brand-new file is exactly the
  // case this gate exists for.
  const output = execFileSyncBounded(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...SCAN_ROOTS,
    ],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  return [...new Set(output.split('\n'))]
    .filter((file) => CODE_PATH.test(file) && !file.endsWith('.d.ts'))
    .sort();
}

export function scanFiles(files, read = (file) => readFileSync(file, 'utf8')) {
  const findings = {};
  for (const file of files) {
    let source;
    try {
      source = read(file);
    } catch (error) {
      // Listed by git but deleted in the working tree: nothing to count.
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const omissions = findOmissions(source, file);
    if (omissions.length > 0) findings[file] = omissions;
  }
  return findings;
}

export function countsOf(findings) {
  return Object.fromEntries(
    Object.entries(findings).map(([file, rows]) => [file, rows.length]),
  );
}

export function evaluate(counts, files, baseline) {
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
  const missingSentinels = SCOPE_SENTINELS.filter(
    (sentinel) => !files.includes(sentinel),
  );
  return {
    over,
    under,
    missingSentinels,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    ok: over.length === 0 && missingSentinels.length === 0,
  };
}

/** Lower-only: refuses any row that would rise or appear. */
export function lowerBaseline(counts, baseline) {
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

function main(argv) {
  const files = listScannedFiles();
  const findings = scanFiles(files);
  const counts = countsOf(findings);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

  if (argv.includes('--update')) {
    const lowered = lowerBaseline(counts, baseline);
    if (!lowered.ok) {
      console.error(
        'FAIL: --update only lowers the windowsHide baseline; these files would rise:',
      );
      for (const row of lowered.refused) {
        console.error(`  ${row.file}: ${row.count} (baseline ${row.ceiling})`);
      }
      console.error('Pass windowsHide: true to the new child-process calls.');
      return 1;
    }
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(lowered.baseline, null, 2)}\n`,
    );
    console.log(`OK: wrote ${BASELINE_PATH}`);
    return 0;
  }

  const result = evaluate(counts, files, baseline);
  if (result.missingSentinels.length > 0) {
    console.error(
      `FAIL: windowsHide ratchet scope lost these files: ${result.missingSentinels.join(', ')}`,
    );
    return 1;
  }
  if (result.over.length > 0) {
    console.error(
      'FAIL: child-process calls without windowsHide rose above the baseline:',
    );
    for (const row of result.over) {
      console.error(`  ${row.file}: ${row.count} (baseline ${row.ceiling})`);
      for (const hit of findings[row.file]) {
        console.error(`    ${row.file}:${hit.line}: ${hit.text}`);
      }
    }
    console.error(
      'On Windows each such launch opens a console window over the user. Pass',
    );
    console.error(
      'windowsHide: true in the options object (Node defaults it to false).',
    );
    return 1;
  }
  if (result.under.length > 0) {
    console.log(
      'NOTE: calls without windowsHide fell below the baseline; record the lower count with',
    );
    console.log('`node scripts/windows-hide-ratchet.mjs --update`:');
    for (const row of result.under) {
      console.log(`  ${row.file}: ${row.count} (baseline ${row.ceiling})`);
    }
  }
  console.log(
    `OK: ${result.total} child-process calls without windowsHide across ${files.length} scanned files, at the baseline.`,
  );
  return 0;
}

if (invokedDirectly(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
