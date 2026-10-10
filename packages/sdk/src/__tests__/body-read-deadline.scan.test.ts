/**
 * #2377 C2b review, the structural half of
 * `body-read-deadline-coverage.test.ts` (a structural rule, proved
 * structurally). It walks the SDK source tree, so it runs as a repo scan
 * (`REPO_SCAN_SUITES`).
 *
 * The rule, read from the TypeScript syntax tree (so string and regex
 * literals, type annotations and formatting cannot hide a site):
 *
 * - A `try` whose block reads a response body (`.json()`, `.text()`,
 *   `.arrayBuffer()`, `.blob()`, `.formData()`, `.bytes()`) and does not also
 *   issue the request has a `catch` that binds the error, and whose first
 *   statement either passes a request deadline on (`rethrowDeadline(e)`) or
 *   maps it to the site's own typed error
 *   (`if (e instanceof StationRequestTimeoutError) throw ...`). A handler
 *   without a binding, or with a destructuring one, FAILS: it cannot pass the
 *   error on, so the scan never skips it.
 * - A `.catch(...)` anywhere on a chain that reads a body (including
 *   `.text().then(...).catch(...)`) takes `unlessDeadline(...)`.
 *
 * - A `try` that also issues the request wraps the whole exchange in its own
 *   error; its handler's first statement must not swallow the failure
 *   (`rethrowDeadline`, `if (e instanceof X) throw ...`, or `throw`), unless
 *   the site is named in `ALLOWED_FALLBACKS` with a reason.
 *
 * The scanner is exercised against inline fixtures first, so the repository
 * assertion is not the only thing holding it up, and the repository result
 * is pinned by the identity of sites it must find, not by a count.
 *
 * Known limits, not solved here: a body read inside a helper or a callback
 * the try only calls (other than a `.then` callback on the `.catch` chain); a
 * reader bound or stored first (`const read = r.json.bind(r)`), or a body
 * promise stored and caught later; the two-argument `.then(ok, fail)` form;
 * and a typed wrap whose `throw` follows another statement in the `if`
 * block, which is accepted without checking what that statement does.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript-api';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../', import.meta.url).pathname;
const READERS = new Set([
  'json',
  'text',
  'arrayBuffer',
  'blob',
  'formData',
  'bytes',
]);
const ISSUES = new Set([
  'getJson',
  'mutateJson',
  'request',
  'fetch',
  'authenticatedFetch',
  'postJson',
]);

interface Site {
  /** `file:line`, for the failure message. */
  where: string;
  /** The nearest named enclosing function, for identity pins. */
  owner: string;
  guarded: boolean;
  /**
   * `try`: a body read only; `request`: a try that also issues the request;
   * `chain`: a `.catch` on a body-reading chain.
   */
  kind: 'try' | 'request' | 'chain';
}

function calledName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function isBodyRead(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    READERS.has(node.expression.name.text)
  );
}

