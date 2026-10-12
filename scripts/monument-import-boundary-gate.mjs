#!/usr/bin/env node
/**
 * Monument import boundary (#3565, ADR 0005 Tier 1).
 *
 * `@kontourai/monument` is a publishable package with one consumer, Station.
 * Tier 1 lets it live in Station's workspace only if it imports nothing of
 * Station's, so it can leave the workspace without a rewrite. This gate is
 * that rule, checked over every source file in `packages/monument`:
 *
 * - an allowlist, not a denylist: a module specifier must be a `node:`
 *   builtin, a dependency `packages/monument/package.json` declares, or a
 *   relative path that stays inside the package. An alias such as `@/x`, a
 *   bare builtin without `node:`, or an undeclared package is refused like a
 *   Station import would be;
 * - `@kontourai/station` and every `@kontourai/station-*` package are refused
 *   by name even when declared, and declaring one in package.json is itself
 *   a violation, so adding the dependency is not a way around the rule;
 * - test files may also import the workspace test runner (`vitest`), which
 *   is not published with the package;
 * - a dynamic `import()` or `require()` whose argument is not a constant
 *   string cannot be checked and is refused, and so is every loader the
 *   import graph cannot see: `node:module` (`createRequire`),
 *   `getBuiltinModule`, a `require` that is referenced rather than called,
 *   and `import.meta.resolve`;
 * - no symlink may exist under the package: relative specifiers are checked
 *   by path, and a link would let `./x` resolve outside it;
 * - declaration files are scanned like any other source.
 *
 * Imports are read from the TypeScript syntax tree (static imports, re-exports,
 * `import x = require()`, `import()`, `require()`, `require.resolve()`,
 * `import('x').T` type queries and `/// <reference>` directives), not by text
 * matching.
 *
 *   node scripts/monument-import-boundary-gate.mjs
 */
import { lstatSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript-api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

export const MONUMENT_ROOT = 'packages/monument';
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const TEST_FILE = /(^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_ONLY_IMPORTS = new Set(['vitest']);
const MODULE_LOADER_SPECIFIERS = new Set(['node:module', 'module']);
const STATION_PACKAGE = /^@kontourai\/station(?:-[^/]+)?$/;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'devDependencies',
];
const RUNTIME_DEPENDENCY_FIELDS = new Set([
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
]);

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The package's declared dependencies, and a finding for every Station
 * package it declares.
 */
export function readManifest(manifestText, manifestPath) {
  const manifest = JSON.parse(manifestText);
  const runtime = new Set();
  const findings = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (STATION_PACKAGE.test(name))
        findings.push({
          kind: 'station-dependency',
          file: manifestPath,
          line: 1,
          specifier: `${field}.${name}`,
        });
      if (RUNTIME_DEPENDENCY_FIELDS.has(field)) runtime.add(name);
    }
  }
  return { declared: runtime, findings };
}

function constantString(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  return null;
}

/**
 * `require(...)`, `require.resolve(...)`: the call forms the visitor checks
 * by their argument. A property NAMED `require` is not the loader.
 */
function isRequireCallee(identifier) {
  const parent = identifier.parent;
  if (ts.isCallExpression(parent) && parent.expression === identifier)
    return true;
  if (ts.isPropertyAccessExpression(parent)) {
    if (parent.name === identifier) return true;
    return (
      parent.expression === identifier &&
      parent.name.text === 'resolve' &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    );
  }
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === identifier
  );
}

