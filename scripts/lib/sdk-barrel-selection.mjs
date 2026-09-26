/**
 * SDK barrel-aware related-test seeds (#2707).
 *
 * `vitest related <file>` walks each test's transformed import graph. The
 * SDK's two barrels (`packages/sdk/src/index.ts` and
 * `packages/sdk/src/client/index.ts`) re-export every client module, and
 * hundreds of UI modules import the root barrel, so an edit to ONE client
 * module selected ~750 suites: every barrel importer, whatever it imported.
 *
 * This module narrows that one edge. For a changed SDK source module X it
 * computes the SEEDS whose importers are the real audience of X, and the
 * caller hands those seeds to the unchanged `vitest related` discovery in
 * place of X:
 *
 * 1. Every file that can import SDK source is parsed syntactically (TS
 *    compiler API). A named import from a barrel is resolved through the
 *    re-export chain (`export *`, `export { a } from`, a re-exported import)
 *    to the module that declares the name; the importer depends on that
 *    module, not on the barrel or the intermediate re-exporters.
 * 2. Inside the SDK, the set of source modules that transitively import X
 *    is computed over those refined edges.
 * 3. The seeds are the files OUTSIDE SDK source (other packages, the UI,
 *    SDK tests) with an edge into that set. `vitest related` over the seeds
 *    then finds every test reaching a seed through its own resolved graph.
 *
 * Why seeds rather than filtering vitest's output: vitest reports WHICH
 * tests reach a path, not HOW, so a post-filter would have to rebuild every
 * selected test's full graph with a second resolver. Seeds keep vitest as
 * the resolver for everything outside the SDK; this module only resolves
 * specifiers that point INTO the SDK, which it can do exactly (relative
 * paths and the SDK package's `exports` map).
 *
 * A seed set can only be narrower than `related(X)` by dropping a test whose
 * every path to X crosses a barrel through named imports that resolve away
 * from X. Everything this module cannot resolve with certainty stays whole:
 *
 * - namespace imports, side-effect imports, `export *` from a barrel, dynamic
 *   `import()`, `require()`, `vi.importActual`/`vi.importMock`/`vi.unmock`,
 *   an automock (`vi.mock(barrel)` with no factory), a factory that can reach
 *   the real module (`importOriginal`, or a file that loads modules a
 *   factory could call through), and `import.meta.glob` depend on the whole
 *   barrel. A zero-parameter inline factory mock in a file that never
 *   reaches the original evaluates nothing real, so it adds no dependency;
 * - a name the barrel declares itself, a name found in more than one star
 *   re-export, and a name that could come from a star re-export this module
 *   cannot enumerate, depend on the whole barrel;
 * - an SDK specifier that does not resolve depends on the whole SDK;
 * - X itself is refined only when its top-level evaluation has no side
 *   effect a barrel importer could observe, at the base AND at the head
 *   (`topLevelSideEffect`). Otherwise X keeps plain `related(X)`.
 * - names X exported at the base are still attributed to X, so an importer
 *   of a name X just stopped exporting is selected.
 * - a barrel edit is never refined: every barrel importer stays selected.
 *
 * Type-only imports are skipped: the transform erases them, so vitest's own
 * graph never contains them either.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';

const SDK_SOURCE_PREFIX = 'packages/sdk/src/';
const SDK_PACKAGE_NAME = '@kontourai/station-sdk';
const SDK_BARREL_PATHS = Object.freeze([
  'packages/sdk/src/index.ts',
  'packages/sdk/src/client/index.ts',
]);

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// Text a file must contain to hold an edge into the SDK: the package name, or
// a relative path through an `sdk` directory. Files under packages/sdk are
// always parsed.
const SDK_REFERENCE = /station-sdk|\/sdk(?:['"`/])/;
const UNKNOWN = '*';
const NOT_FOUND = Symbol('not-found');
const MOCK_METHODS = new Set([
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
]);
const RESOLUTION_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.mjs',
];

function isSdkPath(path) {
  return path.startsWith(SDK_SOURCE_PREFIX);
}

/** SDK source a barrel can reach: not a test, test helper, or declaration. */
function isSdkSourceModule(path) {
  return (
    isSdkPath(path) &&
    CODE_FILE.test(path) &&
    !DECLARATION_FILE.test(path) &&
    !TEST_FILE.test(path) &&
    !path.split('/').some((segment) => segment.startsWith('__test'))
  );
}

