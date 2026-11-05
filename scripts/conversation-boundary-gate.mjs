#!/usr/bin/env node
// Structural prevention, not behavioral isolation or semantic clone detection.
// Deliberate limits: simple lexical aliases/re-exports only; no arbitrary helper
// return dataflow, computed property names, runtime grants or cross-Station proof.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript-api';
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const SCAN_ROOTS = Object.freeze(['src-ui/src']);
const REQUIRED_CONCERNS = Object.freeze([
  'body',
  'composer',
  'stop',
  'approval',
  'delivery',
  'history',
  'inbox',
  'failure',
  'initialDraft',
]);
const MANIFEST = 'scripts/conversation-surfaces.json';
const BASELINE = 'scripts/conversation-boundary-baseline.json';
const SENTINELS = [
  'src-ui/src/components/chat-dock/ChatDockBody.tsx',
  'src-ui/src/components/conversation/ConversationBody.tsx',
  'src-ui/src/components/chat/ChatInputArea.tsx',
  'src-ui/src/components/chat/message-bubble/MessageDeliveryNote.tsx',
  'src-ui/src/components/session-detail/AttachedSessionDetail.tsx',
  'src-ui/src/components/chat-dock/MobileInboxPanel.tsx',
  'src-ui/src/utils/stationFailure.ts',
];
const AMBIENT = new Set([
  'useApiBase',
  'useHostRequestAuthorityScope',
  '_getApiBase',
  'useActiveStationName',
  'useAgents',
  'useAgent',
  'useAgentsLoaded',
  'useAgentsSettled',
  'useAgentCatalogRead',
  'useAgentCatalogReconciling',
  'useProjects',
  'useProject',
  'AgentsContext',
  'ProjectsContext',
]);
const MUTATIONS = new Set([
  'sendExecutionMessage',
  'sendExecutionMessageWithInventory',
  'interruptTurn',
  'interruptOrchestrationTurn',
  'submitToolApproval',
  'answerRequest',
  'answerOrchestrationRequest',
  'respondToRequest',
  'stopSession',
]);
const RAW_ACCESS = new Set([
  'callerAccess',
  'sessionUnanswerable',
  'messageWrite',
  'historyRead',
  'READ_ONLY_UI_BLOCK_ACTIONS',
]);
const FUTURE = new Map([
  [
    'history',
    ['src-ui/src/components/conversation/SharedTaskHistoryList.tsx', 'P2.3'],
  ],
  [
    'inbox',
    ['src-ui/src/components/chat-dock/useInboxPanelController.ts', 'P2.4'],
  ],
]);
const normalize = (file) => file.replaceAll('\\', '/');
const sourceFile = (file) =>
  /\.[cm]?[jt]sx?$/.test(file) &&
  !/(?:^|\/)(?:__tests__|tests|fixtures|node_modules|dist|build|generated|station-worktrees)(?:\/|$)|\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(
    file,
  );
const fingerprint = (text) =>
  createHash('sha256')
    .update(text.replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 20);
const unwrap = (node) => {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node))
  )
    node = node.expression;
  return node;
};
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}
function importedModule(file, module, files) {
  if (!module.startsWith('.')) return undefined;
  const base = normalize(
    path.posix.normalize(path.posix.join(path.posix.dirname(file), module)),
  );
  return [
    base,
    ...['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'].map(
      (suffix) => base + suffix,
    ),
  ].find((candidate) => files.has(candidate));
}
function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
}
function exported(node) {
  return node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}
function exportedNames(ast) {
  const result = new Set();
  for (const node of ast.statements) {
    if (!exported(node)) continue;
    if (node.name && ts.isIdentifier(node.name)) result.add(node.name.text);
    if (ts.isVariableStatement(node))
      for (const decl of node.declarationList.declarations)
        for (const name of bindingNames(decl.name)) result.add(name);
  }
  return result;
}

