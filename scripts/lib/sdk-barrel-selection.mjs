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
import ts from 'typescript-api';

const SDK_SOURCE_PREFIX = 'packages/sdk/src/';
const SDK_PACKAGE_NAME = '@kontourai/station-sdk';
const SDK_PACKAGE_JSON = 'packages/sdk/package.json';
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
const CALL_REFERENCE = /\bimport\s*\(|\brequire\s*\(|\bvi\b|\.glob\b/;

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
  // `dynamic`: loaded only when the code runs (import(), require, a mock),
  // not when the module itself is evaluated.
  const add = (specifier, names, dynamic = false) =>
    references.push({ specifier, names, dynamic });
  // Mock detection keys on the literal `vi.<method>(...)`. A file that
  // aliases vi, imports vitest as a namespace or default, or uses `vi` any
  // other way (`vi['importActual']`, passing it to a helper) can mock or
  // reach a module this scan cannot see, so it depends on the whole SDK.
  let viEscapes = false;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (specifier === 'vitest' && clause && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (clause.name || (bindings && ts.isNamespaceImport(bindings)))
          viEscapes = true;
        else if (bindings)
          for (const element of bindings.elements)
            if (
              element.name.text === 'vi'
                ? element.propertyName !== undefined
                : element.propertyName?.text === 'vi'
            )
              viEscapes = true;
      }
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
    // Import declarations were read above; their `vi` binding is not a use.
    // Types (`typeof vi.fn`) are erased and never run.
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'vi'
    )
      return; // `vi.<method>`: the one form mock detection understands
    if (ts.isIdentifier(node) && node.text === 'vi') viEscapes = true;
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
          else add(specifier, null, true);
        }
        // A computed specifier can name any module; vitest cannot follow it
        // either, but this module does not guess.
        else if (dynamicImport || requireCall) opaque = true;
      } else if (isImportMetaGlob(node)) opaque = true;
    }
    ts.forEachChild(node, visit);
  };
  if (CALL_REFERENCE.test(source)) visit(file);
  if (viEscapes) opaque = true;
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
      // `arguments` can carry importOriginal without a named parameter.
      [...referencedIdentifiers(factory)].some(
        (name) => name === 'arguments' || tainted.has(name),
      )
    )
      add(specifier, null, true);
  return { references, opaque, viEscapes };
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

// Binary operators that neither coerce nor run an operand's code.
const NON_COERCING_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.CommaToken,
]);

function calleeName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
    return `${node.expression.text}.${node.name.text}`;
  return null;
}

function pureClassMembers(node, imported) {
  if (ts.getDecorators?.(node)?.length) return false;
  for (const clause of node.heritageClauses ?? [])
    for (const type of clause.types)
      if (!pureExpression(type.expression, imported)) return false;
  for (const member of node.members) {
    if (ts.isClassStaticBlockDeclaration(member)) return false;
    if (ts.getDecorators?.(member)?.length) return false;
    if (
      member.name &&
      ts.isComputedPropertyName(member.name) &&
      // A computed key is converted to a property key (ToPropertyKey).
      (mentionsImported(member.name.expression, imported) ||
        !pureExpression(member.name.expression, imported))
    )
      return false;
    if (
      ts.isPropertyDeclaration(member) &&
      hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
      member.initializer &&
      !pureExpression(member.initializer, imported)
    )
      return false;
  }
  return true;
}

/**
 * Whether an imported value (or a local alias of one) appears ANYWHERE in
 * `node`. Used where the engine coerces the whole operand (ToPrimitive,
 * ToNumber, ToString) or converts it to a property key (ToPropertyKey): a
 * nested `[items]`, `cond ? items : 0` or `{ a: items }` still reaches the
 * imported value's toString/valueOf. Over-approximates on purpose — a
 * mention inside a function literal counts too.
 */
function mentionsImported(node, imported) {
  for (const name of referencedIdentifiers(node))
    if (imported.has(name)) return true;
  return false;
}

/** The identifier an access chain starts from (`a` in `a.b[c]!`), if any. */
function rootIdentifier(node) {
  let current = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    )
      current = current.expression;
    else return null;
  }
}

/**
 * Whether evaluating `node` touches an imported value beyond reading its
 * binding: a property access (a getter), iteration, or handing it to an
 * allowlisted call (`Object.freeze(imported)` mutates another module).
 */
function readsImported(node, imported) {
  const root = rootIdentifier(node);
  return root !== null && imported.has(root);
}

/**
 * Evaluating `node` at module top level cannot be observed outside the
 * module: no call except a small allowlist of standard constructors and
 * freezers, no assignment, no tagged template. Property access, spread and
 * iteration, and allowlisted-call arguments count only when their operand is
 * a literal or a local value — an imported value could run a getter or an
 * iterator, or be mutated. Function and class bodies are not evaluated, so
 * they are not inspected.
 */
function pureExpression(node, imported = new Set()) {
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
  if (ts.isClassExpression(node)) return pureClassMembers(node, imported);
  // A template span coerces its value to a string: an imported object's
  // toString (or an array's contents) is read at that moment.
  if (ts.isTemplateExpression(node))
    return node.templateSpans.every(
      (span) =>
        !mentionsImported(span.expression, imported) &&
        pureExpression(span.expression, imported),
    );
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeOfExpression(node) ||
    ts.isVoidExpression(node)
  )
    return pureExpression(node.expression, imported);
  if (ts.isSpreadElement(node))
    return (
      !readsImported(node.expression, imported) &&
      pureExpression(node.expression, imported)
    );
  if (ts.isPrefixUnaryExpression(node))
    return (
      node.operator !== ts.SyntaxKind.PlusPlusToken &&
      node.operator !== ts.SyntaxKind.MinusMinusToken &&
      // `+x`, `-x`, `~x` coerce to a number (valueOf/toString); `!x` does not.
      (node.operator === ts.SyntaxKind.ExclamationToken ||
        !mentionsImported(node.operand, imported)) &&
      pureExpression(node.operand, imported)
    );
  if (ts.isBinaryExpression(node))
    return (
      !IMPURE_OPERATORS.has(node.operatorToken.kind) &&
      // Every other operator can coerce an operand (arithmetic, `+`,
      // relational, loose equality, bitwise, `in`'s key) or run its code
      // (`instanceof`'s Symbol.hasInstance, `in`'s proxy trap).
      (NON_COERCING_OPERATORS.has(node.operatorToken.kind) ||
        (!mentionsImported(node.left, imported) &&
          !mentionsImported(node.right, imported))) &&
      pureExpression(node.left, imported) &&
      pureExpression(node.right, imported)
    );
  if (ts.isConditionalExpression(node))
    return (
      pureExpression(node.condition, imported) &&
      pureExpression(node.whenTrue, imported) &&
      pureExpression(node.whenFalse, imported)
    );
  if (ts.isPropertyAccessExpression(node))
    return (
      !readsImported(node.expression, imported) &&
      pureExpression(node.expression, imported)
    );
  if (ts.isElementAccessExpression(node))
    return (
      !readsImported(node.expression, imported) &&
      // The key is converted with ToPropertyKey.
      !mentionsImported(node.argumentExpression, imported) &&
      pureExpression(node.expression, imported) &&
      pureExpression(node.argumentExpression, imported)
    );
  if (ts.isArrayLiteralExpression(node))
    return node.elements.every(
      (element) =>
        ts.isOmittedExpression(element) || pureExpression(element, imported),
    );
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every((property) => {
      if (
        property.name &&
        ts.isComputedPropertyName(property.name) &&
        // A computed key is converted with ToPropertyKey.
        (mentionsImported(property.name.expression, imported) ||
          !pureExpression(property.name.expression, imported))
      )
        return false;
      if (ts.isPropertyAssignment(property))
        return pureExpression(property.initializer, imported);
      if (ts.isSpreadAssignment(property))
        return (
          !readsImported(property.expression, imported) &&
          pureExpression(property.expression, imported)
        );
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
      node.arguments.every(
        (argument) =>
          pureExpression(argument, imported) &&
          !readsImported(argument, imported),
      )
    );
  if (ts.isNewExpression(node))
    return (
      PURE_CONSTRUCTORS.has(calleeName(node.expression)) &&
      (node.arguments ?? []).every(
        (argument) =>
          pureExpression(argument, imported) &&
          !readsImported(argument, imported),
      )
    );
  return false;
}