function contains(node: ts.Node, test: (child: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (test(child)) {
      found = true;
      return;
    }
    // A nested function is its own scope: its body reads are its own sites.
    if (ts.isFunctionLike(child)) return;
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** `contains`, but descending into a function's own body. */
function containsInFunction(
  fn: ts.Node,
  test: (child: ts.Node) => boolean,
): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (test(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(fn, visit);
  return found;
}

function issuesRequest(node: ts.Node): boolean {
  return contains(
    node,
    (child) =>
      ts.isCallExpression(child) && ISSUES.has(calledName(child) ?? ''),
  );
}

/** Whether the handler's first statement passes a deadline on, or types it. */
function guardsDeadline(clause: ts.CatchClause): boolean {
  const binding = clause.variableDeclaration?.name;
  if (!binding || !ts.isIdentifier(binding)) return false;
  const name = binding.text;
  const first = clause.block.statements[0];
  if (!first) return false;
  if (
    ts.isExpressionStatement(first) &&
    ts.isCallExpression(first.expression) &&
    calledName(first.expression) === 'rethrowDeadline'
  ) {
    const [argument] = first.expression.arguments;
    return (
      argument !== undefined &&
      ts.isIdentifier(argument) &&
      argument.text === name
    );
  }
  if (ts.isIfStatement(first)) {
    const condition = first.expression;
    const throws =
      ts.isThrowStatement(first.thenStatement) ||
      (ts.isBlock(first.thenStatement) &&
        first.thenStatement.statements.some((statement) =>
          ts.isThrowStatement(statement),
        ));
    return (
      throws &&
      ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(condition.left) &&
      condition.left.text === name &&
      ts.isIdentifier(condition.right) &&
      condition.right.text === 'StationRequestTimeoutError'
    );
  }
  return false;
}

/**
 * A try that issues the request as well as reading the body wraps the whole
 * exchange in its own error, so its handler may type anything as long as it
 * does not SWALLOW the failure: its first statement passes a deadline on
 * (`rethrowDeadline`), throws when the error is of some type
 * (`if (e instanceof X) throw ...`), or throws outright.
 */
function wrapsWholeRequest(clause: ts.CatchClause): boolean {
  if (guardsDeadline(clause)) return true;
  const binding = clause.variableDeclaration?.name;
  const name = binding && ts.isIdentifier(binding) ? binding.text : undefined;
  const first = clause.block.statements[0];
  if (!first) return false;
  if (ts.isThrowStatement(first)) return true;
  if (!name || !ts.isIfStatement(first)) return false;
  const condition = first.expression;
  const throws =
    ts.isThrowStatement(first.thenStatement) ||
    (ts.isBlock(first.thenStatement) &&
      first.thenStatement.statements.some((statement) =>
        ts.isThrowStatement(statement),
      ));
  return (
    throws &&
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    ts.isIdentifier(condition.left) &&
    condition.left.text === name
  );
}

/**
 * Sites that deliberately do not type or pass on a failure, each with its
 * reason. Keyed `file#owner`; a key that no longer names a site fails the
 * repository test, so the list cannot go stale.
 */
const ALLOWED_FALLBACKS: ReadonlyMap<string, string> = new Map([
  [
    'eventStreamResumeCapability.ts#fetchEventStreamResumeCapability',
    'capability probe: any failure, a deadline included, means "not supported" (unchanged)',
  ],
  [
    'sessionEventWindowCapability.ts#fetchSessionEventWindowCapability',
    'capability probe: any failure, a deadline included, means "unknown" (unchanged)',
  ],
  [
    'client/attachment-staging.ts#getAttachmentStagingCapability',
    'capability probe: a failed legacy handshake means "unknown" (unchanged)',
  ],
  [
    'api-agent-runtime.ts#sendMessage',
    'raw global fetch with no SDK deadline; its catch records telemetry and rethrows',
  ],
  [
    'api-agent-runtime.ts#callTool',
    'raw global fetch with no SDK deadline; its catch records telemetry and rethrows',
  ],
  [
    'hooks/operations.ts#useUserLookup',
    'raw global fetch with no SDK deadline; the hook shows any failure as its error',
  ],
]);

function isAllowedFallback(key: string): boolean {
  return ALLOWED_FALLBACKS.has(key);
}

/** Whether a `.catch` call's receiver chain reads a body. */
function chainReadsBody(expression: ts.Expression): boolean {
  let node: ts.Expression = expression;
  for (;;) {
    if (isBodyRead(node)) return true;
    // `x.then((r) => r.json())`: the callback reads the body.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'then' &&
      node.arguments.some(
        (argument) =>
          ts.isFunctionLike(argument) &&
          (isBodyRead(argument) || containsInFunction(argument, isBodyRead)),
      )
    )
      return true;
    if (ts.isCallExpression(node)) node = node.expression;
    else if (ts.isPropertyAccessExpression(node)) node = node.expression;
    else if (ts.isParenthesizedExpression(node)) node = node.expression;
    else if (ts.isAwaitExpression(node)) node = node.expression;
    else return false;
  }
}

function ownerOf(node: ts.Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) &&
      parent.name
    )
      return parent.name.getText();
    if (
      ts.isVariableDeclaration(parent) &&
      ts.isIdentifier(parent.name) &&
      parent.initializer &&
      (ts.isArrowFunction(parent.initializer) ||
        ts.isFunctionExpression(parent.initializer))
    )
      return parent.name.text;
  }
  return '<module>';
}