/** Git supplies tracked AND nonignored untracked source; never traverses links. */
export function discoverConversationFiles(
  root = process.cwd(),
  capture = execFileSyncBounded,
) {
  const output = capture(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...SCAN_ROOTS,
    ],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  return [...new Set(output.split('\0').filter(sourceFile))].sort();
}
export function conversationBoundaryCommands(paths) {
  const relevant = paths.some((file) =>
    /^(?:src-ui\/|packages\/(?:sdk|connect|contracts)\/|scripts\/(?:conversation-|gate-for\.|verification-policy-gate\.|run-ci-fast\.|__tests__\/(?:conversation-boundary|gate-for|verification-policy-gate))|package\.json$)/.test(
      normalize(file),
    ),
  );
  if (!relevant) return [];
  const commands = ['node scripts/conversation-boundary-gate.mjs'];
  if (
    paths.some((file) => /^(?:scripts\/|package\.json$)/.test(normalize(file)))
  )
    commands.push(
      'npm run test:focused -- scripts/__tests__/conversation-boundary-gate.test.ts scripts/__tests__/gate-for.test.ts scripts/__tests__/verification-policy-gate.test.ts',
    );
  return commands;
}

function manifestErrors(files, manifest, asts) {
  const errors = [];
  if (
    manifest.version !== 1 ||
    JSON.stringify(manifest.roots) !== JSON.stringify(SCAN_ROOTS)
  )
    errors.push('manifest scan roots must equal the fixed scanner roots');
  if (
    !Array.isArray(manifest.owners) ||
    !Array.isArray(manifest.surfaces) ||
    !Array.isArray(manifest.modules) ||
    !Array.isArray(manifest.contracts)
  )
    return [...errors, 'invalid manifest collections'];
  for (const concern of REQUIRED_CONCERNS) {
    const owners = manifest.owners.filter((owner) => owner.concern === concern);
    if (owners.length !== 1) {
      errors.push(`exactly one owner required: ${concern}`);
      continue;
    }
    const owner = owners[0];
    if (!owner.symbol || !owner.file || !owner.reason)
      errors.push(`invalid owner: ${concern}`);
    if (owner.planned) {
      const future = FUTURE.get(concern);
      if (!future || owner.file !== future[0] || owner.planned !== future[1])
        errors.push(`invalid planned owner: ${concern}`);
      if (files.has(owner.file))
        errors.push(
          `planned owner now exists; activate ${concern} and shrink the baseline`,
        );
    } else if (
      !files.has(owner.file) ||
      !exportedNames(asts.get(owner.file)).has(owner.symbol)
    )
      errors.push(`missing owner export: ${owner.file}#${owner.symbol}`);
  }
  if (
    manifest.owners.some((owner) => !REQUIRED_CONCERNS.includes(owner.concern))
  )
    errors.push('unknown owner concern');
  const seen = new Set();
  for (const surface of manifest.surfaces) {
    if (seen.has(surface.file))
      errors.push(`duplicate surface: ${surface.file}`);
    seen.add(surface.file);
    if (
      !files.has(surface.file) ||
      !surface.reason ||
      !Array.isArray(surface.requires) ||
      surface.requires.some((concern) => !REQUIRED_CONCERNS.includes(concern))
    )
      errors.push(`invalid surface: ${surface.file}`);
  }
  for (const file of manifest.modules)
    if (!files.has(file)) errors.push(`missing registered module: ${file}`);
  for (const surface of manifest.failureSurfaces ?? [])
    if (!files.has(surface.file) || !surface.reason)
      errors.push(`invalid failure surface: ${surface.file}`);
  for (const contract of manifest.contracts) {
    if (
      !files.has(contract.file) ||
      !contract.reason ||
      !['G1', 'G2', 'G3', 'G4'].includes(contract.rule) ||
      !Array.isArray(contract.symbols) ||
      !contract.symbols.length ||
      (contract.fingerprints &&
        (!Array.isArray(contract.fingerprints) ||
          !contract.fingerprints.length ||
          contract.fingerprints.some((value) => !/^[a-f0-9]{20}$/.test(value))))
    )
      errors.push(`invalid narrow contract: ${contract.file}`);
  }
  return errors;
}

