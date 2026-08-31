import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Route-catch `errorMessage()` is the shared sanitized boundary. Direct
 * `.message` serialization is permitted only for the reviewed typed-result
 * expressions below. The identity includes the file, enclosing route or
 * function, and member expression so one safe occurrence cannot silently
 * authorize an unrelated one in the same file.
 */
export const REVIEWED_DIRECT_ROUTE_MESSAGE_EGRESS = new Set([
  'src-server/routes/agents/skills.ts :: route POST / :: result.message :: 1',
  'src-server/routes/agents/skills.ts :: route POST /local :: result.message :: 1',
  'src-server/routes/agents/skills.ts :: route PUT /:name :: result.message :: 1',
  'src-server/routes/agents/skills.ts :: route DELETE /:name :: result.message :: 1',
  'src-server/routes/agents/tools.ts :: route POST /:serverId/ui/call :: error.message :: 1',
  'src-server/routes/agents/unattended-grants-routes.ts :: route POST / :: error.message :: 1',
  'src-server/routes/agents/unattended-grants-routes.ts :: route POST /revoke :: error.message :: 1',
  'src-server/routes/chat/conversations.ts :: function conversationRouteFailure :: error.message :: 1',
  // #1000 (ACP provider routing). Both surface a TYPED Station domain error
  // whose message is authored here, not an upstream or system string:
  // ACPProviderRouteValidationError carries one of three fixed sentences
  // (observation_required / provider_not_found / protocol_unsupported) and
  // ACPRequiredProviderDisableError one more. The only interpolated value is
  // the caller's own providerId, echoed back to an authenticated caller.
  'src-server/routes/connections/acp.ts :: route POST /connections/:id/providers/set :: error.message :: 1',
  'src-server/routes/connections/acp.ts :: route POST /connections/:id/providers/disable :: (error as Error).message :: 1',
  'src-server/routes/knowledge/knowledge-index-routes.ts :: route POST /index/rebuild :: e.message :: 1',
  'src-server/routes/knowledge/knowledge-index-routes.ts :: route POST /migrate :: e.message :: 1',
  'src-server/routes/plugins/plugin-config-routes.ts :: route GET /:name/settings :: error.message :: 1',
  'src-server/routes/plugins/plugin-config-routes.ts :: route GET /:name/providers :: error.message :: 1',
  'src-server/routes/plugins/plugin-install-routes.ts :: route POST /preview :: error.message :: 1',
  'src-server/routes/plugins/plugin-install-routes.ts :: route POST /install :: error.message :: 1',
  'src-server/routes/plugins/plugin-lifecycle-routes.ts :: route POST /:name/update :: registryOwner.message :: 1',
  'src-server/routes/plugins/plugin-lifecycle-routes.ts :: route POST /:name/update :: registryOwner.message :: 2',
  'src-server/routes/plugins/plugin-lifecycle-routes.ts :: route POST /:name/update :: error.message :: 1',
  'src-server/routes/plugins/plugin-lifecycle-routes.ts :: route DELETE /:name :: error.message :: 1',
  'src-server/routes/projects/projects.ts :: route PUT /:slug/layouts/:layoutSlug :: validLayout.error.issues[0]?.message :: 1',
  'src-server/routes/share/answer-share-routes.ts :: route POST / :: error.message :: 1',
  'src-server/routes/share/answer-share-routes.ts :: route DELETE /:shareId :: error.message :: 1',
  'src-server/routes/system/config.ts :: route PUT /app :: v.message :: 1',
]);

const TRANSPORT_AND_DIAGNOSTIC_BOUNDARIES = [
  'src-server/runtime/conversation/stream-orchestrator.ts',
  'src-server/services/terminal/terminal-ws-server.ts',
  'src-server/voice/voice-session.ts',
  'src-server/runtime/mcp/mcp-ui-frame-server.ts',
];

function listSourceFiles(rootDir, directory) {
  const absoluteDirectory = join(rootDir, directory);
  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (['dist', 'node_modules', '__tests__'].includes(entry.name)) continue;
    const relativePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(rootDir, relativePath));
    } else if (
      /\.(cts|mts|ts|tsx)$/.test(entry.name) &&
      !/\.test\./.test(entry.name)
    ) {
      files.push(relativePath);
    }
  }
  return files;
}