function parse(path, source, setParentNodes = false) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    setParentNodes,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}
// Only these spellings can make a call a module reference.
const CALL_REFERENCE = /\bimport\s*\(|\brequire\s*\(|\bvi\s*\.|\.glob\b/;

function stringArgument(node) {
  const argument = node.arguments[0];
  return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
}

function mockCall(node) {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'vi' &&
    MOCK_METHODS.has(callee.name.text)
  );
}

const ORIGINAL_ACCESS = /\b(?:importOriginal|importActual|importMock)\b/;

/**
 * `vi.mock(spec, factory)` / `vi.doMock(spec, factory)` whose factory is an
 * inline function taking no parameter: it cannot receive `importOriginal`.
 * Automock (no factory), `unmock`, and a factory passed by reference are not.
 */
function isFactoryMock(node) {
  const callee = node.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !['mock', 'doMock'].includes(callee.name.text) ||
    !mockCall(node)
  )
    return false;
  const factory = node.arguments[1];
  return Boolean(
    factory &&
      (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) &&
      factory.parameters.length === 0,
  );
}

// Imports from these can reach repository code (and so a vi.importActual of
// the SDK); third-party packages cannot name it.
const REPOSITORY_SPECIFIER = /^(?:\.|@\/|@shared\/|@kontourai\/)/;

/**
 * Identifiers a node reads: not the `.name` of a property access, nor an
 * object-literal or class member key (a shorthand property still reads).
 */
function referencedIdentifiers(node, into = new Set()) {
  if (ts.isIdentifier(node)) into.add(node.text);
  else if (ts.isPropertyAccessExpression(node))
    referencedIdentifiers(node.expression, into);
  else if (
    (ts.isPropertyAssignment(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node)) &&
    ts.isIdentifier(node.name)
  )
    ts.forEachChild(node, (child) => {
      if (child !== node.name) referencedIdentifiers(child, into);
    });
  // forEachChild stops at the first truthy callback result: return nothing.
  else
    ts.forEachChild(node, (child) => {
      referencedIdentifiers(child, into);
    });
  return into;
}

/**
 * Top-level names that can reach repository code: bindings imported from a
 * repository specifier, and, to a fixpoint, top-level declarations whose
 * text references one of them.
 */
function repositoryReachingNames(file) {
  const tainted = new Set();
  const declarations = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (
        !clause ||
        clause.isTypeOnly ||
        !REPOSITORY_SPECIFIER.test(statement.moduleSpecifier.text)
      )
        continue;
      if (clause.name) tainted.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        tainted.add(bindings.name.text);
      else if (bindings)
        for (const element of bindings.elements)
          if (!element.isTypeOnly) tainted.add(element.name.text);
      continue;
    }
    const names = [];
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        bindingNames(declaration.name, names);
    else if (statement.name && ts.isIdentifier(statement.name))
      names.push(statement.name.text);
    if (names.length)
      declarations.push({ names, reads: referencedIdentifiers(statement) });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const { names, reads } of declarations) {
      if (names.every((name) => tainted.has(name))) continue;
      if ([...reads].some((name) => tainted.has(name))) {
        for (const name of names) tainted.add(name);
        changed = true;
      }
    }
  }
  return tainted;
}

function isImportMetaGlob(node) {
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'glob' &&
    ts.isMetaProperty(callee.expression)
  );
}

/**
 * Runtime module references of one file, as written.
 * `names: null` means the importer depends on the whole target module.
 */
