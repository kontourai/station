#!/usr/bin/env node
// station#3423: a test file that imports a package no `npm install` in this
// repo has ever put on disk cannot execute as written — it either errors
// somewhere nothing surfaces, or (as happened here) the file gets quietly
// excluded from the runner's `include`/`exclude` globs and just never runs.
// Either way it sits in the tree looking like coverage while proving
// nothing, which is exactly the defect class #3389/#3345 already named.
// The concrete instance this gate exists for:
// `packages/connect/src/__tests__/qr-round-trip.test.ts` imported `canvas`
// (with a comment telling the reader to install it as a dev dependency)
// while `canvas` was in zero `package.json` files anywhere in this repo.
//
// This gate proves, for every git-tracked test file, that every bare
// (non-relative, non-builtin, non-bundler-alias) package specifier it
// imports at the VALUE level (never a `import type`-only specifier, which
// is erased before anything runs) actually resolves to an installed
// package: a `node_modules/<pkg>` directory reachable by walking up from
// the test file's own directory — the same directory-walk algorithm
// Node's own module resolution performs for a bare specifier. This is
// deliberately NOT a `package.json` membership check (a workspace's
// hoisting means a dependency declared only in a sibling package's
// package.json is legitimately reachable from here) and NOT a
// `require.resolve()` call (which can false-positive on a pure-ESM
// package whose `exports` map omits the CJS `require` condition) — it is
// the one fact that actually matters: is there a real, installed package
// under this name, anywhere between this file and the filesystem root.
//
// Parse syntax so generated module fixtures and comments are not mistaken for
// imports by the test itself. The TypeScript parser also preserves real imports
// across comments and visits executable expressions inside template literals.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// `process.cwd()`, not a path relative to this script file — matches
// `git ls-files`'s own working-directory semantics and lets the gate be
// exercised as a real child process against a throwaway scratch repo in
// tests (station#3423's own regression coverage for this file).
const REPO_ROOT = process.cwd();

// Exported so the gate's own regression coverage can derive the expected
// tracked-test-file count independently of `listTrackedTestFiles`'s path
// filtering — a scope bug added inside that function (e.g. an accidental
// `packages/**` exclusion) must not be able to hide behind a test that
// reuses the same buggy git-ls-files-plus-filter enumeration to check
// itself (station#3423 review MEDIUM-1). That still leaves this PATTERN
// itself unchecked by anything other than its own re-derivation, which is
// a tautology one level up (station#3435 review MEDIUM-1): the gate's own
// regression suite cross-checks it against `VITEST_TEST_FILE_PATTERN`
// (`verification-policy-gate.mjs`) — a pre-existing, independently
// declared, strictly broader predicate already used to discover the same
// tracked test corpus for a different gate — rather than a third
// re-declared copy of this same regex.
//
// Extensions covered: `.ts`/`.tsx`/`.js`/`.jsx`/`.mts`/`.mjs`/`.cts`/`.cjs`
// (station#3435 review LOW: `.cts`/`.cjs` were missing, which `vitest`'s
// own default `include` glob collects — zero live instances today, but a
// future CommonJS test file would have silently never been gated).
export const TEST_FILE_PATTERN =
  /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|mjs|cts|cjs)$/;