function scanSource(text: string, file: string): Site[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const sites: Site[] = [];
  const where = (node: ts.Node) =>
    `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node) => {
    if (
      ts.isTryStatement(node) &&
      node.catchClause &&
      contains(node.tryBlock, isBodyRead)
    ) {
      const request = issuesRequest(node.tryBlock);
      const owner = ownerOf(node);
      sites.push({
        where: where(node),
        owner,
        guarded:
          (request
            ? wrapsWholeRequest(node.catchClause)
            : guardsDeadline(node.catchClause)) ||
          isAllowedFallback(`${file}#${owner}`),
        kind: request ? 'request' : 'try',
      });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'catch' &&
      chainReadsBody(node.expression.expression)
    ) {
      const [handler] = node.arguments;
      const owner = ownerOf(node);
      sites.push({
        where: where(node),
        owner,
        guarded:
          (handler !== undefined &&
            ts.isCallExpression(handler) &&
            calledName(handler) === 'unlessDeadline') ||
          isAllowedFallback(`${file}#${owner}`),
        kind: 'chain',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('the body-read scanner (fixtures)', () => {
  const one = (text: string) => scanSource(text, 'fixture.ts');

  it('flags an unguarded catch and accepts the shared guard', () => {
    expect(
      one(`async function f(r: Response) {
        try { return await r.json(); } catch (error) { return undefined; }
      }`),
    ).toMatchObject([{ guarded: false, kind: 'try', owner: 'f' }]);
    expect(
      one(`async function f(r: Response) {
        try { return await r.json(); } catch (error) { rethrowDeadline(error); return undefined; }
      }`),
    ).toMatchObject([{ guarded: true }]);
  });

  it('accepts a typed wrap of the deadline as the first statement', () => {
    expect(
      one(`async function f(r: Response) {
        try { return await r.json(); } catch (cause) {
          if (cause instanceof StationRequestTimeoutError) throw typed(cause);
          throw cause;
        }
      }`),
    ).toMatchObject([{ guarded: true }]);
    // An instanceof test that does not throw is not a guard.
    expect(
      one(`async function f(r: Response) {
        try { return await r.json(); } catch (cause) {
          if (cause instanceof StationRequestTimeoutError) log(cause);
          return undefined;
        }
      }`),
    ).toMatchObject([{ guarded: false }]);
  });

  it('sees through a type annotation, and fails a handler it cannot guard', () => {
    expect(
      one(`async function f(r: Response) {
        try { return await r.text(); } catch (error: unknown) { return ''; }
      }`),
    ).toMatchObject([{ guarded: false }]);
    expect(
      one(`async function f(r: Response) {
        try { return await r.text(); } catch (error: unknown) { rethrowDeadline(error); return ''; }
      }`),
    ).toMatchObject([{ guarded: true }]);
    expect(
      one(`async function f(r: Response) {
        try { return await r.json(); } catch { return undefined; }
      }`),
    ).toMatchObject([{ guarded: false }]);
    expect(
      one(`async function f(r: Response) {
        try { return await r.json(); } catch ({ message }) { return message; }
      }`),
    ).toMatchObject([{ guarded: false }]);
  });

  it('is not fooled by braces in strings or regex literals', () => {
    expect(
      one(`async function f(r: Response) {
        const brace = '}'; const re = /\\{/;
        try { return await r.json(); } catch (error) { return '{'; }
      }`),
    ).toMatchObject([{ guarded: false }]);
  });

  it('holds a catch that also covers the request to typing or rethrowing', () => {
    expect(
      one(`async function f() {
        try { const r = await getJson('/x'); return await r.json(); } catch (error) { throw typed(error); }
      }`),
    ).toMatchObject([{ guarded: true, kind: 'request' }]);
    expect(
      one(`async function f() {
        try { const r = await getJson('/x'); return await r.json(); } catch (error) {
          if (error instanceof MyError) throw error;
          throw new MyError(0);
        }
      }`),
    ).toMatchObject([{ guarded: true, kind: 'request' }]);
    // A request-plus-read catch that swallows the failure is flagged.
    expect(
      one(`async function f() {
        try { const r = await getJson('/x'); return await r.json(); } catch (error) { return undefined; }
      }`),
    ).toMatchObject([{ guarded: false, kind: 'request' }]);
  });

  it('flags every .catch on a body-reading chain, .then included', () => {
    expect(
      one(`async function f(r: Response) {
        return r.json().catch(() => undefined);
      }`),
    ).toMatchObject([{ guarded: false, kind: 'chain' }]);
    expect(
      one(`async function f(r: Response) {
        return r.text().then((t) => t.trim()).catch(() => undefined);
      }`),
    ).toMatchObject([{ guarded: false, kind: 'chain' }]);
    expect(
      one(`async function f(r: Response) {
        return r.text().then((t) => t.trim()).catch(unlessDeadline(() => undefined));
      }`),
    ).toMatchObject([{ guarded: true, kind: 'chain' }]);
  });

  it('sees a body read inside a .then callback', () => {
    expect(
      one(`async function f(p: Promise<Response>) {
        return p.then((r) => r.json()).catch(() => undefined);
      }`),
    ).toMatchObject([{ guarded: false, kind: 'chain' }]);
    expect(
      one(`async function f(p: Promise<Response>) {
        return p.then(async (r) => { return await r.text(); }).catch(unlessDeadline(() => undefined));
      }`),
    ).toMatchObject([{ guarded: true, kind: 'chain' }]);
  });
});

describe('every SDK body-read catch passes a deadline on', () => {
  const sites = sources(SRC).flatMap((file) =>
    scanSource(readFileSync(file, 'utf8'), relative(SRC, file)),
  );

  it('finds the sites it must find (identity, not a count)', () => {
    const owners = new Set(
      sites.map((site) => `${site.where.split(':')[0]}#${site.owner}`),
    );
    for (const pin of [
      'client/http.ts#readEnvelopeOrThrow',
      'client/http.ts#readJsonBody',
      'query-domains/chatRuntimeOrchestration.ts#adoptOrchestrationSession',
      'conversation-open.ts#resolveConversationOpen',
    ])
      expect(owners, pin).toContain(pin);
  });

  it('names only sites that exist in its allowlist', () => {
    const owners = new Set(
      sites.map((site) => `${site.where.split(':')[0]}#${site.owner}`),
    );
    expect(
      [...ALLOWED_FALLBACKS.keys()].filter((key) => !owners.has(key)),
    ).toEqual([]);
  });

  it('holds every one of them to the guard', () => {
    expect(
      sites.filter((site) => !site.guarded).map((site) => site.where),
    ).toEqual([]);
  });
});