function collectModuleReferences(path, source) {
  const file = parse(path, source);
  const references = [];
  let opaque = false;
  const add = (specifier, names) => references.push({ specifier, names });
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (!clause) {
        add(specifier, null);
        continue;
      }
      if (clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        add(specifier, null);
        continue;
      }
      const names = [];
      if (clause.name) names.push('default');
      if (bindings)
        for (const element of bindings.elements)
          if (!element.isTypeOnly)
            names.push((element.propertyName ?? element.name).text);
      // Every binding type-only: the transform erases the declaration.
      if (names.length) add(specifier, names);
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue;
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.exportClause;
      if (!clause || ts.isNamespaceExport(clause)) {
        add(specifier, null);
        continue;
      }
      const names = clause.elements
        .filter((element) => !element.isTypeOnly)
        .map((element) => (element.propertyName ?? element.name).text);
      if (names.length) add(specifier, names);
      continue;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      !statement.isTypeOnly &&
      ts.isExternalModuleReference(statement.moduleReference) &&
      ts.isStringLiteralLike(statement.moduleReference.expression)
    )
      add(statement.moduleReference.expression.text, null);
  }
  const factoryMocks = [];
  let loadsModules = false;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const dynamicImport =
        node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (dynamicImport || requireCall) loadsModules = true;
      if (dynamicImport || requireCall || mockCall(node)) {
        const specifier = stringArgument(node);
        if (specifier !== null) {
          if (isFactoryMock(node))
            factoryMocks.push({ specifier, factory: node.arguments[1] });
          else add(specifier, null);
        }
        // A computed specifier can name any module; vitest cannot follow it
        // either, but this module does not guess.
        else if (dynamicImport || requireCall) opaque = true;
      } else if (isImportMetaGlob(node)) opaque = true;
    }
    ts.forEachChild(node, visit);
  };
  if (CALL_REFERENCE.test(source)) visit(file);
  // A factory mock replaces the module without evaluating it, so it adds no
  // dependency: the file's own named imports still resolve normally. That
  // holds only while the factory provably cannot reach the real module:
  // - any importOriginal/importActual/importMock spelling in the file, or any
  //   import()/require() (a loaded helper could call vi.importActual), keeps
  //   every mock in the file whole;
  // - a factory that references a binding imported from repository code
  //   (relative, alias, or @kontourai package), directly or through a
  //   top-level declaration that does, keeps that mock whole: the helper
  //   could call vi.importActual.
  const reachesOriginal = ORIGINAL_ACCESS.test(source) || loadsModules;
  const tainted = reachesOriginal ? null : repositoryReachingNames(file);
  for (const { specifier, factory } of factoryMocks)
    if (
      reachesOriginal ||
      [...referencedIdentifiers(factory)].some((name) => tainted.has(name))
    )
      add(specifier, null);
  return { references, opaque };
}

function bindingNames(name, into) {
  if (ts.isIdentifier(name)) into.push(name.text);
  else
    for (const element of name.elements)
      if (!ts.isOmittedExpression(element)) bindingNames(element.name, into);
  return into;
}

function hasModifier(node, kind) {
  return Boolean(
    ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === kind),
  );
}

/**
 * Exports of one module: locally declared names, named re-exports (through
 * `export { a as b } from` or an import that is re-exported), and star
 * re-export specifiers.
 */
function collectExports(path, source) {
  const file = parse(path, source);
  const local = new Set();
  const named = new Map();
  const stars = [];
  const imported = new Map();
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause.name)
        imported.set(clause.name.text, { specifier, name: 'default' });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        imported.set(bindings.name.text, { specifier, name: null });
      else if (bindings)
        for (const element of bindings.elements)
          imported.set(element.name.text, {
            specifier,
            name: (element.propertyName ?? element.name).text,
          });
    }
  }
  for (const statement of file.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier?.text;
      const clause = statement.exportClause;
      if (!clause) {
        if (specifier !== undefined) stars.push(specifier);
        continue;
      }
      if (ts.isNamespaceExport(clause)) {
        named.set(clause.name.text, { specifier, name: null });
        continue;
      }
      for (const element of clause.elements) {
        const exported = element.name.text;
        const source = (element.propertyName ?? element.name).text;
        if (specifier !== undefined)
          named.set(exported, { specifier, name: source });
        else if (imported.has(source))
          named.set(exported, imported.get(source));
        else local.add(exported);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      local.add('default');
      continue;
    }
    if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) {
      local.add('default');
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        for (const name of bindingNames(declaration.name, [])) local.add(name);
      continue;
    }
    if (statement.name && ts.isIdentifier(statement.name))
      local.add(statement.name.text);
  }
  return { local, named, stars };
}