/** Pure AST scanner. Inputs are source bytes; no network, server or TS program. */
export function scanConversationSources(
  sources,
  manifest,
  { enforceScope = true } = {},
) {
  if (
    !manifest ||
    !['owners', 'surfaces', 'modules', 'contracts'].every((key) =>
      Array.isArray(manifest[key]),
    )
  )
    return { errors: ['invalid manifest collections'], sites: [] };
  const files = new Map(Object.entries(sources));
  const asts = new Map(
    [...files].map(([file, source]) => [
      file,
      ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
    ]),
  );
  const errors = enforceScope ? manifestErrors(files, manifest, asts) : [];
  if (enforceScope) {
    if (!files.size) errors.push('empty conversation scan scope');
    for (const file of SENTINELS)
      if (!files.has(file)) errors.push(`scope lost sentinel: ${file}`);
  }
  const sites = [];
  const scope = new Set([
    ...manifest.modules,
    ...manifest.surfaces.map((surface) => surface.file),
    ...manifest.owners
      .filter((owner) => !owner.planned)
      .map((owner) => owner.file),
  ]);
  const permits = (file, rule, symbol, siteFingerprint) =>
    manifest.contracts.some(
      (contract) =>
        contract.file === file &&
        contract.rule === rule &&
        contract.symbols.includes(symbol) &&
        (!contract.fingerprints ||
          contract.fingerprints.includes(siteFingerprint)),
    );
  const owns = (file, concern) =>
    manifest.owners.some(
      (owner) =>
        !owner.planned && owner.concern === concern && owner.file === file,
    );
  const imports = new Map();
  for (const [file, ast] of asts) {
    const bindings = new Map();
    for (const node of ast.statements) {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        node.importClause?.isTypeOnly
      )
        continue;
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name)
        bindings.set(clause.name.text, { module, symbol: 'default' });
      const names = clause?.namedBindings;
      if (names && ts.isNamespaceImport(names))
        bindings.set(names.name.text, { module, symbol: '*' });
      if (names && ts.isNamedImports(names))
        for (const item of names.elements)
          if (!item.isTypeOnly)
            bindings.set(item.name.text, {
              module,
              symbol: (item.propertyName ?? item.name).text,
            });
    }
    imports.set(file, bindings);
  }
  function resolveExport(file, symbol, seen = new Set()) {
    const key = `${file}#${symbol}`;
    if (seen.has(key)) return symbol;
    seen.add(key);
    const ast = asts.get(file);
    if (!ast) return symbol;
    for (const statement of ast.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === symbol,
      );
      if (
        declaration?.initializer &&
        ts.isIdentifier(unwrap(declaration.initializer))
      )
        return resolveExport(file, unwrap(declaration.initializer).text, seen);
    }
    const binding = imports.get(file)?.get(symbol);
    if (binding) {
      const target = importedModule(file, binding.module, files);
      return target
        ? resolveExport(target, binding.symbol, seen)
        : binding.symbol;
    }
    for (const node of ast.statements) {
      if (!ts.isExportDeclaration(node) || node.isTypeOnly) continue;
      const module =
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? node.moduleSpecifier.text
          : undefined;
      const target = module && importedModule(file, module, files);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        const item = node.exportClause.elements.find(
          (entry) => entry.name.text === symbol,
        );
        if (item && !item.isTypeOnly)
          return target
            ? resolveExport(target, (item.propertyName ?? item.name).text, seen)
            : module
              ? (item.propertyName ?? item.name).text
              : resolveExport(
                  file,
                  (item.propertyName ?? item.name).text,
                  seen,
                );
      } else if (target) {
        const resolved = resolveExport(target, symbol, seen);
        if (resolved !== symbol || AMBIENT.has(resolved)) return resolved;
      }
    }
    return symbol;
  }
  for (const [file, ast] of asts) {
    if (ast.parseDiagnostics.length) {
      errors.push(`parse error: ${file}`);
      continue;
    }
    const add = (rule, node, symbol) => {
      const syntax =
        node === ast
          ? symbol
          : `${symbol}: ${node.getText(ast).replace(/\s+/g, ' ').trim()}`;
      if (permits(file, rule, symbol, fingerprint(syntax))) return;
      sites.push({
        rule,
        file,
        fingerprint: fingerprint(syntax),
        syntax,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      });
    };
    const bindings = imports.get(file);
    const aliases = new Map();
    const reboundSymbols = new Map();
    const taintedObjects = new Set();
    const taintedText = new Set();
    const nodes = [];
    walk(ast, (node) => {
      nodes.push(node);
      if (ts.isCatchClause(node) && node.variableDeclaration)
        for (const name of bindingNames(node.variableDeclaration.name))
          taintedObjects.add(name);
      if (
        ts.isParameter(node) &&
        ts.isIdentifier(node.name) &&
        (/(?:Error|Failure)/.test(node.type?.getText(ast) ?? '') ||
          /^(?:err|error|caught|failure)$/.test(node.name.text))
      )
        taintedObjects.add(node.name.text);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const callback =
          node.expression.name.text === 'catch'
            ? node.arguments[0]
            : node.expression.name.text === 'then'
              ? node.arguments[1]
              : undefined;
        if (
          callback &&
          (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        )
          for (const parameter of callback.parameters)
            for (const name of bindingNames(parameter.name))
              taintedObjects.add(name);
      }
    });
    function namespaceOf(expression, seen = new Set()) {
      const node = unwrap(expression);
      if (!node || !ts.isIdentifier(node) || seen.has(node.text))
        return undefined;
      seen.add(node.text);
      if (aliases.has(node.text))
        return namespaceOf(aliases.get(node.text), seen);
      const binding = bindings.get(node.text);
      return binding?.symbol === '*' ? binding : undefined;
    }
    function symbolOf(expression, seen = new Set()) {
      const node = unwrap(expression);
      if (!node) return '';
      if (ts.isIdentifier(node)) {
        if (seen.has(node.text)) return node.text;
        seen.add(node.text);
        if (reboundSymbols.has(node.text)) return reboundSymbols.get(node.text);
        if (aliases.has(node.text))
          return symbolOf(aliases.get(node.text), seen);
        const binding = bindings.get(node.text);
        if (!binding) return node.text;
        const target = importedModule(file, binding.module, files);
        return target ? resolveExport(target, binding.symbol) : binding.symbol;
      }
      if (ts.isPropertyAccessExpression(node)) {
        const namespace = namespaceOf(node.expression);
        if (namespace) {
          const target = importedModule(file, namespace.module, files);
          return target
            ? resolveExport(target, node.name.text)
            : node.name.text;
        }
        return node.name.text;
      }
      return '';
    }
    function errorObject(expression) {
      const node = unwrap(expression);
      return (
        node &&
        ((ts.isIdentifier(node) &&
          (taintedObjects.has(node.text) ||
            /(?:^error$|Error$|^err$|Failure$)/.test(node.text))) ||
          (ts.isPropertyAccessExpression(node) &&
            (node.name.text === 'error' || errorObject(node.expression))))
      );
    }
    function rawText(expression) {
      const node = unwrap(expression);
      if (!node) return false;
      if (ts.isIdentifier(node)) return taintedText.has(node.text);
      if (ts.isPropertyAccessExpression(node))
        return (
          ['message', 'code', 'error'].includes(node.name.text) &&
          errorObject(node.expression)
        );
      if (ts.isConditionalExpression(node))
        return rawText(node.whenTrue) || rawText(node.whenFalse);
      if (ts.isBinaryExpression(node))
        return (
          (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            ? false
            : rawText(node.left)) || rawText(node.right)
        );
      if (ts.isTemplateExpression(node))
        return node.templateSpans.some((span) => rawText(span.expression));
      if (ts.isArrayLiteralExpression(node)) return node.elements.some(rawText);
      if (ts.isObjectLiteralExpression(node))
        return node.properties.some(
          (prop) => ts.isPropertyAssignment(prop) && rawText(prop.initializer),
        );
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'String'
      )
        return node.arguments.some(
          (argument) => errorObject(argument) || rawText(argument),
        );
      return false; // A translator call is an explicit dataflow boundary.
    }
    for (let pass = 0; pass < 4; pass++)
      for (const node of nodes) {
        if (!ts.isVariableDeclaration(node) || !node.initializer) continue;
        if (ts.isIdentifier(node.name)) {
          aliases.set(node.name.text, node.initializer);
          if (errorObject(node.initializer)) taintedObjects.add(node.name.text);
          if (rawText(node.initializer)) taintedText.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name))
          for (const binding of node.name.elements) {
            const field = (binding.propertyName ?? binding.name).getText(ast);
            for (const name of bindingNames(binding.name)) {
              const namespace = namespaceOf(node.initializer);
              if (namespace) {
                const target = importedModule(file, namespace.module, files);
                reboundSymbols.set(
                  name,
                  target ? resolveExport(target, field) : field,
                );
              }
              if (field === 'error') taintedObjects.add(name);
              if (
                ['message', 'code', 'error'].includes(field) &&
                errorObject(node.initializer)
              )
                taintedText.add(name);
            }
          }
      }
    const jsxNames = new Set(
      nodes
        .filter(
          (node) =>
            ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node),
        )
        .map((node) => symbolOf(node.tagName)),
    );
    const chatLike =
      scope.has(file) ||
      [...exportedNames(ast)].some((name) =>
        /(?:Chat|Conversation)(?:Body|Composer)$|(?:DeliveryNote|InboxPanelController|TaskHistoryList)$/.test(
          name,
        ),
      ) ||
      [...jsxNames].some((name) =>
        /^(?:ChatMessageList|ChatInputArea|SessionTranscript|SessionReplyComposer|MessageBubble|MessageDeliveryNote|ConversationBody)$/.test(
          name,
        ),
      ) ||
      (jsxNames.size > 0 &&
        nodes.some(
          (node) =>
            ts.isCallExpression(node) &&
            MUTATIONS.has(symbolOf(node.expression)),
        ));
    if (chatLike && !scope.has(file))
      add('G5', ast, 'register conversation surface');
    for (const node of nodes) {
      if (
        chatLike &&
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly
      ) {
        const names = node.importClause?.namedBindings;
        if (names && ts.isNamedImports(names))
          for (const item of names.elements)
            if (!item.isTypeOnly && AMBIENT.has(symbolOf(item.name)))
              add('G1', item, symbolOf(item.name));
      }
      if (ts.isCallExpression(node)) {
        const name = symbolOf(node.expression);
        if (chatLike && AMBIENT.has(name)) add('G1', node, name);
        if (MUTATIONS.has(name) && !permits(file, 'G2', name))
          add('G2', node, name);
        if (chatLike && name === 'setInterval')
          add('G2', node, 'transcript polling');
        if (
          !owns(file, 'failure') &&
          (/^(?:set\w*(?:Error|Failure|Notice)|setError|showToast|toast|updateChat|addEphemeralMessage|reportOutboundQueueUnavailable)$/.test(
            name,
          ) ||
            (['error', 'warning'].includes(name) &&
              ts.isPropertyAccessExpression(node.expression) &&
              /toast/i.test(node.expression.expression.getText(ast)))) &&
          node.arguments.some(rawText)
        )
          add('G3', node, 'raw failure sink');
      }
      if (
        chatLike &&
        ts.isPropertyAssignment(node) &&
        node.name.getText(ast) === 'refetchInterval' &&
        node.initializer.kind !== ts.SyntaxKind.FalseKeyword &&
        node.initializer.getText(ast) !== '0'
      )
        add('G2', node, 'transcript polling');
      if (
        (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
        symbolOf(node.tagName) === 'textarea' &&
        chatLike &&
        !owns(file, 'composer') &&
        !owns(file, 'initialDraft')
      )
        add('G2', node, 'reply textarea');
      if (
        ts.isJsxElement(node) &&
        /^(?:button|Button|ActionControl)$/.test(
          symbolOf(node.openingElement.tagName),
        )
      ) {
        const text = node.children
          .filter(ts.isJsxText)
          .map((child) => child.text.trim())
          .join(' ');
        const stopLabel = node.openingElement.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            ['aria-label', 'title'].includes(attribute.name.getText(ast)) &&
            attribute.initializer &&
            ts.isStringLiteral(attribute.initializer) &&
            /^Stop(?:\s|$)/.test(attribute.initializer.text),
        );
        if (
          chatLike &&
          (/^Stop(?:\s|$)/.test(text) || stopLabel) &&
          !owns(file, 'stop')
        )
          add('G2', node, 'Stop control');
      }
      if (
        !owns(file, 'failure') &&
        ts.isJsxExpression(node) &&
        node.expression &&
        rawText(node.expression)
      )
        add('G3', node, 'raw failure sink');
      if (chatLike) {
        if (
          ts.isPropertyAccessExpression(node) &&
          AMBIENT.has(symbolOf(node)) &&
          namespaceOf(node.expression)
        )
          add('G1', node, symbolOf(node));
        if (
          ts.isPropertySignature(node) &&
          node.type?.kind === ts.SyntaxKind.BooleanKeyword &&
          /^(?:can|may|allow)(?:Send|Reply|Write|Answer|Stop)$/.test(
            node.name.getText(ast),
          )
        )
          add('G4', node, 'foreign capability prop');
        if (
          (ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node)) &&
          /(?:Capabilities|Permissions)$/.test(node.name.text) &&
          node.name.text !== 'ConversationCapabilities'
        )
          add('G4', node, 'foreign capability type');
        if (
          ts.isPropertyAccessExpression(node) &&
          RAW_ACCESS.has(node.name.text)
        )
          add('G4', node, node.name.text);
        if (
          ts.isBindingElement(node) &&
          RAW_ACCESS.has((node.propertyName ?? node.name).getText(ast))
        )
          add('G4', node, (node.propertyName ?? node.name).getText(ast));
        if (
          ts.isIdentifier(node) &&
          node.text === 'READ_ONLY_UI_BLOCK_ACTIONS' &&
          !ts.isImportSpecifier(node.parent)
        )
          add('G4', node, node.text);
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer &&
          /^(?:can|may|allow)(?:Send|Reply|Write|Answer|Stop)/.test(
            node.name.getText(ast),
          ) &&
          /(?:context|connection)/i.test(node.initializer.getText(ast)) &&
          !/capabilities|\.allows\(/.test(node.initializer.getText(ast))
        )
          add('G4', node, 'context-presence capability');
      }
    }
    // The original PeerChatBody and a renamed fork both expose these controls.
    if (
      chatLike &&
      !owns(file, 'body') &&
      jsxNames.has('ChatMessageList') &&
      jsxNames.has('ChatInputArea')
    )
      add('G2', ast, 'parallel conversation body');
    const copiedNotes = nodes.filter(ts.isJsxElement).filter((element) => {
      const text = [];
      walk(element, (node) => {
        if (ts.isJsxText(node)) text.push(node.text.trim());
        if (ts.isStringLiteral(node)) text.push(node.text);
      });
      return ['Not sent', 'Retry', 'Edit'].every((label) =>
        text.includes(label),
      );
    });
    if (!owns(file, 'delivery'))
      for (const element of copiedNotes.filter(
        (candidate) =>
          !copiedNotes.some(
            (child) =>
              child !== candidate &&
              child.pos > candidate.pos &&
              child.end < candidate.end,
          ),
      ))
        add('G2', element, 'copied delivery note');
    for (const name of exportedNames(ast)) {
      const concern = manifest.owners.find((owner) => owner.symbol === name);
      if (concern && concern.file !== file)
        add('G2', ast, `duplicate owner ${name}`);
    }
    for (const surface of [
      ...manifest.surfaces,
      ...(manifest.failureSurfaces ?? []).map((surface) => ({
        ...surface,
        requires: ['failure'],
      })),
    ].filter((surface) => surface.file === file))
      for (const concern of surface.requires) {
        const owner = manifest.owners.find((item) => item.concern === concern);
        if (!owner) continue;
        const dynamicImport = nodes.some(
          (node) =>
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            ts.isStringLiteral(node.arguments[0]) &&
            importedModule(file, node.arguments[0].text, files) === owner.file,
        );
        const loaders = new Set();
        if (dynamicImport)
          for (const node of nodes) {
            if (
              !ts.isVariableDeclaration(node) ||
              !ts.isIdentifier(node.name) ||
              !node.initializer
            )
              continue;
            let importsOwner = false;
            let selectsOwner = false;
            walk(node.initializer, (child) => {
              if (
                ts.isCallExpression(child) &&
                child.expression.kind === ts.SyntaxKind.ImportKeyword &&
                ts.isStringLiteral(child.arguments[0]) &&
                importedModule(file, child.arguments[0].text, files) ===
                  owner.file
              )
                importsOwner = true;
              if (
                ts.isPropertyAccessExpression(child) &&
                child.name.text === owner.symbol
              )
                selectsOwner = true;
            });
            if (importsOwner && selectsOwner) loaders.add(node.name.text);
          }
        const lazyUse = nodes.some(
          (node) =>
            (ts.isJsxOpeningElement(node) ||
              ts.isJsxSelfClosingElement(node)) &&
            node.tagName.getText(ast) === 'LazyBoundary' &&
            node.attributes.properties.some(
              (attribute) =>
                ts.isJsxAttribute(attribute) &&
                attribute.name.getText(ast) === 'load' &&
                attribute.initializer &&
                ts.isJsxExpression(attribute.initializer) &&
                attribute.initializer.expression &&
                loaders.has(attribute.initializer.expression.getText(ast)),
            ),
        );
        const used = nodes.some((node) => {
          const expression = ts.isCallExpression(node)
            ? node.expression
            : ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
              ? node.tagName
              : undefined;
          return (
            expression &&
            ((symbolOf(expression) === owner.symbol &&
              [...bindings.values()].some(
                (binding) =>
                  importedModule(file, binding.module, files) === owner.file,
              )) ||
              (dynamicImport && expression.getText(ast) === owner.symbol))
          );
        });
        if (!used && !lazyUse) add('G5', ast, `adopt ${concern}`);
      }
  }
  // Identical syntax may occur more than once: ceilings retain multiplicity.
  return { errors, sites };
}

