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
 *   is not published with the package, and `node:child_process`, which the
 *   crash tests use to kill a real process;
 * - a dynamic `import()` or `require()` whose argument is not a constant
 *   string cannot be checked and is refused, and so are the loaders the
 *   import graph cannot see: the `node:module`, `node:vm`,
 *   `node:child_process` and `node:worker_threads` builtins;
 *   `getBuiltinModule`, `createRequire`, `eval` and `Function` spelled as a
 *   name or a constant string; a `require` that is referenced, or called as a
 *   member, rather than called directly; `import.meta.resolve`; and CommonJS
 *   source (`.cjs`, `.cts`, or any nested `package.json`);
 * - no symlink may exist under the package, git-ignored paths included:
 *   relative specifiers are checked by path, and a link would let `./x`
 *   resolve outside it. No relative specifier may pass through
 *   `node_modules`, and an untracked directory git will not list into (a
 *   nested repository) is refused rather than skipped;
 * - declaration files are scanned like any other source.
 *
 * Threat model (owner decision, #3607): the gate stops ACCIDENTAL coupling
 * between Station and Monument internals, the kind real code and agents
 * produce: an import, a test helper's path, an alias, a symlink, a stray
 * file. It does not stop deliberate evasion. Accepted limits, left to review:
 * names assembled at run time (`process['getBuilt' + 'inModule']`), data
 * URLs, escape spellings beyond `%XX`, `\u` and `\x` (line continuations,
 * identity and octal escapes), computed paths in Station files that never
 * name the package in a string literal, and a repo-relative path string
 * (`'packages/monument/src'`) used anywhere but a `resolve`/`join` argument
 * or a vite or vitest config.
 *
 * Imports are read from the TypeScript syntax tree (static imports, re-exports,
 * `import x = require()`, `import()`, `require()`, `require.resolve()`,
 * `import('x').T` type queries and `/// <reference>` directives), not by text
 * matching.
 *
 *   node scripts/monument-import-boundary-gate.mjs
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

export const MONUMENT_ROOT = 'packages/monument';
const MONUMENT_PACKAGE = '@kontourai/monument';
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const COMMONJS_EXTENSION = /\.c[jt]s$/;
const TEST_FILE = /(^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_ONLY_IMPORTS = new Set(['vitest']);
/** Crash tests spawn real children; shipped source may not. */
const TEST_ONLY_LOADERS = new Set(['node:child_process']);
const MODULE_LOADER_SPECIFIERS = new Set([
  'node:module',
  'module',
  'node:vm',
  'vm',
  'node:child_process',
  'child_process',
  'node:worker_threads',
  'worker_threads',
]);
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
 * Dependencies the package may declare. Empty today: the package has none,
 * and adding one is a reviewed change to this list, not to package.json alone.
 */
export const APPROVED_DEPENDENCIES = new Set();

const LIFECYCLE_SCRIPTS = new Set([
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
  'prepublish',
  'prepublishOnly',
  'prepack',
  'postpack',
  'publish',
  'postpublish',
  'preuninstall',
  'uninstall',
  'postuninstall',
  'dependencies',
]);

/**
 * A specifier that installs something other than the registry package of the
 * declared name. `"innocent": "workspace:@kontourai/station-shared@*"` would
 * pass a check that reads names only.
 */
const ALIASED_SPECIFIER =
  /^(?:workspace|npm|file|link|portal|git|git\+[a-z]+|github|https?):|^[./~]|\//;

/**
 * The dependencies the package may import, and a finding for every entry it
 * may not declare: a Station package, an aliased specifier, or anything not
 * in {@link APPROVED_DEPENDENCIES}.
 */
export function readManifest(manifestText, manifestPath) {
  const manifest = JSON.parse(manifestText);
  const runtime = new Set();
  const findings = [];
  const refuse = (kind, field, name) =>
    findings.push({
      kind,
      file: manifestPath,
      line: 1,
      specifier: `${field}.${name}`,
    });
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      const aliased =
        typeof version !== 'string' || ALIASED_SPECIFIER.test(version);
      if (STATION_PACKAGE.test(name)) refuse('station-dependency', field, name);
      if (aliased) refuse('aliased-dependency', field, name);
      else if (!APPROVED_DEPENDENCIES.has(name))
        refuse('unapproved-dependency', field, name);
      if (
        RUNTIME_DEPENDENCY_FIELDS.has(field) &&
        !aliased &&
        APPROVED_DEPENDENCIES.has(name)
      )
        runtime.add(name);
    }
  }
  // Inert today, but each would run code at install or put an executable on
  // a consumer's PATH without passing through the import graph.
  if (manifest.bin !== undefined)
    findings.push({
      kind: 'manifest-hook',
      file: manifestPath,
      line: 1,
      specifier: 'bin',
    });
  for (const name of Object.keys(manifest.scripts ?? {}))
    if (LIFECYCLE_SCRIPTS.has(name))
      findings.push({
        kind: 'manifest-hook',
        file: manifestPath,
        line: 1,
        specifier: `scripts.${name}`,
      });
  return { declared: runtime, findings, exports: manifest.exports ?? {} };
}