// ---------------------------------------------------------------------------
// Top-level side effects.

const PURE_CALLS = new Set([
  'Object.freeze',
  'Object.fromEntries',
  'Object.entries',
  'Object.keys',
  'Object.values',
  'Symbol',
  'Symbol.for',
  'Array.from',
  'Array.of',
  'Array.isArray',
  'String',
  'Number',
  'Boolean',
  'BigInt',
]);
const PURE_CONSTRUCTORS = new Set([
  'Set',
  'Map',
  'WeakMap',
  'WeakSet',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'TextEncoder',
  'TextDecoder',
]);
const IMPURE_OPERATORS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

function calleeName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
    return `${node.expression.text}.${node.name.text}`;
  return null;
}

function pureClassMembers(node) {
  if (ts.getDecorators?.(node)?.length) return false;
  for (const clause of node.heritageClauses ?? [])
    for (const type of clause.types)
      if (!pureExpression(type.expression)) return false;
  for (const member of node.members) {
    if (ts.isClassStaticBlockDeclaration(member)) return false;
    if (ts.getDecorators?.(member)?.length) return false;
    if (
      member.name &&
      ts.isComputedPropertyName(member.name) &&
      !pureExpression(member.name.expression)
    )
      return false;
    if (
      ts.isPropertyDeclaration(member) &&
      hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
      member.initializer &&
      !pureExpression(member.initializer)
    )
      return false;
  }
  return true;
}

/**
 * Evaluating `node` at module top level cannot be observed outside the
 * module: no call except a small allowlist of standard constructors and
 * freezers, no assignment, no tagged template. Function and class bodies are
 * not evaluated, so they are not inspected.
 */
function pureExpression(node) {
  if (!node) return true;
  if (
    ts.isLiteralExpression(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isIdentifier(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  )
    return true;
  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
    case ts.SyntaxKind.ThisKeyword:
      return true;
  }
  if (ts.isClassExpression(node)) return pureClassMembers(node);
  if (ts.isTemplateExpression(node))
    return node.templateSpans.every((span) => pureExpression(span.expression));
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSpreadElement(node) ||
    ts.isTypeOfExpression(node) ||
    ts.isVoidExpression(node)
  )
    return pureExpression(node.expression);
  if (ts.isPrefixUnaryExpression(node))
    return (
      node.operator !== ts.SyntaxKind.PlusPlusToken &&
      node.operator !== ts.SyntaxKind.MinusMinusToken &&
      pureExpression(node.operand)
    );
  if (ts.isBinaryExpression(node))
    return (
      !IMPURE_OPERATORS.has(node.operatorToken.kind) &&
      pureExpression(node.left) &&
      pureExpression(node.right)
    );
  if (ts.isConditionalExpression(node))
    return (
      pureExpression(node.condition) &&
      pureExpression(node.whenTrue) &&
      pureExpression(node.whenFalse)
    );
  if (ts.isPropertyAccessExpression(node))
    return pureExpression(node.expression);
  if (ts.isElementAccessExpression(node))
    return (
      pureExpression(node.expression) && pureExpression(node.argumentExpression)
    );
  if (ts.isArrayLiteralExpression(node))
    return node.elements.every(
      (element) => ts.isOmittedExpression(element) || pureExpression(element),
    );
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every((property) => {
      if (
        property.name &&
        ts.isComputedPropertyName(property.name) &&
        !pureExpression(property.name.expression)
      )
        return false;
      if (ts.isPropertyAssignment(property))
        return pureExpression(property.initializer);
      if (ts.isSpreadAssignment(property))
        return pureExpression(property.expression);
      return (
        ts.isShorthandPropertyAssignment(property) ||
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property)
      );
    });
  if (ts.isCallExpression(node))
    return (
      !node.questionDotToken &&
      PURE_CALLS.has(calleeName(node.expression)) &&
      node.arguments.every(pureExpression)
    );
  if (ts.isNewExpression(node))
    return (
      PURE_CONSTRUCTORS.has(calleeName(node.expression)) &&
      (node.arguments ?? []).every(pureExpression)
    );
  return false;
}