/** Every module reference in one file: `{ specifier | null, line, how }`. */
export function moduleReferences(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const references = [];
  const lineOf = (position) =>
    source.getLineAndCharacterOfPosition(position).line + 1;
  for (const directive of [
    ...source.referencedFiles,
    ...source.typeReferenceDirectives,
  ])
    references.push({
      specifier: directive.fileName,
      line: lineOf(directive.pos),
      how: 'reference-directive',
    });
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      references.push({
        specifier: constantString(node.moduleSpecifier),
        line: lineOf(node.getStart()),
        how: 'static',
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      references.push({
        specifier: constantString(node.moduleReference.expression),
        line: lineOf(node.getStart()),
        how: 'import-equals',
      });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      references.push({
        specifier:
          ts.isLiteralTypeNode(argument) &&
          ts.isStringLiteralLike(argument.literal)
            ? argument.literal.text
            : null,
        line: lineOf(node.getStart()),
        how: 'import-type',
      });
    } else if (
      ts.isIdentifier(node) &&
      node.text === 'require' &&
      !isRequireCallee(node)
    ) {
      references.push({
        specifier: '<require reference>',
        line: lineOf(node.getStart()),
        how: 'module-loader',
      });
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'getBuiltinModule'
    ) {
      references.push({
        specifier: '<getBuiltinModule>',
        line: lineOf(node.getStart()),
        how: 'module-loader',
      });
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === 'resolve'
    ) {
      references.push({
        specifier: '<import.meta.resolve>',
        line: lineOf(node.getStart()),
        how: 'module-loader',
      });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isRequireResolve =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'require' &&
        callee.name.text === 'resolve';
      if (isDynamicImport || isRequire || isRequireResolve)
        references.push({
          specifier: node.arguments[0]
            ? constantString(node.arguments[0])
            : null,
          line: lineOf(node.getStart()),
          how: isDynamicImport ? 'dynamic-import' : 'require',
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

/** Why a reference from `file` is refused, or null when it is allowed. */
export function classifyReference(file, reference, declared) {
  const { specifier } = reference;
  if (reference.how === 'module-loader') return 'module-loader';
  if (specifier === null) return 'unverifiable-import';
  if (MODULE_LOADER_SPECIFIERS.has(specifier)) return 'module-loader';
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('.')) {
    const resolved = posix.normalize(
      posix.join(posix.dirname(file), specifier),
    );
    return resolved === MONUMENT_ROOT ||
      resolved.startsWith(`${MONUMENT_ROOT}/`)
      ? null
      : 'escapes-package';
  }
  if (specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier))
    return 'escapes-package';
  const name = packageNameOf(specifier);
  if (STATION_PACKAGE.test(name)) return 'station-import';
  if (declared.has(name)) return null;
  if (TEST_FILE.test(file) && TEST_ONLY_IMPORTS.has(name)) return null;
  return 'undeclared-import';
}

export function scanMonument({ files, readText }) {
  const manifestPath = `${MONUMENT_ROOT}/package.json`;
  const { declared, findings } = readManifest(
    readText(manifestPath),
    manifestPath,
  );
  for (const file of files) {
    if (!SOURCE_EXTENSION.test(file)) continue;
    for (const reference of moduleReferences(file, readText(file))) {
      const kind = classifyReference(file, reference, declared);
      if (kind)
        findings.push({
          kind,
          file,
          line: reference.line,
          specifier: reference.specifier ?? `<non-constant ${reference.how}>`,
        });
    }
  }
  return findings;
}

function listPackageFiles() {
  // Untracked files count too: a planted import must fail before it is added.
  return execFileSyncBounded(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      MONUMENT_ROOT,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
    .split('\n')
    .filter(Boolean);
}

function main() {
  const listed = listPackageFiles();
  const symlinks = listed
    .filter((file) =>
      lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink(),
    )
    .map((file) => ({ kind: 'symlink', file, line: 1, specifier: '' }));
  const files = listed.filter(
    (file) =>
      SOURCE_EXTENSION.test(file) &&
      !symlinks.some((link) => link.file === file),
  );
  if (files.length === 0) {
    console.error(
      `FAIL: monument import boundary found no source files under ${MONUMENT_ROOT}; refusing to report an empty scope as clean.`,
    );
    process.exit(1);
  }
  const findings = [
    ...symlinks,
    ...scanMonument({
      files,
      readText: (path) => readFileSync(path, 'utf8'),
    }),
  ];
  if (findings.length > 0) {
    console.error(
      `FAIL: monument import boundary: ${findings.length} forbidden module reference(s). @kontourai/monument may import only node: builtins, its declared dependencies and its own files, never Station, and may contain no symlink (ADR 0005 Tier 1).`,
    );
    for (const finding of findings)
      console.error(
        `  ${finding.kind}: ${finding.file}:${finding.line} ${finding.specifier}`,
      );
    process.exit(1);
  }
  console.log(
    `OK: monument import boundary: ${files.length} source file(s) import only node: builtins, declared dependencies and package-local modules.`,
  );
}

if (invokedDirectly(import.meta.url)) main();
