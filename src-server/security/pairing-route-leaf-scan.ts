/**
 * Leaf-level route discovery for the pairing-scope coverage guard
 * (station#1131). `pairing-route-scopes.test.ts`'s `scanMountedRouteBases()`
 * (station#1098 R2) proves every mount **base** in `runtime-routes.ts`
 * resolves to a scope, but a new **leaf** registered under an
 * already-covered base is invisible to it — the exact gap PR #1128 hit with
 * `GET /api/environments/ssh/sessions` (see `pairing-route-scopes.ts`'s
 * module docblock and `docs/security/remote-access-threat-model.md`'s
 * "Cross-station reads" section).
 *
 * This module performs a live, source-derived walk (never a hand-copied
 * list) starting at `configureRuntimeRoutes` in `runtime-routes.ts`:
 *
 * 1. Find every `context.app.<method>('<literal>', ...)` call registered
 *    directly in that function (the handful of ad hoc inline routes, e.g.
 *    `GET /api/survey-flow-reviews`).
 * 2. Find every `context.app.route('<base>', <expr>)` mount, resolve `expr`
 *    to the sub-router factory function it calls (following a local
 *    `const x = createFoo(...)` alias when the mount passes a variable
 *    instead of a call expression directly), and locate that factory's
 *    source file via the importing file's own `import` statements.
 * 3. Recurse into the factory's function body (isolated by TypeScript AST
 *    node locations, so a file exporting multiple factories — e.g. `auth.ts`'s
 *    `createAuthRoutes` and `createUserRoutes` — never cross-contaminates):
 *    every `app.<method>('<literal>', ...)` call is a discovered leaf
 *    (base + leaf, composed per Hono's own base+`/`-leaf join rule); every
 *    nested `app.route('<subBase>', <expr>)` call recurses one level
 *    deeper (e.g. `knowledge.ts` mounting `knowledge-document-routes.ts`
 *    twice, `system.ts` mounting two sibling route files at `/`).
 * 4. A factory file with no wrapping function (the `models.ts` pattern —
 *    routes attached to a module-top-level `const app = new Hono()`,
 *    `export default app`) falls back to a whole-file scan.
 * 5. Composition helpers (station#1131 review round 1, HIGH): a factory
 *    that does `const app = new Hono()` and then hands that SAME local
 *    variable to sibling `registerFooRoutes(app, deps)` /
 *    `configureFooRoutes(app, deps)` calls — `plugins.ts`'s
 *    `createPluginRoutes`, which composes five separate route files this
 *    way — is walked too: any bare call `ident(app, ...)` whose callee name
 *    matches `/^(register|configure)[A-Za-z0-9_]*Routes$/` is resolved
 *    exactly like a factory (import map, then a same-file local
 *    declaration) and recursed into at the SAME base (these calls attach
 *    routes directly to the shared `app`, they don't mount a nested
 *    sub-router). Deliberately narrow: this only fires when the current
 *    file itself contains `const <appVar> = new Hono(` for the exact
 *    variable being passed — i.e. it recognizes "a freshly-created local
 *    Hono app handed to a sibling registrar," not any arbitrary function
 *    call that happens to take `app` as an argument. This is why it does
 *    NOT also pick up `configureDevicePairingHostRoutes(context.app, ...)`
 *    at the top level (see below) or `configureRuntimeHttp`/
 *    `configureRuntimePublicRoutes`/`configureDevicePairingPublicRoutes` —
 *    none of those pass a locally-`new Hono()`-constructed variable; they
 *    pass `context.app`, a property from the caller's own parameter, which
 *    this scan never treats as a fresh local binding.
 *
 * Scoped honestly, same spirit as `scanMountedRouteBases()`'s own disclosed
 * limits: beyond the two calling conventions above (`context.app.route(...)`
 * / `context.app.<method>(...)`, and a local `const app = new Hono()`
 * handed to a `register*Routes`/`configure*Routes` sibling), nothing else is
 * walked. In particular `configureDevicePairingHostRoutes(context.app, ...)`
 * (registering every `/api/pairing/**` leaf) is NOT walked — audited by
 * hand instead (station#1131 review round 1): every route family reached
 * that way already carries its own hand-authored, all-methods
 * `PairingScopeRouteRule` entry (`origin: 'explicit'`, `/api/pairing:manage`
 * in `pairing-route-scopes.ts`), so any leaf under it — present or future —
 * resolves through a rule a human consciously wrote for that exact family,
 * never through the generic family split this guard exists to backstop.
 * See `docs/security/remote-access-threat-model.md` and this module's
 * sibling `pairing-route-scopes.ts` for that distinction.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

export interface DiscoveredLeafRoute {
  readonly method: string;
  readonly path: string;
  /** Absolute source file the leaf was found in — for guard failure messages. */
  readonly file: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/**
 * `app.all(...)` (station#1131 review round 1: `plugin-public-routes.ts`'s
 * `/:name/*` plugin-server forwarding catch-all) matches every method, but
 * this scan's declaration schema is per-CONCRETE-method (same as
 * `PAIRING_SCOPE_FAMILY_INHERITED_LEAVES` and the real runtime request path
 * `requiredPairingScope` resolves for) — there is no single scope a `'*'`
 * probe could resolve to that means anything against the family's own
 * per-method read/mutate split. So an `.all(...)` registration is expanded
 * into one discovered leaf per method in this list, exactly as if the
 * source had separately called `.get(...)`, `.post(...)`, etc. on the same
 * path — each needs (and, for this specific route, has) its own considered
 * declaration.
 */
