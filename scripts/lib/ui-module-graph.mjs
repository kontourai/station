// The UI's module import graph, computed from source with TypeScript's own
// parser and module resolver (the `src-ui/tsconfig.json` compiler options, so
// `@/` and the `@kontourai/*` path mappings resolve exactly as the type
// checker resolves them). Gallery coverage routing (`gate:for`) asks this
// graph which modules a screen's entry modules load; it never matches paths
// by substring.
//
// Edges kept: value imports and re-exports (`import type`/`export type` carry
// no runtime module), side-effect imports (`import './x.css'`), dynamic
// `import('literal')`, and CSS `@import`. Edges that leave the repository or
// land in `node_modules` are dropped: they are not files a change here edits.
// `import.meta.glob` and computed `import(expr)` are not modelled, so a
// module reached only through them reads as unreached.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
// The classic compiler API; `typescript` itself is the native 7.x compiler.
import ts from 'typescript-api';

const CSS_IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;
const HTML_ENTRY =
  /<(?:script\b[^>]*\btype="module"[^>]*\bsrc|link\b[^>]*\brel="stylesheet"[^>]*\bhref)="([^"]+)"/g;

function toRepoPath(rootDir, absolutePath) {
  const rel = relative(rootDir, absolutePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const portable = rel.split(sep).join('/');
  if (portable.split('/').includes('node_modules')) return null;
  return portable;
}

function readCompilerOptions(rootDir) {
  const configPath = join(rootDir, 'src-ui', 'tsconfig.json');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error)
    throw new Error(
      `ui-module-graph: cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
    );
  return ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath))
    .options;
}

function moduleSpecifiers(absolutePath, text) {
  const staticSpecs = [];
  const dynamicSpecs = [];
  if (absolutePath.endsWith('.css')) {
    for (const match of text.matchAll(CSS_IMPORT)) staticSpecs.push(match[1]);
    return { staticSpecs, dynamicSpecs };
  }
  if (absolutePath.endsWith('.html')) {
    // Vite's HTML entry: root-relative module scripts and stylesheets resolve
    // against the HTML file's own directory (the Vite root).
    for (const match of text.matchAll(HTML_ENTRY))
      if (match[1].startsWith('/')) staticSpecs.push(`.${match[1]}`);
    return { staticSpecs, dynamicSpecs };
  }
  const source = ts.createSourceFile(
    absolutePath,
    text,
    ts.ScriptTarget.Latest,
    false,
    absolutePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.importClause?.isTypeOnly
    ) {
      staticSpecs.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      !node.isTypeOnly
    ) {
      staticSpecs.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      dynamicSpecs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { staticSpecs, dynamicSpecs };
}

/**
 * A lazily-parsed module graph rooted at `rootDir`. Paths in and out are
 * repo-relative with forward slashes.
 */
export function createUiModuleGraph(rootDir = process.cwd()) {
  const root = realpathSync(rootDir);
  const options = readCompilerOptions(root);
  const host = ts.createCompilerHost(options);
  const cache = new Map();

  const resolveSpecifier = (spec, containingFile) => {
    if (spec.endsWith('.css')) {
      // TypeScript does not resolve stylesheet specifiers; apply the same
      // relative/`paths` rules it would, against the file system.
      let target = null;
      if (spec.startsWith('.')) target = resolve(dirname(containingFile), spec);
      else
        for (const [pattern, [mapped]] of Object.entries(options.paths ?? {}))
          if (pattern.endsWith('/*') && spec.startsWith(pattern.slice(0, -1)))
            target = resolve(
              options.pathsBasePath ?? root,
              mapped.slice(0, -1) + spec.slice(pattern.length - 1),
            );
      return target && existsSync(target) ? realpathSync(target) : null;
    }
    const resolved = ts.resolveModuleName(
      spec,
      containingFile,
      options,
      host,
    ).resolvedModule;
    // Workspace packages are symlinked into node_modules, so TypeScript may
    // call them external; their real path decides (toRepoPath drops the rest).
    if (!resolved || resolved.resolvedFileName.endsWith('.d.ts')) return null;
    return realpathSync(resolved.resolvedFileName);
  };

  /** @returns {{ static: string[], dynamic: string[] }} */
  const edges = (repoPath) => {
    const cached = cache.get(repoPath);
    if (cached) return cached;
    const absolutePath = join(root, repoPath);
    const text = readFileSync(absolutePath, 'utf8');
    const { staticSpecs, dynamicSpecs } = moduleSpecifiers(absolutePath, text);
    const toPaths = (specs) => [
      ...new Set(
        specs
          .map((spec) => resolveSpecifier(spec, absolutePath))
          .filter(Boolean)
          .map((target) => toRepoPath(root, target))
          .filter(Boolean),
      ),
    ];
    const result = {
      static: toPaths(staticSpecs),
      dynamic: toPaths(dynamicSpecs),
    };
    cache.set(repoPath, result);
    return result;
  };

  /**
   * Every module reachable from `entries`. `followDynamic: false` gives the
   * eagerly loaded set; `true` adds everything a lazy boundary can load.
   */
  const closure = (entries, { followDynamic }) => {
    const seen = new Set();
    const stack = [...entries];
    while (stack.length > 0) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      if (!existsSync(join(root, current)))
        throw new Error(`ui-module-graph: entry ${current} does not exist`);
      seen.add(current);
      const next = edges(current);
      stack.push(...next.static);
      if (followDynamic) stack.push(...next.dynamic);
    }
    return seen;
  };

  return { edges, closure };
}