/**
 * The first top-level statement whose evaluation a barrel importer could
 * observe, or null when the module only declares. A side-effect import
 * (`import './x'`, a stylesheet) counts: it runs another module for effect.
 */
export function topLevelSideEffect(path, source) {
  const file = parse(path, source, true);
  for (const statement of file.statements) {
    if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) continue;
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause) return statement;
      continue;
    }
    if (
      ts.isExportDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isEmptyStatement(statement) ||
      ts.isImportEqualsDeclaration(statement)
    )
      continue;
    if (ts.isClassDeclaration(statement)) {
      if (pureClassMembers(statement)) continue;
      return statement;
    }
    if (ts.isEnumDeclaration(statement)) {
      if (
        statement.members.every((member) => pureExpression(member.initializer))
      )
        continue;
      return statement;
    }
    if (ts.isModuleDeclaration(statement)) return statement;
    if (ts.isExportAssignment(statement)) {
      if (pureExpression(statement.expression)) continue;
      return statement;
    }
    if (ts.isVariableStatement(statement)) {
      const pure = statement.declarationList.declarations.every(
        (declaration) =>
          // Destructuring can run a getter on the source object.
          ts.isIdentifier(declaration.name) &&
          pureExpression(declaration.initializer),
      );
      if (pure) continue;
      return statement;
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isStringLiteral(statement.expression)
    )
      continue; // a directive such as 'use strict'
    return statement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Resolution.