const ALL_METHOD_EXPANSION = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
] as const;

function readSource(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Local name -> resolved absolute .ts file, from a source file's own relative imports. */
function buildImportMap(
  sourceFile: string,
  source: string,
): Map<string, string> {
  const map = new Map<string, string>();
  const dir = dirname(sourceFile);
  const importRe =
    /import\s+(?:type\s+)?(?:\{([^}]+)\}|([A-Za-z0-9_$]+))\s*(?:,\s*\{([^}]+)\})?\s+from\s+['"]([^'"]+)['"]/g;
  const addNamed = (block: string | undefined, resolved: string) => {
    if (!block) return;
    for (const part of block.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const cleaned = trimmed.replace(/^type\s+/, '');
      const asMatch = cleaned.match(
        /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/,
      );
      const localName = asMatch ? asMatch[2] : cleaned;
      map.set(localName, resolved);
    }
  };
  for (const m of source.matchAll(importRe)) {
    const rawPath = m[4];
    const resolved = rawPath.startsWith('.')
      ? join(dir, `${rawPath.replace(/\.js$/, '')}.ts`)
      : rawPath.startsWith('@kontourai/station-contracts/')
        ? join(
            process.cwd(),
            'packages/contracts/src',
            `${rawPath.slice('@kontourai/station-contracts/'.length)}.ts`,
          )
        : undefined;
    if (!resolved) continue;
    addNamed(m[1], resolved);
    addNamed(m[3], resolved);
    if (m[2]) map.set(m[2], resolved);
  }
  return map;
}

/** `const NAME = FACTORY(` local-alias map. */
function buildLocalAliasMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /const\s+([A-Za-z0-9_$]+)\s*=\s*([A-Za-z0-9_$]+)\(/g;
  for (const m of source.matchAll(re)) map.set(m[1], m[2]);
  return map;
}