// Bundler/tsconfig path aliases, not real npm scopes — sourced from
// `vite.config.ts`'s `resolve.alias` and `src-ui/tsconfig.json`'s `paths`.
// `@shared/*` in particular is a real-looking scoped-package shape
// (`@shared/chat-input-limits` appears in test files today) that resolves
// via the bundler, never via `node_modules/@shared`; update this list if
// either config gains a new alias prefix.
const ALIAS_PREFIXES = ['@/', '@shared/'];

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** Extracts every VALUE-level bare import specifier from test file content. */
export function extractValueSpecifiers(content, fileName = 'test.ts') {
  const source = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest);
  const found = [];
  const record = (specifier, owner) => {
    if (specifier && ts.isStringLiteralLike(specifier))
      found.push({ specifier: specifier.text, index: owner.getStart(source) });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) record(node.moduleSpecifier, node);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) record(node.moduleSpecifier, node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference)
      )
        record(node.moduleReference.expression, node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require')
      )
        record(node.arguments[0], node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isBareSpecifier(specifier) {
  return (
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('node:')
  );
}

function isKnownAlias(specifier) {
  return ALIAS_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

const BUILTIN_NAMES = new Set(builtinModules);

function isNodeBuiltin(specifier) {
  return BUILTIN_NAMES.has(specifier);
}

/** `@scope/name/sub/path` -> `@scope/name`; `name/sub/path` -> `name`. */
export function packageNameOf(specifier) {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0];
}

/**
 * Walks up from `fromDir` checking `node_modules/<packageName>` at every
 * level — the same directory-walk a bare specifier resolves through in
 * real `require`/`import`, workspace hoisting included.
 *
 * `boundaryRoot`, when non-null, stops the walk once it reaches that
 * directory (inclusive — the boundary itself is still checked). Passing
 * `null` continues the walk to the filesystem root, which is faithful to
 * real Node resolution but makes the gate's verdict depend on
 * `node_modules` directories OUTSIDE the tree being gated: this repo's
 * standard layout is ~80 worktrees under a parent checkout that has its own
 * `node_modules`, so a worktree missing a dependency reads OK here by
 * inheriting the parent's install — a false green, in the false-positive
 * direction, in exactly the place a developer runs this gate. `main()`
 * always passes the gate's `--root` (or `process.cwd()`) as the boundary so
 * the verdict depends only on the tree being gated.
 *
 * `boundaryRoot` has no default: a caller that wants the unbounded walk
 * (the pure-function tests below, deliberately, to keep exercising it
 * directly) must pass `null` explicitly. A default of `null` would let a
 * future caller inherit this gate's original false-green hole simply by
 * forgetting the third argument (archive#3423) — omitting it
 * now throws instead of silently resolving unbounded.
 */
export function packageResolvesFrom(fromDir, packageName, boundaryRoot) {
  let dir = fromDir;
  for (;;) {
    if (existsSync(path.join(dir, 'node_modules', packageName))) return true;
    if (
      boundaryRoot !== null &&
      path.resolve(dir) === path.resolve(boundaryRoot)
    ) {
      return false;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function listTrackedTestFiles(root) {
  const out = execFileSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((file) => TEST_FILE_PATTERN.test(file));
}

// `--root <path>` lets this gate be exercised as a real child process
// against a throwaway scratch git repo — the regression test for this
// file's own reject path (station#3423's own instance of "a guardrail
// whose rejection path never executed is unproven").
function parseRoot(argv) {
  const flagIndex = argv.indexOf('--root');
  if (flagIndex === -1 || !argv[flagIndex + 1]) return REPO_ROOT;
  return path.resolve(argv[flagIndex + 1]);
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  console.log(
    "Test import existence gate (station#3423): every test file's bare " +
      'imports must resolve to an actually-installed package.\n',
  );

  const files = listTrackedTestFiles(root);
  const findings = [];

  for (const relFile of files) {
    const absFile = path.join(root, relFile);
    const content = readFileSync(absFile, 'utf8');
    const fromDir = path.dirname(absFile);
    const seen = new Set();
    for (const { specifier, index } of extractValueSpecifiers(
      content,
      relFile,
    )) {
      if (!isBareSpecifier(specifier)) continue;
      if (isNodeBuiltin(specifier)) continue;
      if (isKnownAlias(specifier)) continue;
      const packageName = packageNameOf(specifier);
      if (seen.has(packageName)) continue;
      seen.add(packageName);
      if (!packageResolvesFrom(fromDir, packageName, root)) {
        findings.push({
          file: relFile,
          line: lineNumberAt(content, index),
          specifier,
          packageName,
        });
      }
    }
  }

  if (findings.length > 0) {
    console.error(`FAIL: ${findings.length} unresolvable import(s) found:\n`);
    for (const f of findings) {
      console.error(
        `  ${f.file}:${f.line}: '${f.specifier}' — no node_modules/${f.packageName} reachable from this file`,
      );
    }
    console.error(
      '\nA test file that imports an uninstalled package cannot execute as ' +
        'written — it sits in the tree looking like coverage while proving ' +
        'nothing (station#3423). Either install the package as a real ' +
        'dependency, rewrite the test against something already installed, ' +
        'or delete the test and say plainly what is not covered.',
    );
    process.exit(1);
  }

  console.log(
    `OK: every statically-extractable bare import in ${files.length} test file(s) resolves to an installed package.`,
  );
  process.exit(0);
}

// Not a raw `import.meta.url === \`file://${process.argv[1]}\`` string
// compare: `import.meta.url` percent-encodes characters like spaces while
// `process.argv[1]` is the literal invocation path, so that comparison
// silently mismatches (no-op — no output, exit 0, findings never checked)
// whenever the script is invoked from or through a path containing a space.
// `resolve()`/`fileURLToPath()` normalize both sides to plain filesystem
// paths first (the same idiom used by
// scripts/backlog-priority-policy.mjs and
// scripts/check-prepush-static-gates.mjs).
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