function resolveCandidates(target, fileSet) {
  const extension = target.match(/\.([cm]?)jsx?$/);
  const candidates = extension
    ? [
        `${target.slice(0, -extension[0].length)}.${extension[1]}ts`,
        `${target.slice(0, -extension[0].length)}.tsx`,
        target,
      ]
    : RESOLUTION_SUFFIXES.map((suffix) => `${target}${suffix}`);
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

/**
 * The repository file one specifier names when it points into the SDK.
 * Returns null for a module outside the SDK, and UNKNOWN for an SDK
 * reference that cannot be resolved (a directory, an unexported subpath).
 */
function resolveSdkSpecifier(importer, specifier, context) {
  const { fileSet, sdkExports } = context;
  if (
    specifier === SDK_PACKAGE_NAME ||
    specifier.startsWith(`${SDK_PACKAGE_NAME}/`)
  ) {
    const subpath =
      specifier === SDK_PACKAGE_NAME
        ? '.'
        : `.${specifier.slice(SDK_PACKAGE_NAME.length)}`;
    const target = sdkExports[subpath];
    if (typeof target !== 'string') return UNKNOWN;
    const path = posix.normalize(posix.join('packages/sdk', target));
    return fileSet.has(path) ? path : UNKNOWN;
  }
  if (!specifier.startsWith('.')) return null;
  const target = posix.normalize(
    posix.join(posix.dirname(importer), specifier.split('?')[0]),
  );
  if (target !== 'packages/sdk' && !target.startsWith('packages/sdk/'))
    return null;
  const resolved = resolveCandidates(target, fileSet);
  if (resolved === null) return UNKNOWN;
  // Stylesheets and data files cannot import X; only code is a module here.
  return CODE_FILE.test(resolved) ? resolved : null;
}

/**
 * Build the SDK-facing import graph from a repository snapshot.
 *
 * @param {object} input
 * @param {Map<string,string>} input.sources repo-relative path -> text, for
 *   every file that may reference the SDK (the caller's prefilter).
 * @param {Iterable<string>} input.fileSet every repository path, for
 *   extension/index resolution.
 * @param {Record<string,string>} input.sdkExports the SDK package `exports`.
 */
export function buildSdkImportGraph({ sources, fileSet, sdkExports }) {
  const context = { fileSet: new Set(fileSet), sdkExports };
  const barrels = new Set(SDK_BARREL_PATHS.filter((path) => sources.has(path)));
  const exportCache = new Map();
  const exportsOf = (path) => {
    if (!exportCache.has(path)) {
      const source = sources.get(path);
      exportCache.set(
        path,
        source === undefined ? null : collectExports(path, source),
      );
    }
    return exportCache.get(path);
  };
  const resolveFrom = (importer, specifier) =>
    specifier === undefined
      ? null
      : resolveSdkSpecifier(importer, specifier, context);

  /**
   * The modules that provide `name` as exported by `module`, following
   * re-exports (`export { a } from`, a re-exported import, `export *`) to the
   * module that declares it. Returns an array of paths (empty when the name
   * comes from outside the SDK), NOT_FOUND, or — when a star re-export makes
   * the answer ambiguous or unknowable — `[module]`: depending on the whole
   * module at the level where resolution stopped being certain is always
   * sound, because that module's graph contains every candidate.
   */
  const resolveName = (module, name, seen) => {
    if (seen.has(module)) return NOT_FOUND;
    const path = new Set(seen).add(module);
    const table = exportsOf(module);
    if (!table || table.local.has(name)) return [module];
    const entry = table.named.get(name);
    if (entry) {
      const target = resolveFrom(module, entry.specifier);
      if (target === null) return []; // provided by a module outside the SDK
      if (target === UNKNOWN) return [module];
      if (entry.name === null) return [target]; // a namespace re-export
      const nested = resolveName(target, entry.name, path);
      return nested === NOT_FOUND ? [target] : nested;
    }
    if (name === 'default') return NOT_FOUND;
    const found = [];
    let uncertain = false;
    for (const specifier of table.stars) {
      const target = resolveFrom(module, specifier);
      // An unresolvable or external star could also provide the name.
      if (target === null || target === UNKNOWN) {
        uncertain = true;
        continue;
      }
      const nested = resolveName(target, name, path);
      if (nested !== NOT_FOUND) found.push(nested);
    }
    if (found.length === 0 && !uncertain) return NOT_FOUND;
    if (found.length === 1 && !uncertain) return found[0];
    return [module];
  };

  /** A named import of `name` from `barrel`: the modules it depends on. */
  const nameCache = new Map();
  const resolveBarrelName = (barrel, name) => {
    const key = `${barrel}\0${name}`;
    if (!nameCache.has(key)) {
      const resolved = resolveName(barrel, name, new Set());
      // A name no module provides is a load error; keep the whole barrel.
      nameCache.set(key, resolved === NOT_FOUND ? [barrel] : resolved);
    }
    return nameCache.get(key);
  };

  // edges: path -> [{ target, names }] ; opaque: files depending on all SDK.
  const edges = new Map();
  const opaque = new Set();
  for (const [path, source] of sources) {
    let collected;
    try {
      collected = collectModuleReferences(path, source);
    } catch {
      opaque.add(path);
      continue;
    }
    const fileEdges = [];
    for (const reference of collected.references) {
      const target = resolveFrom(path, reference.specifier);
      if (target === null) continue;
      if (target === UNKNOWN) {
        opaque.add(path);
        continue;
      }
      fileEdges.push({ target, names: reference.names });
    }
    // A computed import or glob inside the SDK, or in a file that also
    // references it, could name any SDK module.
    if (collected.opaque && (isSdkPath(path) || fileEdges.length))
      opaque.add(path);
    edges.set(path, fileEdges);
  }
  return {
    sources,
    barrels,
    edges,
    opaque,
    resolveBarrelName,
  };
}

/**
 * Which modules one edge makes its importer depend on. A barrel edge with
 * named imports resolves each name; everything else is the target itself.
 * `extraNames` maps a module to names it exported at the base.
 */
function edgeTargets(graph, edge, extraNames) {
  if (!graph.barrels.has(edge.target) || edge.names === null)
    return [edge.target];
  const targets = new Set();
  for (const name of edge.names) {
    for (const [module, names] of extraNames)
      if (names.has(name)) targets.add(module);
    for (const module of graph.resolveBarrelName(edge.target, name))
      targets.add(module);
  }
  return [...targets];
}

/**
 * The seeds whose `vitest related` audience is the audience of `changed`.
 *
 * @returns {{ seeds: string[], reached: string[] }} `reached` lists the SDK
 *   source modules (and barrels) that depend on `changed`, for diagnostics.
 */
export function refinedSeedsFor(graph, changed, { baseExportNames } = {}) {
  const extraNames = new Map();
  if (baseExportNames?.size) extraNames.set(changed, baseExportNames);
  const reverse = new Map();
  const dependents = (target) => {
    if (!reverse.has(target)) reverse.set(target, []);
    return reverse.get(target);
  };
  for (const [path, fileEdges] of graph.edges)
    for (const edge of fileEdges)
      for (const target of edgeTargets(graph, edge, extraNames))
        dependents(target).push(path);
  const reached = new Set([changed]);
  const queue = [changed];
  const visit = (path) => {
    if (reached.has(path)) return;
    reached.add(path);
    queue.push(path);
  };
  for (const path of graph.opaque) visit(path);
  while (queue.length) {
    const path = queue.pop();
    for (const importer of reverse.get(path) ?? []) visit(importer);
  }
  // SDK source and barrels are never seeds: a barrel re-exports them, so
  // their vitest audience is every barrel importer again. Their importers
  // outside SDK source were reached above, and those are the seeds.
  const seeds = [...reached].filter(
    (path) => !isSdkSourceModule(path) && !graph.barrels.has(path),
  );
  return {
    seeds: seeds.sort(),
    reached: [...reached].filter((path) => isSdkSourceModule(path)).sort(),
  };
}

// ---------------------------------------------------------------------------
// Repository wiring.

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

const CODE_PATHSPECS = [
  '*.ts',
  '*.tsx',
  '*.mts',
  '*.cts',
  '*.js',
  '*.jsx',
  '*.mjs',
  '*.cjs',
];
// The same test as SDK_REFERENCE, for git grep's ERE.
const SDK_REFERENCE_ERE = 'station-sdk|/sdk[\'"`/]';

function splitPaths(output) {
  return output.split('\0').filter(Boolean);
}

/**
 * The files this graph needs, without reading the whole repository:
 * every SDK file (for resolution), the tracked and untracked code files that
 * mention the SDK (git grep reads the working tree), and ignored FILES
 * outside ignored directories (generated sources), which git grep skips.
 * Ignored directories — node_modules, build output — are never read.
 */
function listSdkReferencingFiles(root) {
  const sdkFiles = splitPaths(
    git(root, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'packages/sdk',
    ]),
  );
  let referencing;
  try {
    referencing = splitPaths(
      git(root, [
        'grep',
        '-l',
        '-z',
        '--untracked',
        '-E',
        SDK_REFERENCE_ERE,
        '--',
        ...CODE_PATHSPECS,
      ]),
    );
  } catch (error) {
    // git grep exits 1 for "no match"; anything else is a real failure.
    if (error?.status !== 1) throw error;
    referencing = [];
  }
  const ignored = splitPaths(
    git(root, [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ]),
  ).filter((path) => !path.endsWith('/'));
  return { sdkFiles, referencing, ignored };
}