export function evaluateConversationBaseline(sites, baseline) {
  const errors = [];
  if (baseline?.version !== 1 || !Array.isArray(baseline.exceptions))
    return { errors: ['invalid conversation baseline'], next: baseline };
  const ceilings = new Map();
  for (const row of baseline.exceptions) {
    const key = `${row.rule}:${row.file}:${row.fingerprint}`;
    if (
      !/^G[1-5]$/.test(row.rule) ||
      !sourceFile(row.file) ||
      !/^[a-f0-9]{20}$/.test(row.fingerprint) ||
      !Number.isInteger(row.count) ||
      row.count < 1 ||
      !/^P2\.[1-6]$/.test(row.migrate) ||
      !row.syntax ||
      fingerprint(row.syntax) !== row.fingerprint ||
      ceilings.has(key)
    )
      errors.push(`invalid baseline exception: ${key}`);
    ceilings.set(key, row);
  }
  const actual = new Map();
  for (const site of sites) {
    const key = `${site.rule}:${site.file}:${site.fingerprint}`;
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  for (const [key, count] of actual)
    if (count > (ceilings.get(key)?.count ?? 0))
      errors.push(
        `new conversation boundary violation: ${key} (${count} > ${ceilings.get(key)?.count ?? 0})`,
      );
  const next = {
    version: 1,
    exceptions: baseline.exceptions.flatMap((row) => {
      const count =
        actual.get(`${row.rule}:${row.file}:${row.fingerprint}`) ?? 0;
      return count ? [{ ...row, count: Math.min(count, row.count) }] : [];
    }),
  };
  return { errors, next };
}
function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--update'))
    throw new Error('Usage: conversation-boundary-gate.mjs [--update]');
  const files = discoverConversationFiles();
  for (const file of files)
    if (lstatSync(file).isSymbolicLink())
      throw new Error(`Conversation scan refuses a source symlink: ${file}`);
  const sources = Object.fromEntries(
    files.map((file) => [file, readFileSync(file, 'utf8')]),
  );
  const result = scanConversationSources(
    sources,
    JSON.parse(readFileSync(MANIFEST, 'utf8')),
  );
  const baseline = evaluateConversationBaseline(
    result.sites,
    JSON.parse(readFileSync(BASELINE, 'utf8')),
  );
  const errors = [...result.errors, ...baseline.errors];
  if (errors.length) {
    console.error(errors.join('\n'));
    return 1;
  }
  if (args.includes('--update'))
    writeFileSync(BASELINE, `${JSON.stringify(baseline.next, null, 2)}\n`);
  console.log(
    `OK: conversation boundaries G1–G5; ${files.length} source files, ${result.sites.length} inherited P2 sites; 0 new violations.`,
  );
  return 0;
}
if (invokedDirectly(import.meta.url)) process.exitCode = main();