/** Runtime (non-type) bindings a file imports, by local name. */
function importedBindings(file) {
  const names = new Set();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      names.add(bindings.name.text);
    else if (bindings)
      for (const element of bindings.elements)
        if (!element.isTypeOnly) names.add(element.name.text);
  }
  return names;
}

/**
 * Whether one top-level statement's evaluation could be observed outside
 * the module. `imported` grows with local aliases of imported values
 * (`const a = imported.b`), so a later `Object.freeze(a)` still counts.
 */
function statementHasSideEffect(statement, imported) {
  if (hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return false;
  if (ts.isImportDeclaration(statement)) return !statement.importClause;
  if (
    ts.isExportDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isFunctionDeclaration(statement) ||
    ts.isEmptyStatement(statement) ||
    ts.isImportEqualsDeclaration(statement)
  )
    return false;
  if (ts.isClassDeclaration(statement))
    return !pureClassMembers(statement, imported);
  if (ts.isEnumDeclaration(statement))
    return !statement.members.every((member) =>
      pureExpression(member.initializer, imported),
    );
  if (ts.isModuleDeclaration(statement)) return true;
  if (ts.isExportAssignment(statement))
    return !pureExpression(statement.expression, imported);
  if (ts.isVariableStatement(statement)) {
    const pure = statement.declarationList.declarations.every(
      (declaration) =>
        // Destructuring can run a getter on the source object.
        ts.isIdentifier(declaration.name) &&
        pureExpression(declaration.initializer, imported),
    );
    for (const declaration of statement.declarationList.declarations)
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        // An alias (`const a = imported`) or a container holding an imported
        // value (`const l = [imported]`): touching it can touch the import.
        [...referencedIdentifiers(declaration.initializer)].some((name) =>
          imported.has(name),
        )
      )
        imported.add(declaration.name.text);
    return !pure;
  }
  // A directive such as 'use strict'.
  return !(
    ts.isExpressionStatement(statement) &&
    ts.isStringLiteral(statement.expression)
  );
}

/**
 * The first top-level statement whose evaluation a barrel importer could
 * observe, or null when the module only declares. A side-effect import
 * (`import './x'`, a stylesheet) counts: it runs another module for effect.
 */