/** The file at `base`, or null when it did not exist there. Throws if git cannot say. */
function readAtBase(root, base, path) {
  if (git(root, ['ls-tree', '--name-only', base, '--', path]).trim() === '')
    return null;
  return git(root, ['show', `${base}:${path}`]);
}

export function loadSdkImportGraph(root, { readFile = readFileSync } = {}) {
  const { sdkFiles, referencing, ignored } = listSdkReferencingFiles(root);
  const sources = new Map();
  const read = (path) => {
    if (!CODE_FILE.test(path) || DECLARATION_FILE.test(path)) return null;
    if (path.split('/').includes('node_modules')) return null;
    try {
      return readFile(join(root, path), 'utf8');
    } catch {
      return null; // deleted in the working tree
    }
  };
  for (const path of [...sdkFiles, ...referencing]) {
    const source = read(path);
    if (source !== null) sources.set(path, source);
  }
  for (const path of ignored) {
    const source = read(path);
    if (source !== null && SDK_REFERENCE.test(source))
      sources.set(path, source);
  }
  const sdkPackage = JSON.parse(
    readFile(join(root, 'packages/sdk/package.json'), 'utf8'),
  );
  return buildSdkImportGraph({
    sources,
    fileSet: sdkFiles,
    sdkExports: sdkPackage.exports ?? {},
  });
}