/** Extracts a named function declaration's body using TypeScript AST locations. */
function extractFunctionBody(
  source: string,
  functionName: string,
): string | undefined {
  const sourceFile = ts.createSourceFile(
    'pairing-route-function.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let body: ts.Block | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !body &&
      ts.isFunctionDeclaration(node) &&
      node.name?.text === functionName &&
      node.body
    ) {
      body = node.body;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return body ? source.slice(body.getStart(sourceFile), body.end) : undefined;
}

/** Hono's own base+leaf join: `''`/`'/'` leaf means "the base itself". */
function composePath(base: string, leaf: string): string {
  const normalizedBase = base === '/' ? '' : base;
  if (leaf === '/' || leaf === '')
    return normalizedBase === '' ? '/' : normalizedBase;
  return `${normalizedBase}${leaf}`;
}

interface ScanState {
  readonly leaves: DiscoveredLeafRoute[];
  readonly visited: Set<string>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `source` binds `varName` to a fresh `new Hono(...)` instance
 * (`const app = new Hono()`, optionally with generic type args). This is
 * the narrow signal the composition-helper pattern (station#1131 review
 * round 1) keys on: `varName` being passed to a sibling
 * `register*Routes`/`configure*Routes` call only counts as "attach routes
 * to the app we're scanning" when it's genuinely a locally-owned Hono app,
 * not an inherited property access like `context.app` — see this module's
 * docblock point 5 for why that keeps `configureDevicePairingHostRoutes`
 * out of scope, deliberately.
 */
function isLocalHonoBinding(source: string, varName: string): boolean {
  const re = new RegExp(
    `const\\s+${escapeRegExp(varName)}\\s*=\\s*new\\s+Hono\\s*(?:<[^>]*>)?\\s*\\(`,
  );
  return re.test(source);
}

const REGISTRATION_HELPER_NAME_RE = /^(register|configure)[A-Za-z0-9_]*Routes$/;

/**
 * Textually unrolls `for (const X of ['a', 'b'] as const) { ... }` blocks
 * whose body references `${X}` inside a template-literal route path (e.g.
 * `plugin-host-approval-routes.ts`'s per-decision approve/deny routes), so
 * the method/path regexes below see two concrete literal registrations
 * instead of one unevaluated `${decision}` placeholder. Only handles this
 * exact shape (a `for...of` over an inline string-literal array) — anything
 * more dynamic is left as-is, which will surface as literal `${...}` text
 * in a discovered leaf's path rather than silently vanishing, so it stays
 * visible (if ugly) rather than a silent gap.
 */
function unrollSimpleForLoops(source: string): string {
  const forRe =
    /for\s*\(\s*const\s+([A-Za-z0-9_$]+)\s+of\s+\[([^\]]*)\]\s*(?:as\s+const\s*)?\)\s*\{/g;
  let result = source;
  for (let guard = 0; guard < 20; guard++) {
    forRe.lastIndex = 0;
    const match = forRe.exec(result);
    if (!match) break;
    const varName = match[1];
    const items = [...match[2].matchAll(/'([^']*)'|"([^"]*)"/g)].map(
      (m) => m[1] ?? m[2],
    );
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < result.length; i++) {
      if (result[i] === '{') depth++;
      else if (result[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (items.length === 0 || end === -1) {
      // Can't safely unroll (non-literal items, or unbalanced braces) —
      // stop trying to unroll ANY loop rather than risk mis-splicing; the
      // raw `${varName}` text will show up literally in any leaf found
      // inside it, which is visible-but-ugly rather than silently missed.
      break;
    }
    const loopBody = result.slice(braceStart + 1, end);
    const expanded = items
      .map((item) => loopBody.split(`\${${varName}}`).join(item))
      .join('\n');
    result = result.slice(0, match.index) + expanded + result.slice(end + 1);
  }
  return result;
}

interface ParsedRouteMount {
  readonly base: string;
  readonly ident: string;
  readonly isCall: boolean;
}

interface ParsedLeafRoute {
  readonly method: string;
  readonly path: string;
}

function findStringConstant(source: string, name: string): string | undefined {
  const sourceFile = ts.createSourceFile(
    'pairing-route-constant.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let value: string | undefined;
  const stringInitializer = (expression: ts.Expression): string | undefined => {
    let current = expression;
    while (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
    }
    return ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
      ? current.text
      : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (
      value === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      value = stringInitializer(node.initializer);
      if (value !== undefined) return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return value;
}

/**
 * Enumerates executable direct Hono registrations with TypeScript's parser.
 * Every recognized method call counts, even when its path is dynamic or uses
 * an unsupported expression, so the caller can fail closed instead of silently
 * dropping a leaf. Comments and regex/string contents cannot affect parsing.
 */
function parseLeafRoutes(
  body: string,
  appVar: string,
  fileSource: string,
  importMap: ReadonlyMap<string, string>,
): {
  readonly leafCallCount: number;
  readonly parsedLeafCallCount: number;
  readonly leaves: ParsedLeafRoute[];
} {
  const sourceFile = ts.createSourceFile(
    'pairing-route-leaf-body.ts',
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const supportedMethods = new Set([...HTTP_METHODS, 'all']);
  const leaves: ParsedLeafRoute[] = [];
  let leafCallCount = 0;
  let parsedLeafCallCount = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      supportedMethods.has(
        node.expression.name.text as (typeof HTTP_METHODS)[number] | 'all',
      ) &&
      node.expression.expression.getText(sourceFile) === appVar
    ) {
      leafCallCount++;
      const [pathArg] = node.arguments;
      let path: string | undefined;
      if (
        pathArg &&
        (ts.isStringLiteral(pathArg) ||
          ts.isNoSubstitutionTemplateLiteral(pathArg))
      ) {
        path = pathArg.text;
      } else if (pathArg && ts.isIdentifier(pathArg)) {
        const importedFile = importMap.get(pathArg.text);
        path = findStringConstant(
          importedFile ? readSource(importedFile) : fileSource,
          pathArg.text,
        );
      }
      if (path !== undefined) {
        parsedLeafCallCount++;
        const methods =
          node.expression.name.text === 'all'
            ? ALL_METHOD_EXPANSION
            : [node.expression.name.text.toUpperCase()];
        for (const method of methods) leaves.push({ method, path });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { leafCallCount, parsedLeafCallCount, leaves };
}

/**
 * Uses TypeScript's parser to distinguish executable route calls from prose,
 * strings, and regex literals. Every executable `.route(...)` call counts;
 * only the factory/alias forms the recursive scanner understands are returned.
 * The caller compares those counts and fails closed on every other expression.
 */
function parseRouteMounts(
  body: string,
  appVar: string,
): { readonly routeCallCount: number; readonly mounts: ParsedRouteMount[] } {
  const sourceFile = ts.createSourceFile(
    'pairing-route-scan-body.ts',
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const mounts: ParsedRouteMount[] = [];
  let routeCallCount = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'route' &&
      node.expression.expression.getText(sourceFile) === appVar
    ) {
      routeCallCount++;
      const [baseArg, routerArg] = node.arguments;
      if (
        baseArg &&
        (ts.isStringLiteral(baseArg) ||
          ts.isNoSubstitutionTemplateLiteral(baseArg))
      ) {
        if (routerArg && ts.isIdentifier(routerArg)) {
          mounts.push({
            base: baseArg.text,
            ident: routerArg.text,
            isCall: false,
          });
        } else if (
          routerArg &&
          ts.isCallExpression(routerArg) &&
          ts.isIdentifier(routerArg.expression)
        ) {
          mounts.push({
            base: baseArg.text,
            ident: routerArg.expression.text,
            isCall: true,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { routeCallCount, mounts };
}

function scanBody(
  body: string,
  sourceFile: string,
  fileSource: string,
  appVar: string,
  base: string,
  state: ScanState,
  depth: number,
): void {
  if (depth > 10) {
    throw new Error(
      `pairing-route-leaf-scan: recursion exceeded 10 levels at ${sourceFile} (base ${base}) — likely a mount cycle`,
    );
  }
  body = unrollSimpleForLoops(body);
  const escapedAppVar = escapeRegExp(appVar);
  const importMap = buildImportMap(sourceFile, fileSource);
  const { leafCallCount, parsedLeafCallCount, leaves } = parseLeafRoutes(
    body,
    appVar,
    fileSource,
    importMap,
  );
  if (parsedLeafCallCount < leafCallCount) {
    throw new Error(
      `pairing-route-leaf-scan: parsed ${parsedLeafCallCount} of ${leafCallCount} ` +
        `direct route registrations in ${sourceFile} (base ${base || '/'}). A path ` +
        'shape the scanner cannot parse would leave a leaf outside the pairing-scope guard.',
    );
  }
  for (const leaf of leaves) {
    state.leaves.push({
      method: leaf.method,
      path: composePath(base, leaf.path),
      file: sourceFile,
    });
  }

  const aliasMap = buildLocalAliasMap(body);
  const { routeCallCount, mounts } = parseRouteMounts(body, appVar);
  if (mounts.length < routeCallCount) {
    throw new Error(
      `pairing-route-leaf-scan: parsed ${mounts.length} of ${routeCallCount} ` +
        `route(...) mounts in ${sourceFile} (base ${base || '/'}). A mount shape ` +
        'the scanner cannot parse would leave its leaves outside the pairing-scope guard.',
    );
  }
  for (const mount of mounts) {
    const nestedBase = composePath(base, mount.base);
    let { ident, isCall } = mount;
    if (!isCall && aliasMap.has(ident)) {
      ident = aliasMap.get(ident)!;
      isCall = true;
    }
    const targetFile = importMap.get(ident);
    if (!targetFile) {
      throw new Error(
        `pairing-route-leaf-scan: could not resolve "${ident}" imported/aliased in ${sourceFile} ` +
          `(mount base "${nestedBase}") to a source file — the scan's import resolution needs ` +
          'extending for this pattern, or this mount needs its own explicit coverage assertion ' +
          '(mirroring PAIRING_SCOPE_CATCH_ALL_MOUNT_EXCEPTIONS in pairing-route-scopes.ts).',
      );
    }
    const key = `${targetFile}::${ident}::${nestedBase}`;
    if (state.visited.has(key)) continue;
    state.visited.add(key);
    const targetSource = readSource(targetFile);
    const targetBody = isCall
      ? extractFunctionBody(targetSource, ident)
      : undefined;
    scanBody(
      targetBody ?? targetSource,
      targetFile,
      targetSource,
      'app',
      nestedBase,
      state,
      depth + 1,
    );
  }

  // Composition-helper pattern (station#1131 review round 1, HIGH): only
  // fires for a bare (dot-free) appVar that this exact file genuinely binds
  // via `const <appVar> = new Hono(...)` — see the module docblock's point 5
  // for exactly why `context.app` (the top-level scan, and
  // `configureDevicePairingHostRoutes(context.app, ...)`) never matches
  // this and stays a disclosed, hand-audited exception instead.
  if (!appVar.includes('.') && isLocalHonoBinding(fileSource, appVar)) {
    const registerRe = new RegExp(
      `\\b([A-Za-z0-9_$]+)\\(\\s*${escapedAppVar}\\s*(?:,|\\))`,
      'g',
    );
    for (const m of body.matchAll(registerRe)) {
      const ident = m[1];
      if (!REGISTRATION_HELPER_NAME_RE.test(ident)) continue;
      const importedFile = importMap.get(ident);
      const localBody = importedFile
        ? undefined
        : extractFunctionBody(fileSource, ident);
      if (!importedFile && !localBody) {
        throw new Error(
          `pairing-route-leaf-scan: "${ident}(${appVar}, ...)" in ${sourceFile} matches the ` +
            'register*Routes/configure*Routes composition-helper naming convention but is ' +
            "neither imported (checked this file's import map) nor declared in this file — " +
            "the scan's resolution needs extending for this shape, or this call needs its own " +
            'explicit coverage assertion (mirroring PAIRING_SCOPE_CATCH_ALL_MOUNT_EXCEPTIONS ' +
            'in pairing-route-scopes.ts).',
        );
      }
      const resolvedFile = importedFile ?? sourceFile;
      const key = `${resolvedFile}::${ident}::${base}`;
      if (state.visited.has(key)) continue;
      state.visited.add(key);
      const targetSource = importedFile ? readSource(importedFile) : fileSource;
      const targetBody = importedFile
        ? (extractFunctionBody(targetSource, ident) ?? targetSource)
        : (localBody ?? targetSource);
      scanBody(
        targetBody,
        resolvedFile,
        targetSource,
        'app',
        base,
        state,
        depth + 1,
      );
    }
  }
}

/**
 * Walks `configureRuntimeRoutes` (or `entryFunction`, for a fixture) in
 * `runtimeRoutesPath` and returns every authenticated HTTP leaf reachable
 * through the `context.app.route(...)` / `context.app.<method>(...)`
 * calling convention. See this module's docblock for exactly what is and
 * is not followed.
 */
export function scanRegisteredLeafRoutes(
  runtimeRoutesPath: string,
  entryFunction = 'configureRuntimeRoutes',
): DiscoveredLeafRoute[] {
  const source = readSource(runtimeRoutesPath);
  const body = extractFunctionBody(source, entryFunction);
  if (!body) {
    throw new Error(
      `pairing-route-leaf-scan: could not find function "${entryFunction}" in ${runtimeRoutesPath}`,
    );
  }
  const state: ScanState = { leaves: [], visited: new Set() };
  scanBody(body, runtimeRoutesPath, source, 'context.app', '', state, 0);
  return state.leaves;
}