export function topLevelSideEffect(path, source) {
  const file = parse(path, source, true);
  const imported = importedBindings(file);
  for (const statement of file.statements)
    if (statementHasSideEffect(statement, imported)) return statement;
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

  /**
   * A named import of `name` from `barrel` — or from any SDK module: the
   * resolution is the same — and the modules it depends on.
   */
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

  /**
   * What evaluating one SDK module loads: its static SDK targets, and
   * whether it also loads a module outside the SDK (whose evaluation this
   * graph cannot read) or one it cannot resolve.
   */
  const staticLoads = (path, collected) => {
    const result = { targets: new Set(), external: false, unresolved: false };
    for (const reference of collected.references) {
      if (reference.dynamic) continue;
      const target = resolveFrom(path, reference.specifier);
      if (target === null) result.external = true;
      else if (target === UNKNOWN) result.unresolved = true;
      else result.targets.add(target);
    }
    if (collected.opaque) result.unresolved = true;
    return result;
  };
  const loads = new Map();

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
    if (isSdkPath(path)) loads.set(path, staticLoads(path, collected));
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
    // references it, could name any SDK module. A `vi` this scan cannot
    // follow can mock or load the SDK with no static SDK import at all
    // (`vi['importActual']('@kontourai/station-sdk')`), and every file here
    // already mentions the SDK, so it is opaque on its own.
    if (
      collected.viEscapes ||
      (collected.opaque && (isSdkPath(path) || fileEdges.length))
    )
      opaque.add(path);
    edges.set(path, fileEdges);
  }
  return {
    sources,
    barrels,
    edges,
    opaque,
    resolveBarrelName,
    resolveSpecifier: resolveFrom,
    exportsOf,
    loads,
    staticLoads,
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
// The reverse import index does not depend on the changed module, so it is
// built once per graph and shared by every candidate in a refinement call.
const reverseIndexes = new WeakMap();
function reverseIndex(graph) {
  if (!reverseIndexes.has(graph)) {
    const reverse = new Map();
    const barrelNamedEdges = [];
    for (const [path, fileEdges] of graph.edges)
      for (const edge of fileEdges) {
        for (const target of edgeTargets(graph, edge, new Map())) {
          if (!reverse.has(target)) reverse.set(target, []);
          reverse.get(target).push(path);
        }
        if (graph.barrels.has(edge.target) && edge.names !== null)
          barrelNamedEdges.push({ path, names: edge.names });
      }
    reverseIndexes.set(graph, { reverse, barrelNamedEdges });
  }
  return reverseIndexes.get(graph);
}

export function refinedSeedsFor(graph, changed, { baseExportNames } = {}) {
  const { reverse, barrelNamedEdges } = reverseIndex(graph);
  // Importers of a name `changed` exported at the base depend on it too.
  const extraImporters = baseExportNames?.size
    ? barrelNamedEdges
        .filter(({ names }) => names.some((name) => baseExportNames.has(name)))
        .map(({ path }) => path)
    : [];
  const importersOf = (path) =>
    path === changed
      ? [...(reverse.get(path) ?? []), ...extraImporters]
      : (reverse.get(path) ?? []);
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
    for (const importer of importersOf(path)) visit(importer);
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
/**
 * Every path's content at `base` in two git processes, not two per path:
 * `rev-parse --verify` proves the base exists (so "missing" below means the
 * path is absent there, not that git could not look), then one
 * `cat-file --batch` reads every blob. Absent paths map to null.
 */
function readAllAtBase(root, base, paths) {
  execFileSync(
    'git',
    ['rev-parse', '--verify', '--quiet', `${base}^{commit}`],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root,
    input: paths.map((path) => `${base}:${path}\n`).join(''),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const contents = new Map();
  let offset = 0;
  for (const path of paths) {
    const newline = output.indexOf(0x0a, offset);
    if (newline < 0)
      throw new Error(`git cat-file output ended before ${path}`);
    const header = output.subarray(offset, newline).toString('utf8');
    offset = newline + 1;
    if (header.endsWith(' missing')) {
      contents.set(path, null);
      continue;
    }
    const match = header.match(/^[0-9a-f]+ (\w+) (\d+)$/);
    if (match?.[1] !== 'blob')
      throw new Error(`unexpected git cat-file header for ${path}: ${header}`);
    const size = Number(match[2]);
    contents.set(path, output.subarray(offset, offset + size).toString('utf8'));
    offset += size + 1; // the blob and its trailing newline
  }
  return contents;
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
 * Why a changed module's import changes can alter what a barrel load
 * evaluates, or null when they cannot (#2782).
 *
 * An added or removed import only moves an edge between modules a barrel
 * load evaluates anyway, and the move cannot be observed, when:
 * - an added target was already barrel-reachable at the base, and a removed
 *   target is still barrel-reachable at the head (static imports only: a
 *   dynamic import() is not evaluated with the module), so the set of
 *   evaluated modules is unchanged;
 * - every module the target loads, transitively, is readable SDK source
 *   with no top-level side effect and no load of a module outside the SDK,
 *   so evaluating that closure earlier or later reorders no effect;
 * - that closure contains neither the changed module nor any module that
 *   loads it, so the reorder cannot reach a module that is mid-evaluation
 *   (no import cycle, hence no read of an uninitialised binding).
 * Anything unresolvable, unreadable or outside the SDK keeps the old answer.
 */
function importChangeBlocker(context, path, baseSource, head) {
  const { graph } = context;
  const targetsOf = (source) => {
    const collected = collectModuleReferences(path, source);
    const targets = new Set();
    for (const reference of collected.references) {
      const target = graph.resolveSpecifier(path, reference.specifier);
      if (target === null) targets.add(`external:${reference.specifier}`);
      else targets.add(target);
    }
    return { targets, opaque: collected.opaque };
  };
  const before = targetsOf(baseSource);
  const after = targetsOf(head);
  if (before.opaque !== after.opaque) return 'a computed import changed';
  const added = [...after.targets].filter((t) => !before.targets.has(t));
  const removed = [...before.targets].filter((t) => !after.targets.has(t));
  for (const target of [...added, ...removed]) {
    if (target === UNKNOWN) return 'an import does not resolve';
    if (target.startsWith('external:'))
      return `${target.slice('external:'.length)} is outside the SDK`;
  }
  if (added.length && context.baseUnknown)
    return `base reachability is unknown (${context.baseUnknown})`;
  for (const target of added)
    if (!context.baseReachable().has(target))
      return `added import ${target} is not barrel-reachable at the base`;
  for (const target of removed)
    if (!context.headReachable().has(target))
      return `removed import ${target} is no longer barrel-reachable`;
  const loaders = context.loadersOf(path);
  for (const target of [...added, ...removed])
    for (const module of context.closureOf(target)) {
      const loads = graph.loads.get(module);
      if (!loads || !graph.sources.has(module))
        return `${module}, loaded by ${target}, is unreadable`;
      if (loaders.has(module))
        return `${target} loads ${module}, which loads ${path} (a cycle)`;
      if (loads.unresolved)
        return `${module}, loaded by ${target}, has an unresolvable import`;
      if (loads.external)
        return `${module}, loaded by ${target}, loads a module outside the SDK`;
      if (topLevelSideEffect(module, graph.sources.get(module)))
        return `${module}, loaded by ${target}, has a top-level side effect`;
    }
  // Moving a pure, readable closure earlier or later is still observable
  // when what it reads at load can differ with the order (#2782 review):
  // entering an import cycle at a different module, or snapshotting a
  // binding its declaring module can reassign while other modules load.
  for (const target of [...added, ...removed])
    for (const module of context.closureOf(target)) {
      const cycle = context.cycleOf(module);
      if (cycle)
        return `import cycle: ${module}, loaded by ${target}, is in a cycle with ${cycle.filter((m) => m !== module).join(', ')}`;
      const live = context.liveBindingRead(module);
      if (live)
        return `live binding: ${module}, loaded by ${target}, reads ${live.name}, which ${live.declarer} declares reassignable`;
    }
  return null;
}

/**
 * Lazily computed reachability shared by every candidate of one refinement.
 * `baseSources` maps each changed SDK file to its base content (null when
 * absent there); null for the whole map means the changed set is unknown.
 */
function importChangeContext(graph, baseSources, baseUnknown = null) {
  const closure = (starts, next) => {
    const seen = new Set();
    const queue = [...starts];
    while (queue.length) {
      const module = queue.pop();
      if (seen.has(module)) continue;
      seen.add(module);
      for (const target of next(module)) queue.push(target);
    }
    return seen;
  };
  const headTargets = (module) => graph.loads.get(module)?.targets ?? [];
  let base;
  let headReach;
  const closures = new Map();
  const loaders = new Map();
  // Strongly connected components of the static load graph (Tarjan),
  // computed once: module -> its component when larger than one module.
  let components;
  const componentOf = () => {
    if (components) return components;
    components = new Map();
    const index = new Map();
    const low = new Map();
    const stack = [];
    const onStack = new Set();
    let counter = 0;
    const connect = (module) => {
      index.set(module, counter);
      low.set(module, counter);
      counter += 1;
      stack.push(module);
      onStack.add(module);
      for (const target of headTargets(module)) {
        if (!index.has(target)) {
          connect(target);
          low.set(module, Math.min(low.get(module), low.get(target)));
        } else if (onStack.has(target))
          low.set(module, Math.min(low.get(module), index.get(target)));
      }
      if (low.get(module) === index.get(module)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== module);
        if (component.length > 1)
          for (const entry of component) components.set(entry, component);
      }
    };
    for (const module of graph.loads.keys())
      if (!index.has(module)) connect(module);
    return components;
  };

  // Exported names a module can reassign after it loads: `let`/`var`
  // bindings, and any local (a function or class too) that the module
  // assigns anywhere, exported directly or through `export { a as b }`.
  const reassignable = new Map();
  const reassignableExports = (module) => {
    if (reassignable.has(module)) return reassignable.get(module);
    const source = graph.sources.get(module);
    let names = null; // null: unreadable, so any name may be
    if (source !== undefined) {
      const file = parse(module, source);
      const mutable = new Set();
      // Every identifier an assignment target names: a plain name, or the
      // names inside a destructuring pattern (`[a, { b }] = ...`).
      const targetNames = (target) => {
        if (ts.isIdentifier(target)) mutable.add(target.text);
        else if (ts.isArrayLiteralExpression(target))
          for (const element of target.elements)
            targetNames(
              ts.isSpreadElement(element) ? element.expression : element,
            );
        else if (ts.isObjectLiteralExpression(target))
          for (const property of target.properties) {
            if (ts.isShorthandPropertyAssignment(property))
              mutable.add(property.name.text);
            else if (ts.isPropertyAssignment(property))
              targetNames(property.initializer);
            else if (ts.isSpreadAssignment(property))
              targetNames(property.expression);
          }
        else if (
          ts.isBinaryExpression(target) &&
          target.operatorToken.kind === ts.SyntaxKind.EqualsToken
        )
          targetNames(target.left); // a default: `[a = 1] = ...`
        else if (ts.isParenthesizedExpression(target))
          targetNames(target.expression);
      };
      const assigned = (node) => {
        if (
          ts.isBinaryExpression(node) &&
          IMPURE_OPERATORS.has(node.operatorToken.kind)
        )
          targetNames(node.left);
        if (
          (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
          !ts.isVariableDeclarationList(node.initializer)
        )
          targetNames(node.initializer);
        if (
          (ts.isPrefixUnaryExpression(node) ||
            ts.isPostfixUnaryExpression(node)) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken ||
            node.operator === ts.SyntaxKind.MinusMinusToken) &&
          ts.isIdentifier(node.operand)
        )
          mutable.add(node.operand.text);
        ts.forEachChild(node, assigned);
      };
      assigned(file);
      for (const statement of file.statements)
        if (
          ts.isVariableStatement(statement) &&
          !(statement.declarationList.flags & ts.NodeFlags.Const)
        )
          for (const declaration of statement.declarationList.declarations)
            for (const name of bindingNames(declaration.name, []))
              mutable.add(name);
      names = new Set();
      for (const statement of file.statements) {
        if (
          ts.isExportDeclaration(statement) &&
          !statement.moduleSpecifier &&
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause)
        )
          for (const element of statement.exportClause.elements) {
            if (mutable.has((element.propertyName ?? element.name).text))
              names.add(element.name.text);
          }
        else if (
          hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
          !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
        ) {
          const declared = ts.isVariableStatement(statement)
            ? statement.declarationList.declarations.flatMap((declaration) =>
                bindingNames(declaration.name, []),
              )
            : statement.name && ts.isIdentifier(statement.name)
              ? [statement.name.text]
              : [];
          for (const name of declared) if (mutable.has(name)) names.add(name);
        }
      }
    }
    reassignable.set(module, names);
    return names;
  };
  // The module that declares `name` as exported by `module`, when that
  // binding is reassignable; follows re-export chains and stars. Unknown
  // (unreadable, unresolvable) counts as reassignable.
  const reassignableDeclarer = (module, name, seen = new Set()) => {
    const key = `${module}\0${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const table = graph.exportsOf(module);
    const own = reassignableExports(module);
    if (!table || own === null) return module;
    if (own.has(name)) return module;
    if (table.local.has(name)) return null;
    const entry = table.named.get(name);
    if (entry) {
      if (entry.name === null) return null; // a namespace object is not a binding read
      const target = graph.resolveSpecifier(module, entry.specifier);
      if (target === null) return null; // outside the SDK: blocked elsewhere
      if (target === UNKNOWN) return module;
      return reassignableDeclarer(target, entry.name, seen);
    }
    if (name === 'default') return null;
    for (const specifier of table.stars) {
      const target = graph.resolveSpecifier(module, specifier);
      if (target === null) continue;
      if (target === UNKNOWN) return module;
      const found = reassignableDeclarer(target, name, seen);
      if (found) return found;
    }
    return null;
  };
  const liveReads = new Map();

  return {
    graph,
    baseUnknown,
    cycleOf(module) {
      return componentOf().get(module) ?? null;
    },
    /**
     * The first imported binding `module` reads by bare identifier (anywhere
     * in the module: an over-approximation of what it reads at load) that
     * its declaring module can reassign, or null.
     */
    liveBindingRead(module) {
      if (liveReads.has(module)) return liveReads.get(module);
      let found = null;
      const source = graph.sources.get(module);
      if (source !== undefined) {
        const file = parse(module, source);
        const imports = new Map();
        for (const statement of file.statements) {
          if (!ts.isImportDeclaration(statement)) continue;
          const clause = statement.importClause;
          if (!clause || clause.isTypeOnly) continue;
          const target = graph.resolveSpecifier(
            module,
            statement.moduleSpecifier.text,
          );
          if (target === null) continue;
          if (clause.name) imports.set(clause.name.text, [target, 'default']);
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamedImports(bindings))
            for (const element of bindings.elements)
              if (!element.isTypeOnly)
                imports.set(element.name.text, [
                  target,
                  (element.propertyName ?? element.name).text,
                ]);
        }
        const read = new Set();
        for (const statement of file.statements)
          if (!ts.isImportDeclaration(statement))
            referencedIdentifiers(statement, read);
        for (const identifier of read) {
          const source = imports.get(identifier);
          if (!source) continue;
          const [target, name] = source;
          const declarer =
            target === UNKNOWN ? module : reassignableDeclarer(target, name);
          if (declarer) {
            found = { name: identifier, declarer };
            break;
          }
        }
      }
      liveReads.set(module, found);
      return found;
    },
    baseReachable() {
      if (base === undefined) {
        if (baseSources === null)
          base = new Set(); // see baseUnknown
        else {
          const absent = new Set(
            [...baseSources]
              .filter(([, source]) => source === null)
              .map(([p]) => p),
          );
          // A file absent at the base is never a target there, so it is
          // never reached and its own edges never read.
          const baseTargets = (module) => {
            const source = baseSources.get(module);
            const targets =
              source === undefined
                ? headTargets(module)
                : graph.staticLoads(
                    module,
                    collectModuleReferences(module, source),
                  ).targets;
            return [...targets].filter((target) => !absent.has(target));
          };
          base = closure(
            [...graph.barrels].filter((barrel) => !absent.has(barrel)),
            baseTargets,
          );
        }
      }
      return base;
    },
    headReachable() {
      headReach ??= closure(graph.barrels, headTargets);
      return headReach;
    },
    closureOf(target) {
      if (!closures.has(target))
        closures.set(target, closure([target], headTargets));
      return closures.get(target);
    },
    loadersOf(path) {
      if (!loaders.has(path)) {
        const reverse = new Map();
        for (const [module, { targets }] of graph.loads)
          for (const target of targets) {
            if (!reverse.has(target)) reverse.set(target, []);
            reverse.get(target).push(module);
          }
        loaders.set(
          path,
          closure([path], (module) => reverse.get(module) ?? []),
        );
      }
      return loaders.get(path);
    },
  };
}

/**
 * Every SDK source file that differs from `base` in the working tree:
 * tracked changes (committed, staged or not) and untracked files.
 */
function changedSdkFiles(root, base) {
  const split = (output) => output.split('\0').filter(Boolean);
  return [
    ...new Set([
      ...split(
        git(root, [
          'diff',
          '--name-only',
          '-z',
          base,
          '--',
          SDK_SOURCE_PREFIX,
          SDK_PACKAGE_JSON,
        ]),
      ),
      ...split(
        git(root, [
          'ls-files',
          '-z',
          '--others',
          '--exclude-standard',
          '--',
          SDK_SOURCE_PREFIX,
        ]),
      ),
    ]),
  ].filter((path) => CODE_FILE.test(path) || path === SDK_PACKAGE_JSON);
}

/** Runtime module specifiers a module loads, as a comparable key. */
function runtimeImportKey(path, source) {
  const { references, opaque } = collectModuleReferences(path, source);
  const specifiers = [...new Set(references.map((entry) => entry.specifier))];
  return JSON.stringify([...specifiers.sort(), opaque]);
}

/**
 * Top-level uses (#2707). A module that a barrel evaluates, whose top-level
 * side effect reads a binding whose value can come from the changed module
 * (`registry.push(f())` with `f` from it), makes the change observable to
 * every barrel importer without importing any of its names.
 *
 * Only barrel-reachable modules are considered: a module reached only
 * through its own subpath is evaluated only by its importers, and those
 * already reach the changed module through the import graph.
 *
 * A binding's ORIGINS are every module its value can come from: each
 * module on its re-export chain, plus, for a local export, the origins of
 * the imported bindings its declaration reads when it is used. How a value
 * is used decides what that is (#2766):
 * - READ (only the value): a `const`/`let`/`var` or `export default <expr>`
 *   contributes what its initializer reads at load; a class, its decorators,
 *   heritage, computed keys and static members; a function, nothing.
 * - RUN (called or constructed) or MEMBER (a property read, which can run a
 *   getter or a method called next): a function or class contributes
 *   everything its code names; an object or array literal used as MEMBER,
 *   every member it holds.
 * - ALL (RUN and MEMBER): anything handed to a call, at any depth inside
 *   array and object literals, and every operand used implicitly through
 *   its members: destructured, iterated (for-of, for-in, spread), awaited,
 *   coerced (template spans, operators other than `===`/`!==`/`&&`/`||`/
 *   `??`/comma, including `in` and `instanceof`).
 * Positions are read exactly only in code evaluated directly at load (an
 * initializer, the use-site statement). Code that runs is read whole: every
 * binding it names is ALL, so returned and aliased values are followed. A
 * function in a non-invoked position of an initializer (an object property
 * value, an array element, a class method) is not read until that value is
 * itself used as RUN, MEMBER or ALL. Each imported binding is then resolved
 * in the mode it is used, into its own module, and so on.
 *
 * At a USE site (the side-effect statement itself) every binding the
 * statement names, through local bindings too, is an origin; the modes above
 * decide how far each is followed.
 *
 * Resolution fails CLOSED: a star it cannot enumerate, a module it cannot
 * read, or an export whose declaration it cannot find is ANY origin; a chain
 * of more than MAX_RUN_DEPTH modules each running the next is cut and counts
 * as a use of every module. An import cycle is neither provided nor cached;
 * the frame that first entered it explores the sibling branches.
 *
 * Known gaps, not traced:
 * - code a module runs at its own load through a LOCAL class or function
 *   that `topLevelSideEffect` treats as pure (`export const v = L.x` with a
 *   static getter on a local `L`) is a use only when some barrel-loaded
 *   statement consumes the export; with no consumer it is missed, because
 *   local declarations do not join the alias set `pureExpression` checks;
 * - a top-level dynamic `import()`: the module it loads, and what the use
 *   then calls on it, are not followed;
 * - a value assigned into a property, element or mutable binding and later
 *   called or hitting a setter (`reg.x = h`, `let x; x = h; x()`), property-
 *   key coercion (`registry[k]`, computed names), and `using`'s dispose.
 *
 * The analysis does not depend on the changed module, so it runs once per
 * graph and is shared by every candidate.
 */
const topLevelUseAnalyses = new WeakMap();

function barrelReachable(graph) {
  const reached = new Set();
  const queue = [...graph.barrels];
  while (queue.length) {
    const path = queue.pop();
    if (reached.has(path)) continue;
    reached.add(path);
    for (const edge of graph.edges.get(path) ?? []) queue.push(edge.target);
  }
  return reached;
}

// How a load-time read uses a binding's value (#2766). Flags combine.
// READ: the value is only read. RUN: it is called or constructed. MEMBER: a
// property of it is read, which can run a getter, or a method called next.
// ALL: both; anything handed to a call, or used implicitly through its
// members (iterated, destructured, awaited, coerced).
const READ = 0;
const RUN = 1;
const MEMBER = 2;
const ALL = RUN | MEMBER;
// Cross-module hops a traced invocation may take (a binding run from a use
// site whose own code runs another module's binding, and so on). A deeper
// chain is cut and marked `bounded`: a use of every changed module.
const MAX_RUN_DEPTH = 8;

/**
 * Identifiers `node` reads while the module loads (see above), each with the
 * READ/RUN/MEMBER flags of how it is used. `node` may be an expression, a
 * statement, or the declaration of a binding being used in `mode`.
 *
 * Code that runs (a called function's body, an invoked class) is not read
 * positionally: every identifier it mentions, nested functions included,
 * counts as RUN|MEMBER, since a local alias or a returned value can call
 * anything it names. Positions are honoured only in code evaluated directly
 * at load (initializers, the use-site statement), where they are exact.
 */
function loadTimeIdentifiers(node, locals, mode = READ) {
  const into = new Map();
  const seen = new Set();
  const note = (name, flags) =>
    into.set(name, (into.get(name) ?? READ) | flags);
  const isFunction = (candidate) =>
    ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate);
  const unwrap = (candidate) => {
    let current = candidate;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    return current;
  };
  const readLocal = (name, flags) => {
    const local = locals.get(name);
    const key = `${name}\0${flags}`;
    if (!local || seen.has(key)) return;
    seen.add(key);
    visit(local, flags);
  };
  const run = (code) => {
    for (const name of referencedIdentifiers(code)) {
      note(name, ALL);
      readLocal(name, ALL);
    }
  };
  // Declaring a class evaluates its decorators, heritage, computed keys,
  // static initializers and static blocks. Constructing it, or using any
  // member of it (a static getter or method, or a method on an instance),
  // can run any of its code, so that runs the whole class.
  const visitClass = (current, flags) => {
    if (flags !== READ) {
      run(current);
      return;
    }
    for (const decorator of ts.getDecorators?.(current) ?? [])
      visit(decorator.expression, RUN);
    for (const clause of current.heritageClauses ?? [])
      for (const type of clause.types) visit(type.expression, READ);
    for (const member of current.members) {
      for (const decorator of ts.getDecorators?.(member) ?? [])
        visit(decorator.expression, RUN);
      if (member.name && ts.isComputedPropertyName(member.name))
        visit(member.name.expression, READ);
      if (ts.isClassStaticBlockDeclaration(member)) run(member.body);
      else if (
        ts.isPropertyDeclaration(member) &&
        hasModifier(member, ts.SyntaxKind.StaticKeyword) &&
        member.initializer
      )
        visit(member.initializer, READ);
    }
  };
  const visit = (current, flags) => {
    if (ts.isIdentifier(current)) {
      note(current.text, flags);
      readLocal(current.text, flags);
      return;
    }
    // Declarations: what using the binding they declare in `flags` reads.
    if (ts.isFunctionDeclaration(current)) {
      if (flags !== READ && current.body) run(current);
      return;
    }
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
      visitClass(current, flags);
      return;
    }
    if (ts.isVariableDeclaration(current)) {
      // Destructuring reads members of the value (getters, an iterator).
      const pattern = !ts.isIdentifier(current.name);
      if (pattern) visit(current.name, READ); // defaults evaluated
      if (current.initializer)
        visit(current.initializer, pattern ? ALL : flags);
      return;
    }
    if (ts.isExportAssignment(current)) {
      visit(current.expression, flags);
      return;
    }
    if (isFunction(current)) {
      // Its body runs now only when this position invokes it.
      if (flags !== READ) run(current);
      return;
    }
    if (
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isConstructorDeclaration(current)
    )
      return;
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      visit(current.expression, flags);
      return;
    }
    if (ts.isConditionalExpression(current)) {
      visit(current.condition, READ);
      visit(current.whenTrue, flags);
      visit(current.whenFalse, flags);
      return;
    }
    if (ts.isBinaryExpression(current)) {
      const operator = current.operatorToken.kind;
      const either =
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken;
      // `a || b`, `a ?? b`, `a && b` and `a, b` evaluate to an operand.
      if (either || operator === ts.SyntaxKind.CommaToken) {
        visit(current.left, either ? flags : READ);
        visit(current.right, flags);
        return;
      }
      if (operator === ts.SyntaxKind.EqualsToken) {
        // `({ a } = value)` destructures the value; `x = value` yields it.
        const pattern =
          ts.isObjectLiteralExpression(current.left) ||
          ts.isArrayLiteralExpression(current.left);
        visit(current.left, READ);
        visit(current.right, pattern ? ALL : flags);
        return;
      }
      if (
        operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
        operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        // Every other operator can coerce an operand (valueOf, toString,
        // Symbol.toPrimitive) or run its code (instanceof's
        // Symbol.hasInstance, a proxy's `in` trap).
        visit(current.left, ALL);
        visit(current.right, ALL);
        return;
      }
    }
    if (
      ts.isPrefixUnaryExpression(current) ||
      ts.isPostfixUnaryExpression(current)
    ) {
      // `+x`, `-x`, `~x`, `++x` coerce; `!x` does not.
      visit(
        current.operand,
        current.operator === ts.SyntaxKind.ExclamationToken ? READ : ALL,
      );
      return;
    }
    if (
      // Implicit member use: iteration, a thenable, string coercion.
      ts.isSpreadElement(current) ||
      ts.isSpreadAssignment(current) ||
      ts.isAwaitExpression(current) ||
      ts.isTemplateSpan(current)
    ) {
      visit(current.expression, ALL);
      return;
    }
    if (ts.isForOfStatement(current) || ts.isForInStatement(current)) {
      visit(current.initializer, READ);
      visit(current.expression, ALL);
      visit(current.statement, READ);
      return;
    }
    if (ts.isPropertyAccessExpression(current)) {
      // A member read can run a getter, or a method called next.
      visit(current.expression, MEMBER);
      return;
    }
    if (ts.isElementAccessExpression(current)) {
      visit(current.expression, MEMBER);
      visit(current.argumentExpression, READ);
      return;
    }
    if (ts.isObjectLiteralExpression(current) && flags & MEMBER) {
      // Any member may be read or called.
      for (const property of current.properties) {
        if (property.name && ts.isComputedPropertyName(property.name))
          visit(property.name.expression, READ);
        if (ts.isPropertyAssignment(property)) visit(property.initializer, ALL);
        else if (ts.isShorthandPropertyAssignment(property))
          visit(property.name, ALL);
        else if (ts.isSpreadAssignment(property))
          visit(property.expression, ALL);
        else run(property);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(current) && flags & MEMBER) {
      for (const element of current.elements) visit(element, ALL);
      return;
    }
    if (ts.isPropertyAssignment(current)) {
      if (ts.isComputedPropertyName(current.name))
        visit(current.name.expression, READ);
      visit(current.initializer, READ);
      return;
    }
    if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
      // The callee runs. It may call, construct, iterate or read members
      // of anything handed to it, nested values included (#2766).
      visit(unwrap(current.expression), RUN);
      for (const argument of current.arguments ?? []) visit(argument, ALL);
      return;
    }
    if (ts.isTaggedTemplateExpression(current)) {
      visit(unwrap(current.tag), RUN);
      visit(current.template, ALL);
      return;
    }
    if (ts.isPropertyDeclaration(current)) {
      // A static initializer runs at class evaluation; an instance one
      // runs only on construction.
      if (
        hasModifier(current, ts.SyntaxKind.StaticKeyword) &&
        current.initializer
      )
        visit(current.initializer, READ);
      return;
    }
    if (ts.isClassStaticBlockDeclaration(current)) {
      run(current.body);
      return;
    }
    ts.forEachChild(current, (child) => {
      visit(child, READ);
    });
  };
  visit(node, mode);
  return into;
}

/**
 * The declarations that give a module's local export `name` its value, or
 * null when this analysis cannot find them (and so cannot say what using the
 * binding runs). `export { local as name }` is followed to `local`.
 */
function exportedDeclarations(file, name) {
  let local = name;
  for (const statement of file.statements)
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements)
        if (element.name.text === name)
          local = (element.propertyName ?? element.name).text;
  const found = [];
  for (const statement of file.statements) {
    if (local === 'default') {
      if (ts.isExportAssignment(statement)) found.push(statement);
      else if (
        hasModifier(statement, ts.SyntaxKind.DefaultKeyword) &&
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement))
      )
        found.push(statement);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (bindingNames(declaration.name, []).includes(local))
          found.push(declaration);
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name?.text === local
    )
      found.push(statement);
  }
  return found.length ? found : null;
}

/**
 * Every top-level use in barrel-evaluated modules, with the origins of what
 * it reads. Exported for its tests; `topLevelUseOf` is the consumer.
 *
 * @returns {Array<{ importer: string, line: number, any: boolean, mods: Set<string> }>}
 */
export function topLevelUseAnalysis(graph) {
  if (topLevelUseAnalyses.has(graph)) return topLevelUseAnalyses.get(graph);
  const infos = new Map();
  const info = (module) => {
    if (!infos.has(module)) {
      const source = graph.sources.get(module);
      if (source === undefined) {
        infos.set(module, null);
        return null;
      }
      const file = parse(module, source, true);
      const importedFrom = new Map();
      const locals = new Map();
      for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (!clause || clause.isTypeOnly) continue;
          const target = graph.resolveSpecifier(
            module,
            statement.moduleSpecifier.text,
          );
          if (target === null) continue;
          if (clause.name)
            importedFrom.set(clause.name.text, [target, 'default']);
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings))
            importedFrom.set(bindings.name.text, [target, null]);
          else if (bindings)
            for (const element of bindings.elements)
              if (!element.isTypeOnly)
                importedFrom.set(element.name.text, [
                  target,
                  (element.propertyName ?? element.name).text,
                ]);
        } else if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations)
            if (ts.isIdentifier(declaration.name))
              locals.set(declaration.name.text, declaration);
        } else if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement)) &&
          statement.name
        )
          locals.set(statement.name.text, statement);
      }
      infos.set(module, { file, importedFrom, locals });
    }
    return infos.get(module);
  };

  const memo = new Map();
  const fresh = (module) => ({
    mods: new Set(module ? [module] : []),
    any: false,
    found: false,
    cyclic: false,
    bounded: false,
  });
  const merge = (into, from) => {
    for (const module of from.mods) into.mods.add(module);
    into.any ||= from.any;
    into.cyclic ||= from.cyclic;
    into.bounded ||= from.bounded;
  };
  const stack = new Set();
  const memoized = (key, compute) => {
    if (memo.has(key)) return memo.get(key);
    if (stack.has(key)) return { ...fresh(null), cyclic: true };
    stack.add(key);
    const result = compute();
    stack.delete(key);
    // A result computed beneath a cycle hit is partial: never cache it.
    if (!result.cyclic) memo.set(key, result);
    return result;
  };
  // `depth` counts the cross-module hops of running code that led here.
  // Results are memoized without it: a result cut at the bound is marked
  // `bounded`, which is only more conservative wherever it is reused.
  const bindingOrigins = (target, importedName, mode, depth) => {
    if (target === UNKNOWN) return { ...fresh(null), any: true, found: true };
    if (depth > MAX_RUN_DEPTH)
      // Not `any`: the bound is reported only when it alone decides.
      return { ...fresh(target), found: true, bounded: true };
    return importedName === null
      ? namespaceOrigins(target, mode, depth)
      : origins(target, importedName, mode, depth);
  };
  // What using a local export in `mode` reads: its initializer, or, for a
  // function or class, the code that use runs. Fails closed when the
  // declaration cannot be found (a TS namespace, `export import`).
  const localOrigins = (module, name, mode, depth, result) => {
    const moduleInfo = info(module);
    const declarations = moduleInfo
      ? exportedDeclarations(moduleInfo.file, name)
      : null;
    if (!declarations) {
      result.any = true;
      return;
    }
    const reads = new Map();
    for (const declaration of declarations)
      for (const [identifier, flags] of loadTimeIdentifiers(
        declaration,
        moduleInfo.locals,
        mode,
      ))
        reads.set(identifier, (reads.get(identifier) ?? READ) | flags);
    for (const [identifier, flags] of reads) {
      const source = moduleInfo.importedFrom.get(identifier);
      if (source)
        merge(
          result,
          bindingOrigins(
            source[0],
            source[1],
            flags,
            flags === READ ? depth : depth + 1,
          ),
        );
    }
  };
  const origins = (module, name, mode, depth) =>
    memoized(`${module}\0${name}\0${mode}`, () => {
      const result = fresh(module);
      const table = graph.exportsOf(module);
      if (!table) {
        result.any = result.found = true;
        return result;
      }
      if (table.local.has(name)) {
        result.found = true;
        localOrigins(module, name, mode, depth, result);
        return result;
      }
      const entry = table.named.get(name);
      if (entry) {
        result.found = true;
        const target = graph.resolveSpecifier(module, entry.specifier);
        if (target === null) return result;
        merge(result, bindingOrigins(target, entry.name, mode, depth));
        return result;
      }
      if (name === 'default') return result;
      for (const specifier of table.stars) {
        const target = graph.resolveSpecifier(module, specifier);
        // An external or unresolvable star could be where the name lives.
        if (target === null || target === UNKNOWN) {
          result.any = result.found = true;
          continue;
        }
        const nested = origins(target, name, mode, depth);
        if (nested.found || nested.any) {
          merge(result, nested);
          result.found = true;
        } else result.cyclic ||= nested.cyclic;
      }
      return result;
    });
  // A namespace binds every export; a star re-export is not enumerated.
  const namespaceOrigins = (module, mode, depth) =>
    memoized(`${module}\0*\0${mode}`, () => {
      const result = fresh(module);
      result.found = true;
      const table = graph.exportsOf(module);
      if (!table || table.stars.length) {
        result.any = true;
        return result;
      }
      for (const name of [...table.local, ...table.named.keys()])
        merge(result, origins(module, name, mode, depth));
      return result;
    });

  const uses = [];
  for (const importer of barrelReachable(graph)) {
    if (!isSdkSourceModule(importer) && !graph.barrels.has(importer)) continue;
    const moduleInfo = info(importer);
    if (!moduleInfo || moduleInfo.importedFrom.size === 0) continue;
    const imported = importedBindings(moduleInfo.file);
    for (const statement of moduleInfo.file.statements) {
      if (!statementHasSideEffect(statement, imported)) continue;
      const use = fresh(null);
      // Everything the statement reads, including through local bindings
      // (`const l = [f]; registry.push(l)`), whatever the position: the
      // use site is already a side effect, so this side over-approximates.
      const read = referencedIdentifiers(statement);
      for (const identifier of read) {
        const local = moduleInfo.locals.get(identifier);
        if (local) referencedIdentifiers(local, read);
      }
      // How the statement uses each binding: calling or constructing one,
      // or reading a member of it, runs its code too (#2766).
      const flags = loadTimeIdentifiers(statement, moduleInfo.locals);
      for (const identifier of read) {
        const source = moduleInfo.importedFrom.get(identifier);
        const mode = flags.get(identifier) ?? READ;
        if (source)
          merge(
            use,
            bindingOrigins(source[0], source[1], mode, mode === READ ? 0 : 1),
          );
      }
      if (use.any || use.bounded || use.mods.size)
        uses.push({
          importer,
          line:
            moduleInfo.file.getLineAndCharacterOfPosition(statement.getStart())
              .line + 1,
          any: use.any,
          bounded: use.bounded,
          mods: use.mods,
        });
    }
  }
  topLevelUseAnalyses.set(graph, uses);
  return uses;
}

function topLevelUseOf(graph, changed) {
  const uses = topLevelUseAnalysis(graph).filter(
    (use) => use.importer !== changed,
  );
  // A traced origin or an unresolvable binding decides on its own; a chain
  // cut at the bound decides only when no use does.
  const direct = uses.find((use) => use.any || use.mods.has(changed));
  if (direct) return { importer: direct.importer, line: direct.line };
  const bounded = uses.find((use) => use.bounded);
  return bounded
    ? { importer: bounded.importer, line: bounded.line, bounded: true }
    : null;
}

/** One changed module's disposition: refined with seeds, or whole-barrel. */
function decideCandidate(root, base, path, graph, readBase, importContext) {
  const whole = (reason) => ({ disposition: 'whole-barrel', reason });
  const head = graph.sources.get(path);
  let baseSource;
  try {
    baseSource = readBase(root, base, path);
  } catch (error) {
    return whole(
      `base content unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (head === undefined) return whole('not readable');
  for (const [label, source] of [
    ['head', head],
    ['base', baseSource],
  ]) {
    if (source === null || source === undefined) continue;
    const effect = topLevelSideEffect(path, source);
    if (effect) {
      const line =
        effect.getSourceFile().getLineAndCharacterOfPosition(effect.getStart())
          .line + 1;
      return whole(`top-level side effect at ${label} line ${line}`);
    }
  }
  // Loading a different set of modules changes what every barrel importer
  // evaluates (a side-effecting module, an import cycle through a barrel)
  // even when the module's own statements are pure.
  if (
    baseSource !== null &&
    baseSource !== undefined &&
    runtimeImportKey(path, baseSource) !== runtimeImportKey(path, head)
  ) {
    const blocker = importChangeBlocker(importContext, path, baseSource, head);
    if (blocker)
      return whole(`runtime imports differ from the base: ${blocker}`);
  }
  const use = topLevelUseOf(graph, path);
  if (use)
    return whole(
      `${use.importer} line ${use.line} uses it in a top-level side effect${use.bounded ? ` (a call chain deeper than ${MAX_RUN_DEPTH} modules is not traced)` : ''}`,
    );
  const baseExportNames = new Set();
  if (baseSource) {
    const table = collectExports(path, baseSource);
    for (const name of [...table.local, ...table.named.keys()])
      baseExportNames.add(name);
  }
  const { seeds } = refinedSeedsFor(graph, path, { baseExportNames });
  return { disposition: 'refined', seeds: seeds.length, seedPaths: seeds };
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
 * @param {string[]} [options.changedSdkPaths] every SDK file that differs
 *   from the base (default: the candidates when `readBase` is injected,
 *   otherwise asked of git); their base content decides what a barrel load
 *   reached at the base.
 * @returns {{ paths: string[], decisions: Array<{ path: string, disposition: 'refined' | 'whole-barrel', seeds?: number, reason?: string }> }}
 */
export function refineSdkBarrelRelatedPaths(
  root,
  relatedPaths,
  { base, loadGraph = loadSdkImportGraph, readBase, changedSdkPaths } = {},
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
  // Without an injected reader, read every candidate — and every other
  // changed SDK file, for base reachability — at the base at once.
  let changed = changedSdkPaths ?? (readBase ? candidates : undefined);
  let changedFailure;
  if (changed === undefined)
    try {
      changed = changedSdkFiles(root, base);
    } catch (error) {
      changedFailure = error;
      changed = [];
    }
  let readCandidate = readBase;
  if (!readCandidate) {
    let contents;
    let failure;
    try {
      contents = readAllAtBase(
        root,
        base,
        [...new Set([...candidates, ...changed])].filter(
          (path) => path !== SDK_PACKAGE_JSON,
        ),
      );
    } catch (error) {
      failure = error;
    }
    readCandidate = (_root, _base, path) => {
      if (failure) throw failure;
      return contents.get(path);
    };
  }
  // Base content of every changed SDK file; null when that set is unknown.
  // Base content is resolved with the head resolver, so a changed SDK
  // `exports` map makes base reachability unknown rather than guessed.
  let baseSources = null;
  let baseUnknown = null;
  if (changedFailure)
    baseUnknown = `the changed SDK files are unknown: ${changedFailure instanceof Error ? changedFailure.message : String(changedFailure)}`;
  else if (changed.includes(SDK_PACKAGE_JSON))
    baseUnknown = `${SDK_PACKAGE_JSON} changed, so base imports cannot be resolved with the head exports map`;
  else
    try {
      baseSources = new Map(
        [...new Set([...candidates, ...changed])].map((path) => [
          path,
          readCandidate(root, base, path) ?? null,
        ]),
      );
    } catch (error) {
      baseUnknown = `a changed SDK file is unreadable at the base: ${error instanceof Error ? error.message : String(error)}`;
    }
  const importContext = importChangeContext(graph, baseSources, baseUnknown);
  for (const path of candidates) {
    let decision;
    try {
      decision = decideCandidate(
        root,
        base,
        path,
        graph,
        readCandidate,
        importContext,
      );
    } catch (error) {
      // Refinement only narrows. An internal failure for one path selects
      // MORE (plain related selection), never fails the lane.
      decision = {
        disposition: 'whole-barrel',
        reason: `refinement failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (decision.disposition === 'refined')
      for (const seed of decision.seedPaths) paths.add(seed);
    else paths.add(path);
    const { seedPaths: _seedPaths, ...reported } = decision;
    decisions.push({ path, ...reported });
  }
  return { paths: [...paths].sort(), decisions };
}
