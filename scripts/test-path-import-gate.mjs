#!/usr/bin/env node
// #2333: product code must not import from a path CodeQL does not scan.
//
// #2330 made two checks skip test paths. CodeQL ignores the `paths-ignore`
// globs in `SECURITY_CODEQL_CONFIG`, and the iOS relevance classifier
// (`classify-ci-change.mjs`) treats test-only files under `src-ui/` and a
// package's `src/__tests__/` as unable to change the simulator build. Both
// rest on one premise: no product module imports from those paths. If one
// did, product logic placed in a `__tests__/` directory or named `*.spec.ts`
// would ship unscanned and unbuilt by the iOS lane.
//
// This gate computes that premise. Zero tolerance: no baseline, because the
// count is zero today and any non-zero count is a hole in both checks.
//
// The globs are parsed from `SECURITY_CODEQL_CONFIG` itself, never restated,
// so widening or narrowing what CodeQL skips moves this guard with it. The
// iOS classifier's test-only set is a subset of those globs within these
// roots, so guarding the CodeQL set guards both.
//
// Scope: git-tracked source under `src-ui/`, `src-server/`, `src-shared/` and
// `packages/*/src/`. A file is "product" when no ignore glob matches it —
// the same predicate CodeQL applies. `scripts/` and `playwright.config.ts`
// import CI tooling from `tests/` legitimately and are exempt; both sit
// outside the scanned roots, and the exemption is also applied inside them
// so a nested copy cannot quietly become product code that imports tests.
//
// Every module-reference form is extracted, including type-only imports and
// `import('x')` type queries: the premise is about what product code depends
// on, and fail-closed is the cheaper error. Relative specifiers resolve
// against the importer with TypeScript's `.js` -> `.ts` mapping, bare
// extensions and directory `index` files; the Vite/tsconfig aliases `@/`
// and `@shared/` resolve into their roots. Bare package specifiers are not
// followed: a package's `exports` map would have to expose a test path for
// one to reach it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import ts from 'typescript';
import { SECURITY_CODEQL_CONFIG } from './actionlint-gate.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

/** The CodeQL `paths-ignore` globs, parsed from the one declared config. */
export function codeqlIgnoreGlobs(config = SECURITY_CODEQL_CONFIG) {
  const parsed = load(config);
  const globs = parsed?.['paths-ignore'];
  if (
    !Array.isArray(globs) ||
    globs.length === 0 ||
    !globs.every((glob) => typeof glob === 'string' && glob.length > 0)
  )
    throw new Error(
      'SECURITY_CODEQL_CONFIG has no usable paths-ignore list; refusing to guard nothing',
    );
  return globs;
}

/** A predicate over repo-relative POSIX paths: does CodeQL skip this path? */
export function ignoredPathMatcher(globs = codeqlIgnoreGlobs()) {
  // Node's own glob matcher: no undeclared dependency to drift underneath it.
  return (repoPath) =>
    globs.some((glob) => path.posix.matchesGlob(toPosix(repoPath), glob));
}

const SCOPE_PATTERN =
  /^(?:src-ui\/|src-server\/|src-shared\/|packages\/[^/]+\/src\/)/;
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** CI tooling that imports test infrastructure by design (#2333). */
function isExemptPath(repoPath) {
  const posix = toPosix(repoPath);
  return (
    posix.startsWith('scripts/') ||
    posix.includes('/scripts/') ||
    path.posix.basename(posix) === 'playwright.config.ts'
  );
}

export function isScannedProductFile(repoPath, isIgnored) {
  const posix = toPosix(repoPath);
  return (
    SCOPE_PATTERN.test(posix) &&
    SOURCE_EXTENSION.test(posix) &&
    !isExemptPath(posix) &&
    !isIgnored(posix)
  );
}

function toPosix(value) {
  return String(value).replaceAll('\\', '/');
}

/** Every module specifier a file references, with its offset. */
export function extractModuleSpecifiers(content, fileName = 'module.ts') {
  const source = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  const record = (specifier, owner) => {
    if (specifier && ts.isStringLiteralLike(specifier))
      found.push({ specifier: specifier.text, index: owner.getStart(source) });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier, node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression, node);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument)) record(argument.literal, node);
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

const ALIASES = Object.freeze([
  ['@/', 'src-ui/src/'],
  ['@shared/', 'src-shared/'],
]);

/**
 * The repo-relative path a specifier names before extension resolution, or
 * null for a bare package specifier this gate does not follow.
 */