/**
 * Replace each refinable changed SDK module in `relatedPaths` with its seeds.
 *
 * A path is refined only when it is SDK source (not a barrel) whose top-level
 * evaluation is side-effect free at `base` and in the working tree. Every
 * other path passes through unchanged. Without a `base`, nothing is refined.
 *
 * @param {string} root
 * @param {string[]} relatedPaths
 * @param {object} [options]
 * @param {string} [options.base] the merge base the diff was taken from
 * @param {(root: string) => ReturnType<typeof buildSdkImportGraph>} [options.loadGraph]
 * @param {(root: string, base: string, path: string) => string | null} [options.readBase]
 * @returns {{ paths: string[], decisions: Array<{ path: string, disposition: 'refined' | 'whole-barrel', seeds?: number, reason?: string }> }}
 */
export function refineSdkBarrelRelatedPaths(
  root,
  relatedPaths,
  { base, loadGraph = loadSdkImportGraph, readBase = readAtBase } = {},
) {
  const candidates = relatedPaths.filter(
    (path) => isSdkSourceModule(path) && !SDK_BARREL_PATHS.includes(path),
  );
  if (!base || candidates.length === 0)
    return { paths: [...relatedPaths], decisions: [] };
  const decisions = [];
  const paths = new Set(
    relatedPaths.filter((path) => !candidates.includes(path)),
  );
  let graph;
  try {
    graph = loadGraph(root);
  } catch (error) {
    // Refinement only narrows; without its graph the paths keep plain
    // related selection, and the decision says why.
    const reason = `import graph unavailable: ${error instanceof Error ? error.message : String(error)}`;
    for (const path of candidates) {
      paths.add(path);
      decisions.push({ path, disposition: 'whole-barrel', reason });
    }
    return { paths: [...paths].sort(), decisions };
  }
  for (const path of candidates) {
    const head = graph.sources.get(path);
    let baseSource;
    let reason = null;
    try {
      baseSource = readBase(root, base, path);
    } catch (error) {
      reason = `base content unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (reason === null && head === undefined) reason = 'not readable';
    if (reason === null) {
      for (const [label, source] of [
        ['head', head],
        ['base', baseSource],
      ]) {
        if (source === null || source === undefined) continue;
        const effect = topLevelSideEffect(path, source);
        if (effect) {
          const line =
            effect
              .getSourceFile()
              .getLineAndCharacterOfPosition(effect.getStart()).line + 1;
          reason = `top-level side effect at ${label} line ${line}`;
          break;
        }
      }
    }
    if (reason !== null) {
      paths.add(path);
      decisions.push({ path, disposition: 'whole-barrel', reason });
      continue;
    }
    const baseExportNames = new Set();
    if (baseSource) {
      const table = collectExports(path, baseSource);
      for (const name of [...table.local, ...table.named.keys()])
        baseExportNames.add(name);
    }
    const { seeds } = refinedSeedsFor(graph, path, { baseExportNames });
    for (const seed of seeds) paths.add(seed);
    decisions.push({ path, disposition: 'refined', seeds: seeds.length });
  }
  return { paths: [...paths].sort(), decisions };
}