function constantString(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  return null;
}

/**
 * `require(...)`, `require.resolve(...)`: the call forms the visitor checks
 * by their argument. A property NAMED `require` is not the loader.
 */
function isMemberRequireCall(identifier) {
  const parent = identifier.parent;
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === identifier &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  );
}

function isRequireCallee(identifier) {
  const parent = identifier.parent;
  if (ts.isCallExpression(parent) && parent.expression === identifier)
    return true;
  if (ts.isPropertyAccessExpression(parent)) {
    // `x.require` names a property; `module.require(...)` calls a loader.
    if (parent.name === identifier) return !isMemberRequireCall(identifier);
    return (
      parent.expression === identifier &&
      parent.name.text === 'resolve' &&
      ts.isCallExpression(parent.parent) &&
      parent.parent.expression === parent
    );
  }
  // Declarations that merely use the name. A later VALUE reference to a
  // local named `require` is still refused: telling it from the loader would
  // need scope analysis, and failing closed costs only a rename.
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent)) &&
    (parent.name === identifier || parent.propertyName === identifier)
  );
}

/**
 * Names that reach a module loader without an import the graph can see.
 * They are refused wherever they appear as a name or as a constant string
 * (`process['getBuiltinModule']`, `const { getBuiltinModule } = process`),
 * since this package has no legitimate use for any of them.
 */
const LOADER_NAMES = new Map([
  ['getBuiltinModule', '<getBuiltinModule>'],
  ['createRequire', '<createRequire>'],
  ['eval', '<eval>'],
  ['Function', '<Function>'],
]);