function routeOrFunctionIdentity(node, sourceFile) {
  for (let current = node; current; current = current.parent) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression)
    ) {
      const method = current.expression.name.text.toUpperCase();
      const [path] = current.arguments;
      if (
        ['get', 'post', 'put', 'patch', 'delete', 'all', 'on'].includes(
          current.expression.name.text,
        ) &&
        ts.isStringLiteralLike(path)
      ) {
        return `route ${method} ${path.text}`;
      }
    }
    if (ts.isFunctionDeclaration(current) && current.name) {
      return `function ${current.name.text}`;
    }
    if (ts.isMethodDeclaration(current) && current.name) {
      return `method ${current.name.getText(sourceFile)}`;
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return `function ${current.parent.name.text}`;
    }
  }
  return 'module';
}

function isDirectResponseCall(node, sourceFile, contextAliases) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    contextAliases.has(node.expression.expression.getText(sourceFile)) &&
    ['json', 'text'].includes(node.expression.name.text)
  );
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isRouteRegistration(node, sourceFile, honoRoots) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression)
  ) {
    return false;
  }
  return (
    honoRoots.has(node.expression.expression.getText(sourceFile)) &&
    ['get', 'post', 'put', 'patch', 'delete', 'all', 'on'].includes(
      node.expression.name.text,
    )
  );
}

/**
 * Discover Hono roots and the Context aliases introduced by their handlers.
 * This deliberately follows bindings rather than assuming every route root is
 * called `app` or every Context is called `c`; otherwise a renamed production
 * router silently falls outside the egress review boundary.
 */
function collectHonoContextAliases(sourceFile) {
  const honoRoots = new Set();
  // `c` remains the conventional Hono Context name, while the remaining
  // aliases below make renamed roots/context variables equally reviewable.
  const contextAliases = new Set(['c']);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const initializer =
          node.initializer && unwrapExpression(node.initializer);
        if (
          initializer &&
          ts.isNewExpression(initializer) &&
          initializer.expression.getText(sourceFile) === 'Hono' &&
          !honoRoots.has(node.name.text)
        ) {
          honoRoots.add(node.name.text);
          changed = true;
        }
        if (
          initializer &&
          ts.isIdentifier(initializer) &&
          honoRoots.has(initializer.text) &&
          !honoRoots.has(node.name.text)
        ) {
          honoRoots.add(node.name.text);
          changed = true;
        }
        if (
          initializer &&
          ts.isIdentifier(initializer) &&
          contextAliases.has(initializer.text) &&
          !contextAliases.has(node.name.text)
        ) {
          contextAliases.add(node.name.text);
          changed = true;
        }
      }
      if (
        ts.isParameter(node) &&
        ts.isIdentifier(node.name) &&
        node.type?.getText(sourceFile).includes('Hono') &&
        !honoRoots.has(node.name.text)
      ) {
        honoRoots.add(node.name.text);
        changed = true;
      }
      // Runtime assembly commonly receives its Hono root as `context.app`
      // rather than constructing one locally. Treat that binding as a route
      // root too, so a runtime route cannot silently fall outside review.
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === 'app' &&
        ts.isIdentifier(node.expression) &&
        !honoRoots.has(node.getText(sourceFile))
      ) {
        honoRoots.add(node.getText(sourceFile));
        changed = true;
      }
      if (isRouteRegistration(node, sourceFile, honoRoots)) {
        for (const argument of node.arguments) {
          if (
            (ts.isArrowFunction(argument) ||
              ts.isFunctionExpression(argument)) &&
            argument.parameters[0] &&
            ts.isIdentifier(argument.parameters[0].name) &&
            !contextAliases.has(argument.parameters[0].name.text)
          ) {
            contextAliases.add(argument.parameters[0].name.text);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return contextAliases;
}

function isTransportOrDurableDiagnosticCall(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression)
  ) {
    return false;
  }
  const method = node.expression.name.text;
  return (
    // `send` and `write` cover WebSocket aliases, SSE writers, and child
    // process streams. Their receiver binding is intentionally irrelevant:
    // an unknown sink must not become an unreviewed escape hatch.
    ['send', 'write'].includes(method) ||
    // Console and logger calls are durable/operator-facing diagnostic sinks.
    ['error', 'warn'].includes(method)
  );
}