function lexicalTarget(importerRepoPath, specifier) {
  const bare = specifier.split(/[?#]/, 1)[0];
  if (
    bare.startsWith('./') ||
    bare.startsWith('../') ||
    bare === '.' ||
    bare === '..'
  )
    return path.posix.normalize(
      path.posix.join(path.posix.dirname(toPosix(importerRepoPath)), bare),
    );
  for (const [prefix, target] of ALIASES)
    if (bare.startsWith(prefix)) return target + bare.slice(prefix.length);
  return null;
}

const SCRIPT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.d.ts',
];
const JS_TO_TS = Object.freeze({
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
});

/** Candidate files, in resolution order, for a lexical target. */
function resolutionCandidates(target) {
  const candidates = [target];
  const ext = path.posix.extname(target);
  for (const mapped of JS_TO_TS[ext] ?? [])
    candidates.push(target.slice(0, -ext.length) + mapped);
  for (const extension of SCRIPT_EXTENSIONS)
    candidates.push(target + extension);
  for (const extension of SCRIPT_EXTENSIONS)
    candidates.push(`${target}/index${extension}`);
  return candidates;
}

function isFile(absolute) {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/**
 * The repo-relative file a specifier resolves to under `root`. When nothing
 * on disk matches, the lexical target stands in for it: an unresolvable
 * `../__tests__/x` still names an ignored directory.
 */
function resolveTarget(root, importerRepoPath, specifier) {
  const target = lexicalTarget(importerRepoPath, specifier);
  if (target === null) return null;
  const resolved = resolutionCandidates(target).find((candidate) =>
    isFile(path.join(root, candidate)),
  );
  return { path: resolved ?? target, resolved: resolved !== undefined };
}

function lineNumberAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}

/** Findings for one product file: each import that lands on an ignored path. */
function scanFile({ root, repoPath, content, isIgnored }) {
  const findings = [];
  for (const { specifier, index } of extractModuleSpecifiers(
    content,
    repoPath,
  )) {
    const target = resolveTarget(root, repoPath, specifier);
    if (target === null) continue;
    // An unresolved target is also judged as the file or directory index it
    // would most plausibly become, so `./foo.spec` is not waved through.
    const judged = target.resolved
      ? [target.path]
      : [target.path, `${target.path}.ts`, `${target.path}/index.ts`];
    if (judged.some((candidate) => isIgnored(candidate)))
      findings.push({
        file: repoPath,
        line: lineNumberAt(content, index),
        specifier,
        target: target.path,
      });
  }
  return findings;
}

function listTrackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

/** Runs the whole gate against a checkout. */
export function scanRepository(root, { config = SECURITY_CODEQL_CONFIG } = {}) {
  const isIgnored = ignoredPathMatcher(codeqlIgnoreGlobs(config));
  const files = listTrackedFiles(root).filter((file) =>
    isScannedProductFile(file, isIgnored),
  );
  const findings = [];
  for (const repoPath of files) {
    const absolute = path.join(root, repoPath);
    // A tracked path deleted in the working tree has nothing left to import.
    if (!existsSync(absolute)) continue;
    findings.push(
      ...scanFile({
        root,
        repoPath,
        content: readFileSync(absolute, 'utf8'),
        isIgnored,
      }),
    );
  }
  return { files, findings };
}

function parseRoot(argv) {
  const flagIndex = argv.indexOf('--root');
  if (flagIndex === -1 || !argv[flagIndex + 1]) return process.cwd();
  return path.resolve(argv[flagIndex + 1]);
}

function main() {
  const root = parseRoot(process.argv.slice(2));
  console.log(
    'Test-path import gate (#2333): no product module under src-ui/, ' +
      'src-server/, src-shared/ or packages/*/src/ may import a path the ' +
      'CodeQL paths-ignore globs skip.\n',
  );
  const { files, findings } = scanRepository(root);
  if (files.length === 0) {
    console.error(
      'FAIL: no product files were found to scan; an empty scope proves nothing.',
    );
    process.exit(1);
  }
  if (findings.length > 0) {
    console.error(
      `FAIL: ${findings.length} product import(s) reach a CodeQL-ignored path:\n`,
    );
    for (const f of findings)
      console.error(`  ${f.file}:${f.line}: '${f.specifier}' -> ${f.target}`);
    console.error(
      '\nCodeQL does not scan these paths and the iOS classifier treats them ' +
        'as test-only, so product code imported from one ships unchecked by ' +
        'both. Move the shared module out of the test path, or stop importing ' +
        'it from product code. The globs come from SECURITY_CODEQL_CONFIG in ' +
        'scripts/actionlint-gate.mjs.',
    );
    process.exit(1);
  }
  console.log(
    `OK: ${files.length} product file(s) scanned; none imports a CodeQL-ignored path.`,
  );
}

if (invokedDirectly(import.meta.url)) {
  main();
}