function isImportMeta(node) {
  return (
    ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

function loaderSpelling(node) {
  if (
    (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
    LOADER_NAMES.has(node.text)
  )
    return LOADER_NAMES.get(node.text);
  if (
    (ts.isPropertyAccessExpression(node) &&
      isImportMeta(node.expression) &&
      node.name.text === 'resolve') ||
    (ts.isElementAccessExpression(node) &&
      isImportMeta(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'resolve')
  )
    return '<import.meta.resolve>';
  return undefined;
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
    const loader = loaderSpelling(node);
    if (loader)
      references.push({
        specifier: loader,
        line: lineOf(node.getStart()),
        how: 'module-loader',
      });
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
        specifier: isMemberRequireCall(node)
          ? '<member require>'
          : '<require reference>',
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

/** A repository-relative path, resolved as Node resolves a file URL. */
export function resolveRelative(file, specifier) {
  return decodeURIComponent(
    new URL(specifier, `file:///${file}`).pathname,
  ).replace(/^\//, '');
}

/** Why a reference from `file` is refused, or null when it is allowed. */
export function classifyReference(file, reference, declared) {
  const { specifier } = reference;
  if (reference.how === 'module-loader') return 'module-loader';
  if (specifier === null) return 'unverifiable-import';
  if (MODULE_LOADER_SPECIFIERS.has(specifier))
    return TEST_FILE.test(file) && TEST_ONLY_LOADERS.has(specifier)
      ? null
      : 'module-loader';
  if (specifier.startsWith('node:')) return null;
  if (specifier.startsWith('.')) {
    // Node resolves a relative specifier as a URL, so `%2e%2e` is `..`. The
    // gate refuses any escape, query or fragment outright, then resolves the
    // rest the way Node does.
    if (/[%\\?#]/.test(specifier)) return 'encoded-specifier';
    const resolved = resolveRelative(file, specifier);
    // Through node_modules, a relative path reaches whatever is linked there.
    if (
      !(
        resolved === MONUMENT_ROOT || resolved.startsWith(`${MONUMENT_ROOT}/`)
      ) ||
      resolved
        .split('/')
        .some((segment) => segment.toLowerCase() === 'node_modules')
    )
      return 'escapes-package';
    // Only source is read by the gate, so only source may be loaded: Node
    // loads `../LICENSE` as ESM, and vitest loads Markdown.
    return SOURCE_EXTENSION.test(resolved) ? null : 'non-source-import';
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
    // The package is ESM. A CommonJS file opens `module.require` and friends.
    if (COMMONJS_EXTENSION.test(file)) {
      findings.push({ kind: 'commonjs-source', file, line: 1, specifier: '' });
      continue;
    }
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

/**
 * What may live in the package: source, Markdown, the licence, and the root
 * manifest and tsconfig. Anything else is refused, because Node and the
 * published `files` list would load or ship it without the gate reading it
 * (an extensionless module beside a `.d.ts`, for one).
 */
export function allowedPackageFile(file) {
  return (
    SOURCE_EXTENSION.test(file) ||
    (file.endsWith('.md') &&
      !file.slice(MONUMENT_ROOT.length + 1).includes('/')) ||
    file === `${MONUMENT_ROOT}/LICENSE` ||
    file === `${MONUMENT_ROOT}/package.json` ||
    file === `${MONUMENT_ROOT}/tsconfig.json` ||
    // The publish build's config (`npm run build`); its `dist/` output is
    // plain `.js` and `.d.ts`, which are source and scanned like any other.
    file === `${MONUMENT_ROOT}/tsconfig.build.json`
  );
}

function listPackageFiles() {
  // Untracked files count too, ignored ones included: a planted import or
  // link must fail before it is added, wherever .gitignore would hide it.
  // Only the package's own dependency tree is skipped.
  return execFileSyncBounded(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--',
      MONUMENT_ROOT,
      `:(exclude)${MONUMENT_ROOT}/node_modules`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
    .split('\n')
    .filter(Boolean);
}

/**
 * The text a specifier could be spelled with, undone: percent escapes and
 * JavaScript string escapes decoded, case folded. Used only to choose which
 * files to parse, so it may over-match but must not under-match.
 */
export function mentionsMonument(content) {
  const folded = content.toLowerCase();
  if (folded.includes('monument')) return true;
  if (!content.includes('%') && !content.includes('\\')) return false;
  const decoded = content
    .replace(/%([0-9a-f]{2})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(
      /\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,
      (match, a, b, c) => {
        const code = Number.parseInt(a ?? b ?? c, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      },
    );
  return decoded.toLowerCase().includes('monument');
}

/**
 * Where an absolute path really is: the real path of its deepest existing
 * ancestor, with the rest appended. Symlinks along the way are followed.
 */
function canonicalPath(absolute) {
  let existing = absolute;
  const rest = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {}
  return join(real, ...rest);
}

/** Compared case-insensitively, so a differently cased path is not a way in. */
function within(path, root) {
  const a = path.toLowerCase();
  const b = root.toLowerCase();
  return a === b || a.startsWith(b + sep);
}

/** Every target string in an `imports`/`exports`/`paths` value. */
function targetStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(targetStrings);
  if (value && typeof value === 'object')
    return Object.values(value).flatMap(targetStrings);
  return [];
}

/** An argument of `resolve(...)` or `join(...)`, `path.` or bare. */
function isPathCallArgument(node) {
  const call = node.parent;
  if (!ts.isCallExpression(call) || !call.arguments.includes(node))
    return false;
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : '';
  return name === 'resolve' || name === 'join';
}

/** Bundler config files, whose plain strings are paths relative to them. */
const BUNDLER_CONFIG = /(^|[.-])vite(?:st)?[^/]*\.config\.[cm]?[jt]s$/;

/**
 * Whether a string names the package: `@kontourai/monument`, or `monument`
 * as a whole path segment. `monument-import-boundary:gate` does not.
 */
const NAMES_PACKAGE = /(^|[/@])monument(?![-\w])/;

/** The decoded text of every string literal in a file, with its line. */
function stringLiterals(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const literals = [];
  const lineOf = (node) =>
    source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node) => {
    if (ts.isStringLiteralLike(node))
      literals.push({
        text: node.text,
        line: lineOf(node),
        inPathCall: isPathCallArgument(node),
        // `{ '@kontourai/monument/*': … }`: a key, not a value used as a path.
        propertyName:
          (ts.isPropertyAssignment(node.parent) ||
            ts.isPropertySignature(node.parent)) &&
          node.parent.name === node,
      });
    else if (ts.isTemplateExpression(node))
      // Its constant parts only: enough to tell whether it names the package.
      literals.push({
        text: [
          node.head.text,
          ...node.templateSpans.map((span) => span.literal.text),
        ].join(''),
        line: lineOf(node),
        template: true,
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

function decodePercent(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Station's side of the boundary: code outside the package reaches it only
 * through `@kontourai/monument` and the subpaths its manifest exports. The
 * threat model is the gate's (see the header): accidental coupling.
 *
 * - a relative, absolute or `file:` module specifier is resolved as Node
 *   resolves it, through symlinks and case-insensitively, and refused if it
 *   lands in the package, or in a `node_modules/@kontourai/monument` path the
 *   exports do not name;
 * - in a file whose string literals name the package, every path-like string
 *   literal is checked the same way (`vi.importActual(...)`, a
 *   `createRequire` call, `new URL(..., import.meta.url)`), except that the
 *   manifest is an allowed target; and a module
 *   reference the gate cannot read (a non-constant `import()`) is refused;
 * - a symlink outside the package that points into it is refused;
 * - a `package.json` `imports` alias or a `tsconfig*.json` `paths` entry whose
 *   target is inside the package, other than an exported entry file, is
 *   refused.
 */
export function scanMonumentConsumers({
  files,
  readText,
  exports,
  root = process.cwd(),
  isSymlink = () => false,
}) {
  const allowed = new Set(
    typeof exports === 'string' ? ['.'] : Object.keys(exports),
  );
  const packageRoot = canonicalPath(resolve(root, MONUMENT_ROOT));
  /**
   * What a path string or an alias may name inside the package: the files
   * its manifest exports, the manifest, and the root README, CONTEXT and
   * LICENSE. A module specifier may name none of them by path.
   */
  const publicTargets = new Set(
    [
      ...targetStrings(exports),
      'package.json',
      'README.md',
      'CONTEXT.md',
      'LICENSE',
    ].map((target) =>
      canonicalPath(resolve(packageRoot, target)).toLowerCase(),
    ),
  );
  const internalPath = (absolute, { allow = 'nothing' } = {}) => {
    const canonical = canonicalPath(absolute);
    if (within(canonical, packageRoot))
      return !(
        allow === 'public' && publicTargets.has(canonical.toLowerCase())
      );
    const modules = relative(root, canonical)
      .split(sep)
      .join('/')
      .toLowerCase()
      .match(/(?:^|\/)node_modules\/@kontourai\/monument(\/.*)?$/);
    return modules !== null && !allowed.has(`.${modules[1] ?? ''}`);
  };
  /** true: refused; false: allowed; 'encoded': cannot be decoded. */
  const reachesInternals = (file, text, options) => {
    try {
      if (text.startsWith('file:'))
        return internalPath(fileURLToPath(text), options);
      if (text.startsWith('/'))
        return internalPath(resolve(root, decodeURIComponent(text)), options);
      if (text.startsWith('./') || text.startsWith('../'))
        return internalPath(
          resolve(root, resolveRelative(file, text)),
          options,
        );
    } catch (error) {
      if (error instanceof URIError || error instanceof TypeError)
        return 'encoded';
      throw error;
    }
    if (/^@kontourai\/monument(?:\/|$)/i.test(text))
      return !allowed.has(`.${text.slice(MONUMENT_PACKAGE.length)}`);
    return false;
  };
  const findings = [];
  const report = (kind, file, line, specifier) =>
    findings.push({ kind, file, line, specifier });
  for (const file of files) {
    if (isSymlink(file)) {
      if (internalPath(resolve(root, file)))
        report('monument-symlink', file, 1, '');
      continue;
    }
    const name = basename(file);
    if (name === 'package.json' || ALIAS_CONFIG.test(name)) {
      scanAlias(file, readText(file), root, internalPath, report);
      continue;
    }
    if (!SOURCE_EXTENSION.test(file)) continue;
    const content = readText(file);
    if (!mentionsMonument(content)) continue;
    const literals = stringLiterals(file, content);
    // Whether the file names the package in code, not just in a comment.
    const namesPackage = literals.some((literal) =>
      NAMES_PACKAGE.test(decodePercent(literal.text).toLowerCase()),
    );
    if (!namesPackage) continue;
    const seen = new Set();
    for (const { specifier, line, how } of moduleReferences(file, content)) {
      if (typeof specifier !== 'string') {
        report(
          'monument-unverifiable-import',
          file,
          line,
          `<non-constant ${how}>`,
        );
        continue;
      }
      if (how === 'module-loader') continue;
      seen.add(`${line}\0${specifier}`);
      const verdict = reachesInternals(file, specifier);
      if (verdict === 'encoded')
        report('encoded-specifier', file, line, specifier);
      else if (verdict)
        report('monument-internal-import', file, line, specifier);
    }
    const bundlerConfig = BUNDLER_CONFIG.test(name);
    for (const { text, line, template, inPathCall, propertyName } of literals) {
      // Template text and property keys (`{ '@kontourai/monument/*': … }`)
      // are not paths a file loads.
      if (template || propertyName) continue;
      if (seen.has(`${line}\0${text}`)) continue;
      // A glob (`import.meta.glob('../packages/monument/src/*.ts')`) loads
      // what its fixed prefix names, so that prefix is what is checked. A
      // glob that names no monument path segment is left alone.
      let path = text;
      if (text.includes('*')) {
        if (!NAMES_PACKAGE.test(decodePercent(text).toLowerCase())) continue;
        path = text.slice(0, text.indexOf('*'));
      }
      // An undecodable string here is ordinary text ('/coverage/100%'), not
      // a path: only module specifiers report `encoded-specifier`.
      let verdict = reachesInternals(file, path, { allow: 'public' });
      if (verdict === 'encoded') continue;
      // A repo-relative string ('packages/monument/src') is a path only where
      // it is used as one: in resolve/join, or in a vite or vitest config.
      if (
        !verdict &&
        (inPathCall || bundlerConfig) &&
        path.includes('/') &&
        !/^[./]|^[a-z]+:/i.test(path)
      )
        verdict = [resolve(root, dirname(file)), root].some((base) =>
          internalPath(resolve(base, path), { allow: 'public' }),
        );
      if (verdict) report('monument-internal-reference', file, line, text);
    }
  }
  return findings;
}

/** `tsconfig.json`, `x.tsconfig.json`, `tsconfig.test.json`, `jsconfig.json`. */
const ALIAS_CONFIG = /(^|[.-])tsconfig.*\.json$|^jsconfig.*\.json$/;

/** `imports` in a package.json, `compilerOptions.paths` in a tsconfig. */
function scanAlias(file, content, root, internalPath, report) {
  const directory = resolve(root, dirname(file));
  const check = (base, field, key, targets, bareIsPath) => {
    for (const target of targetStrings(targets)) {
      // A bare package.json `imports` target is a package name; a bare
      // tsconfig `paths` target is a path under baseUrl.
      if (!bareIsPath && !target.startsWith('.') && !target.startsWith('/'))
        continue;
      const path = resolve(base, target.replaceAll('*', ''));
      if (internalPath(path, { allow: 'public' })) {
        report('monument-alias', file, 1, `${field}.${key}`);
        return;
      }
    }
  };
  if (basename(file) === 'package.json') {
    let manifest;
    try {
      manifest = JSON.parse(content);
    } catch {
      return;
    }
    for (const [key, targets] of Object.entries(manifest?.imports ?? {}))
      check(directory, 'imports', key, targets, false);
    return;
  }
  const { config } = ts.parseConfigFileTextToJson(file, content);
  const options = config?.compilerOptions ?? {};
  const base =
    typeof options.baseUrl === 'string'
      ? resolve(directory, options.baseUrl)
      : directory;
  for (const [key, targets] of Object.entries(options.paths ?? {}))
    check(base, 'compilerOptions.paths', key, targets, true);
}

function listConsumerFiles() {
  return execFileSyncBounded(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      '.',
      `:(exclude)${MONUMENT_ROOT}`,
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
  const structural = listed.flatMap((file) =>
    file.endsWith('/')
      ? [{ kind: 'unscanned-directory', file, line: 1, specifier: '' }]
      : file.endsWith('/package.json') &&
          file !== `${MONUMENT_ROOT}/package.json`
        ? [{ kind: 'nested-manifest', file, line: 1, specifier: '' }]
        : allowedPackageFile(file) ||
            symlinks.some((link) => link.file === file)
          ? []
          : [{ kind: 'unexpected-file', file, specifier: '' }],
  );
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
  const manifest = JSON.parse(
    readFileSync(`${MONUMENT_ROOT}/package.json`, 'utf8'),
  );
  const findings = [
    ...symlinks,
    ...structural,
    ...scanMonumentConsumers({
      files: listConsumerFiles(),
      readText: (path) =>
        lstatSync(path, { throwIfNoEntry: false })?.isFile()
          ? readFileSync(path, 'utf8')
          : '',
      exports: manifest.exports ?? {},
      isSymlink: (path) =>
        lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? false,
    }),
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
        `  ${finding.kind}: ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} ${finding.specifier}`,
      );
    process.exit(1);
  }
  console.log(
    `OK: monument import boundary: ${files.length} source file(s) import only node: builtins, declared dependencies and package-local modules.`,
  );
}

if (invokedDirectly(import.meta.url)) main();