const SAFE_ERROR_BOUNDARIES = new Set([
  'sanitizedTransportError',
  'sanitizeError',
  'sanitizeFreeText',
  'errorMessage',
  'outwardTransportError',
  'outwardTransportFailure',
]);

/**
 * Resolve taint lexically, rooted in every actual `catch` binding. This is
 * deliberately independent of spelling: `catch (failure)`, `catch (thrown)`,
 * and nested catches are all untrusted. Assignments are recorded in their
 * containing scope and only affect later expressions, preventing a safe local
 * name elsewhere from laundering a caught value into a transport sink.
 */
function collectTaintedErrorBindings(sourceFile) {
  const scopeForNode = new WeakMap();
  const rootScope = { parent: undefined, bindings: new Map() };

  const addBinding = (scope, name, position, expression, rawName) => {
    const entries = scope.bindings.get(name) ?? [];
    entries.push({ position, expression, rawName });
    scope.bindings.set(name, entries);
  };
  const findBindingScope = (scope, name) => {
    for (let current = scope; current; current = current.parent) {
      if (current.bindings.has(name)) return current;
    }
    return undefined;
  };
  const isErrorCallbackParameter = (parameter, callback) => {
    const callbackCall = callback.parent;
    const typedAsError = parameter.type?.getText(sourceFile).match(/\bError\b/);
    if (typedAsError) return true;
    if (!ts.isCallExpression(callbackCall)) return false;
    if (!ts.isPropertyAccessExpression(callbackCall.expression)) return false;
    const method = callbackCall.expression.name.text;
    const firstArgument = callbackCall.arguments[0];
    return (
      ['on', 'once', 'addListener'].includes(method) &&
      ts.isStringLiteralLike(firstArgument) &&
      firstArgument.text === 'error'
    );
  };
  const record = (node, scope) => {
    scopeForNode.set(node, scope);
    let childScope = scope;
    if (ts.isCatchClause(node) || ts.isBlock(node) || ts.isFunctionLike(node)) {
      childScope = { parent: scope, bindings: new Map() };
      if (
        ts.isCatchClause(node) &&
        node.variableDeclaration &&
        ts.isIdentifier(node.variableDeclaration.name)
      ) {
        const name = node.variableDeclaration.name.text;
        addBinding(childScope, name, Number.NEGATIVE_INFINITY, undefined, name);
      }
      if (ts.isFunctionLike(node)) {
        for (const parameter of node.parameters) {
          if (
            ts.isIdentifier(parameter.name) &&
            isErrorCallbackParameter(parameter, node)
          ) {
            addBinding(
              childScope,
              parameter.name.text,
              Number.NEGATIVE_INFINITY,
              undefined,
              parameter.name.text,
            );
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      addBinding(childScope, node.name.text, node.pos, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const owner = findBindingScope(childScope, node.left.text) ?? childScope;
      addBinding(owner, node.left.text, node.pos, node.right);
    }
    ts.forEachChild(node, (child) => record(child, childScope));
  };
  record(sourceFile, rootScope);

  const fallbackAliases = new Map();
  const enclosingCatch = (node) => {
    for (let current = node; current; current = current.parent) {
      if (ts.isCatchClause(current)) return current;
    }
    return undefined;
  };
  const fallbackTaintAt = (identifier) => {
    const entries = fallbackAliases.get(identifier.text) ?? [];
    return [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.position <= identifier.pos &&
          entry.start <= identifier.pos &&
          identifier.end <= entry.end,
      )?.taint;
  };
  const directCatchTaint = (node) => {
    const unwrapped = unwrapExpression(node);
    if (ts.isIdentifier(unwrapped)) {
      for (let current = unwrapped.parent; current; current = current.parent) {
        if (
          ts.isCatchClause(current) &&
          current.variableDeclaration &&
          ts.isIdentifier(current.variableDeclaration.name) &&
          current.variableDeclaration.name.text === unwrapped.text
        ) {
          return unwrapped.text;
        }
      }
      return fallbackTaintAt(unwrapped);
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) &&
      unwrapped.name.text === 'message'
    ) {
      const taint = directCatchTaint(unwrapped.expression);
      return taint ? unwrapped.getText(sourceFile) : undefined;
    }
    if (
      ts.isCallExpression(unwrapped) &&
      ts.isIdentifier(unwrapped.expression) &&
      unwrapped.expression.text === 'String' &&
      unwrapped.arguments[0]
    ) {
      const taint = directCatchTaint(unwrapped.arguments[0]);
      return taint ? unwrapped.getText(sourceFile) : undefined;
    }
    return undefined;
  };
  const collectAliases = (node) => {
    const setAlias = (name, expression, node) => {
      const taint = directCatchTaint(expression);
      const owner = enclosingCatch(node);
      if (taint && owner) {
        const entries = fallbackAliases.get(name) ?? [];
        entries.push({
          position: node.pos,
          start: owner.block.pos,
          end: owner.block.end,
          taint,
        });
        fallbackAliases.set(name, entries);
      }
    };
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer) setAlias(node.name.text, node.initializer, node);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      setAlias(node.left.text, node.right, node);
    }
    ts.forEachChild(node, collectAliases);
  };
  ts.forEachChild(sourceFile, collectAliases);

  const taintOf = (node, resolving = new Set()) => {
    const unwrapped = unwrapExpression(node);
    if (ts.isIdentifier(unwrapped)) {
      for (let current = unwrapped.parent; current; current = current.parent) {
        if (
          ts.isCatchClause(current) &&
          current.variableDeclaration &&
          ts.isIdentifier(current.variableDeclaration.name) &&
          current.variableDeclaration.name.text === unwrapped.text
        ) {
          return unwrapped.text;
        }
      }
      const fallback = fallbackTaintAt(unwrapped);
      if (fallback) return fallback;
      const scope = scopeForNode.get(unwrapped) ?? rootScope;
      const bindingScope = findBindingScope(scope, unwrapped.text);
      if (!bindingScope) return undefined;
      const entries = bindingScope.bindings.get(unwrapped.text) ?? [];
      const entry = [...entries]
        .reverse()
        .find((candidate) => candidate.position <= unwrapped.pos);
      if (!entry || resolving.has(entry)) return undefined;
      if (entry.rawName) return entry.rawName;
      resolving.add(entry);
      const taint = entry.expression
        ? taintOf(entry.expression, resolving)
        : undefined;
      resolving.delete(entry);
      return taint;
    }
    if (
      ts.isPropertyAccessExpression(unwrapped) &&
      unwrapped.name.text === 'message' &&
      taintOf(unwrapped.expression, resolving)
    ) {
      return unwrapped.getText(sourceFile);
    }
    if (
      ts.isCallExpression(unwrapped) &&
      ts.isIdentifier(unwrapped.expression) &&
      unwrapped.expression.text === 'String' &&
      unwrapped.arguments[0] &&
      taintOf(unwrapped.arguments[0], resolving)
    ) {
      return unwrapped.getText(sourceFile);
    }
    if (ts.isTemplateExpression(unwrapped)) {
      for (const span of unwrapped.templateSpans) {
        const taint = taintOf(span.expression, resolving);
        if (taint) return `\${${span.expression.getText(sourceFile)}}`;
      }
    }
    return undefined;
  };
  return taintOf;
}

function isSafeErrorBoundary(node) {
  const unwrapped = unwrapExpression(node);
  return (
    ts.isCallExpression(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    SAFE_ERROR_BOUNDARIES.has(unwrapped.expression.text)
  );
}

/**
 * SSE, WebSocket, and MCP diagnostics have no raw-error exceptions. Their
 * messages cross a client boundary or become durable evidence, so an engine
 * error, CLI stderr, or foreign throw must use the shared generic envelope.
 */
export function findUnsafeTransportErrorEgress(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const findings = [];
  const taintOf = collectTaintedErrorBindings(sourceFile);
  const visit = (node) => {
    if (isTransportOrDurableDiagnosticCall(node)) {
      const scan = (candidate) => {
        if (isSafeErrorBoundary(candidate)) return;
        const coercion = taintOf(candidate);
        if (
          coercion &&
          !ts.isObjectLiteralExpression(candidate) &&
          !ts.isPropertyAssignment(candidate)
        ) {
          findings.push(
            `${file} :: ${routeOrFunctionIdentity(node, sourceFile)} :: ${coercion}`,
          );
          return;
        }
        if (ts.isObjectLiteralExpression(candidate)) {
          for (const property of candidate.properties) scan(property);
          return;
        }
        if (ts.isPropertyAssignment(candidate)) {
          scan(candidate.initializer);
          return;
        }
        if (ts.isShorthandPropertyAssignment(candidate)) {
          scan(candidate.name);
          return;
        }
        if (ts.isSpreadAssignment(candidate)) {
          scan(candidate.expression);
          return;
        }
        ts.forEachChild(candidate, scan);
      };
      for (const argument of node.arguments) scan(argument);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return findings;
}

export function collectTransportErrorEgressFindings({ rootDir }) {
  const findings = [];
  for (const file of TRANSPORT_AND_DIAGNOSTIC_BOUNDARIES) {
    const source = readFileSync(join(rootDir, file), 'utf8');
    for (const identity of findUnsafeTransportErrorEgress(source, file)) {
      findings.push(`Raw outward or durable error coercion: ${identity}.`);
    }
  }
  return findings;
}

export function collectTransportErrorEgressFindingsForSources(sources) {
  const findings = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const identity of findUnsafeTransportErrorEgress(source, file)) {
      findings.push(`Raw outward or durable error coercion: ${identity}.`);
    }
  }
  return findings;
}

export function findDirectRouteMessageEgress(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  const contextAliases = collectHonoContextAliases(sourceFile);
  const visit = (node) => {
    if (isDirectResponseCall(node, sourceFile, contextAliases)) {
      const scan = (candidate) => {
        if (
          ts.isPropertyAccessExpression(candidate) &&
          candidate.name.text === 'message'
        ) {
          found.push({
            file,
            scope: routeOrFunctionIdentity(node, sourceFile),
            expression: candidate.getText(sourceFile),
          });
        }
        ts.forEachChild(candidate, scan);
      };
      if (node.arguments[0]) scan(node.arguments[0]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  const occurrences = new Map();
  return found.map((entry) => {
    const base = `${entry.file} :: ${entry.scope} :: ${entry.expression}`;
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    return `${base} :: ${occurrence}`;
  });
}

export function collectRouteErrorEgressFindings({
  rootDir,
  reviewed = REVIEWED_DIRECT_ROUTE_MESSAGE_EGRESS,
}) {
  const actual = new Set();
  for (const directory of ['src-server/routes', 'src-server/runtime']) {
    for (const file of listSourceFiles(rootDir, directory)) {
      const source = readFileSync(join(rootDir, file), 'utf8');
      for (const identity of findDirectRouteMessageEgress(source, file)) {
        actual.add(identity);
      }
    }
  }

  const findings = [];
  for (const identity of actual) {
    if (!reviewed.has(identity)) {
      findings.push(
        `Unreviewed direct outward .message serialization: ${identity}.`,
      );
    }
  }
  for (const identity of reviewed) {
    if (!actual.has(identity)) {
      findings.push(
        `Stale reviewed direct outward .message serialization: ${identity}.`,
      );
    }
  }
  findings.push(...collectTransportErrorEgressFindings({ rootDir }));
  return findings;
}

export function collectRouteErrorEgressFindingsForSources(
  sources,
  { reviewed = REVIEWED_DIRECT_ROUTE_MESSAGE_EGRESS } = {},
) {
  const actual = new Set();
  for (const [file, source] of Object.entries(sources)) {
    for (const identity of findDirectRouteMessageEgress(source, file))
      actual.add(identity);
  }
  const findings = [];
  for (const identity of actual) {
    if (!reviewed.has(identity)) {
      findings.push(
        `Unreviewed direct outward .message serialization: ${identity}.`,
      );
    }
  }
  for (const identity of reviewed) {
    if (!actual.has(identity)) {
      findings.push(
        `Stale reviewed direct outward .message serialization: ${identity}.`,
      );
    }
  }
  return findings;
}
