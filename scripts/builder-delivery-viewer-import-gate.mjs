import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';

const ROOT = 'examples/builder-delivery-viewer';
const READ_ONLY_FS_IMPORTS = new Set([
  'constants',
  'existsSync',
  'lstat',
  'lstatSync',
  'open',
  'opendir',
  'readFile',
  'readFileSync',
  'readdirSync',
  'realpathSync',
  'statSync',
]);
const ALLOWED_IMPORTS = new Map([
  ['node:fs', { named: READ_ONLY_FS_IMPORTS }],
  ['node:fs/promises', { named: READ_ONLY_FS_IMPORTS }],
  ['node:path', { named: new Set(['dirname', 'join', 'relative']) }],
  ['node:url', { named: new Set(['fileURLToPath']) }],
  ['@kontourai/flow-agents', { named: new Set(['validateTrustBundle']) }],
  ['@kontourai/surface', { named: new Set(['buildTrustReport']) }],
  ['@kontourai/surface/trust-panel/element', { sideEffect: true }],
  [
    '@kontourai/station-sdk',
    {
      named: new Set([
        'LayoutComponentProps',
        'telemetry',
        'useApiBase',
        'useFlowRunsQuery',
        'useNavigation',
      ]),
    },
  ],
  ['@tanstack/react-query', { named: new Set(['useQuery']) }],
  ['react', { named: new Set(['useEffect', 'useRef', 'useState']) }],
  ['ajv/dist/2020.js', { defaultOnly: true }],
]);
const DANGEROUS_LOADER_IDENTIFIERS = new Set([
  'require',
  'createRequire',
  'getBuiltinModule',
  'eval',
  'Function',
  'globalThis',
  'process',
  'module',
  'XMLHttpRequest',
  'WebSocket',
]);
const NETWORK_MUTATION_IDENTIFIERS = new Set([
  'document',
  'Reflect',
  'Proxy',
  'Request',
  'navigator',
  'self',
  'sendBeacon',
  'window',
]);

function finding(file, kind, content, index) {
  return {
    file,
    kind,
    line: content.slice(0, index).split('\n').length,
  };
}

function constantString(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = constantString(node.left);
    const right = constantString(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function callKind(node) {
  if (!ts.isCallExpression(node)) return null;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return 'dynamic';
  if (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    return 'require';
  if (
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'require' &&
    node.expression.name.text === 'resolve'
  )
    return 'require.resolve';
  return null;
}

function relativeImportIsScoped(file, source) {
  if (!source.startsWith('.')) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(file), source));
  return resolved === ROOT || resolved.startsWith(`${ROOT}/`);
}

function approvedStaticImport(file, node, source) {
  if (source.startsWith('.'))
    return source.endsWith('.css') && relativeImportIsScoped(file, source);
  const contract = ALLOWED_IMPORTS.get(source);
  if (!contract) return false;
  const clause = node.importClause;
  if (contract.sideEffect) return !clause;
  if (!clause) return false;
  if (contract.defaultOnly) return !!clause.name && !clause.namedBindings;
  if (clause.name || !clause.namedBindings) return false;
  if (!ts.isNamedImports(clause.namedBindings)) return false;
  return clause.namedBindings.elements.every(
    (element) => !element.propertyName && contract.named.has(element.name.text),
  );
}

function approvedReadonlyOpenCall(node, sourceFile) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'open' ||
    node.arguments.length !== 2
  )
    return false;
  const flags = node.arguments[1].getText(sourceFile).replace(/\s/g, '');
  return (
    flags ===
    'constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0)'
  );
}

function belongsToApprovedReadonlyOpen(node, sourceFile) {
  let current = node.parent;
  while (current && !ts.isCallExpression(current)) current = current.parent;
  return !!current && approvedReadonlyOpenCall(current, sourceFile);
}

function approvedFetchCall(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'fetch' ||
    node.arguments.length !== 1 ||
    !ts.isIdentifier(node.arguments[0]) ||
    node.arguments[0].text !== 'url'
  )
    return false;
  let owner = node.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  return (
    !!owner &&
    ts.isFunctionDeclaration(owner) &&
    owner.name?.text === 'load' &&
    owner.parameters.length === 1 &&
    ts.isIdentifier(owner.parameters[0].name) &&
    owner.parameters[0].name.text === 'url' &&
    owner.parameters[0].type?.kind === ts.SyntaxKind.StringKeyword
  );
}

function approvedLoaderUrlDeclaration(node) {
  if (!ts.isIdentifier(node) || node.text !== 'url') return false;
  const parameter = node.parent;
  const owner = parameter?.parent;
  return (
    ts.isParameter(parameter) &&
    parameter.name === node &&
    parameter.type?.kind === ts.SyntaxKind.StringKeyword &&
    ts.isFunctionDeclaration(owner) &&
    owner.name?.text === 'load' &&
    owner.parameters.length === 1 &&
    owner.parameters[0] === parameter
  );
}

function isUrlBindingDeclaration(node) {
  if (!ts.isIdentifier(node) || node.text !== 'url') return false;
  const parent = node.parent;
  return (
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isBindingElement(parent) && parent.name === node)
  );
}

function isImportMetaResolve(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isMetaProperty(node.expression.expression) &&
    node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'resolve'
  );
}

function inspectModuleLoad(file, content, source, node, kind, findings) {
  if (kind === 'static' && !approvedStaticImport(file, node, source))
    findings.push(
      finding(file, 'unapproved-module-capability', content, node.getStart()),
    );
  if (
    source.includes('/src-server/') ||
    source.includes('/src-ui/') ||
    /(?:^|\/)packages\//.test(source)
  )
    findings.push(
      finding(file, 'station-private-import', content, node.getStart()),
    );
  if (
    source.startsWith('@kontourai/flow-agents/') &&
    source !== '@kontourai/flow-agents/package.json'
  )
    findings.push(
      finding(file, 'private-flow-agents-import', content, node.getStart()),
    );
  if (source === '@kontourai/flow-agents') {
    const clause = ts.isImportDeclaration(node) ? node.importClause : null;
    const named = clause?.namedBindings;
    const allowed =
      kind === 'static' &&
      !clause?.name &&
      named &&
      ts.isNamedImports(named) &&
      named.elements.length > 0 &&
      named.elements.every(
        (element) =>
          (element.propertyName ?? element.name).text === 'validateTrustBundle',
      );
    if (!allowed)
      findings.push(
        finding(
          file,
          'unapproved-flow-agents-root-export',
          content,
          node.getStart(),
        ),
      );
  }
  if (source === 'node:child_process')
    findings.push(
      finding(file, 'mutation-capability', content, node.getStart()),
    );
  if (source === 'node:fs' || source === 'node:fs/promises') {
    const clause = ts.isImportDeclaration(node) ? node.importClause : null;
    const named = clause?.namedBindings;
    const allowed =
      kind === 'static' &&
      !clause?.name &&
      named &&
      ts.isNamedImports(named) &&
      named.elements.every((element) =>
        READ_ONLY_FS_IMPORTS.has((element.propertyName ?? element.name).text),
      );
    if (!allowed)
      findings.push(
        finding(file, 'mutation-capability', content, node.getStart()),
      );
  }
}

export function scanFile(file, content) {
  const findings = [];
  const sourceFile = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.ESNext,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics?.length)
    findings.push(finding(file, 'unparseable-source', content, 0));
  const visit = (node) => {
    if (ts.isIdentifier(node) && DANGEROUS_LOADER_IDENTIFIERS.has(node.text))
      findings.push(
        finding(file, 'dynamic-module-load', content, node.getStart()),
      );
    if (ts.isIdentifier(node) && NETWORK_MUTATION_IDENTIFIERS.has(node.text))
      findings.push(
        finding(file, 'network-mutation-capability', content, node.getStart()),
      );
    if (
      ts.isIdentifier(node) &&
      node.text === 'global' &&
      !(ts.isModuleDeclaration(node.parent) && node.parent.name === node)
    )
      findings.push(
        finding(file, 'dynamic-module-load', content, node.getStart()),
      );
    if (isUrlBindingDeclaration(node) && !approvedLoaderUrlDeclaration(node))
      findings.push(
        finding(file, 'network-mutation-capability', content, node.getStart()),
      );
    if (
      ts.isElementAccessExpression(node) &&
      !ts.isNumericLiteral(node.argumentExpression)
    )
      findings.push(
        finding(file, 'computed-capability-access', content, node.getStart()),
      );
    if (ts.isStringLiteralLike(node)) {
      if (DANGEROUS_LOADER_IDENTIFIERS.has(node.text))
        findings.push(
          finding(file, 'dynamic-module-load', content, node.getStart()),
        );
      if (node.text === 'fetch')
        findings.push(
          finding(
            file,
            'network-mutation-capability',
            content,
            node.getStart(),
          ),
        );
      if (NETWORK_MUTATION_IDENTIFIERS.has(node.text))
        findings.push(
          finding(
            file,
            'network-mutation-capability',
            content,
            node.getStart(),
          ),
        );
    }
    if (ts.isIdentifier(node) && node.text === 'fetch') {
      const directRead =
        ts.isCallExpression(node.parent) && approvedFetchCall(node.parent);
      if (!directRead)
        findings.push(
          finding(
            file,
            'network-mutation-capability',
            content,
            node.getStart(),
          ),
        );
    }
    if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.left.text === 'url' &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      findings.push(
        finding(file, 'network-mutation-capability', content, node.getStart()),
      );
    if (ts.isIdentifier(node) && node.text === 'open') {
      const importBinding = ts.isImportSpecifier(node.parent);
      const call =
        ts.isCallExpression(node.parent) && node.parent.expression === node
          ? node.parent
          : null;
      if (
        !importBinding &&
        (!call || !approvedReadonlyOpenCall(call, sourceFile))
      )
        findings.push(
          finding(file, 'mutation-capability', content, node.getStart()),
        );
    }
    if (
      ts.isIdentifier(node) &&
      node.text === 'constants' &&
      !ts.isImportSpecifier(node.parent) &&
      !belongsToApprovedReadonlyOpen(node, sourceFile)
    )
      findings.push(
        finding(file, 'mutation-capability', content, node.getStart()),
      );
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    )
      inspectModuleLoad(
        file,
        content,
        node.moduleSpecifier.text,
        node,
        'static',
        findings,
      );
    if (ts.isImportEqualsDeclaration(node))
      findings.push(
        finding(file, 'dynamic-module-load', content, node.getStart()),
      );
    if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      findings.push(
        finding(file, 'reexport-capability', content, node.getStart()),
      );
    if (isImportMetaResolve(node)) {
      const source = node.arguments[0]
        ? constantString(node.arguments[0])
        : null;
      if (source !== '@kontourai/flow-agents/package.json')
        findings.push(
          finding(file, 'dynamic-module-load', content, node.getStart()),
        );
    }
    const kind = callKind(node);
    if (kind)
      findings.push(
        finding(file, 'dynamic-module-load', content, node.getStart()),
      );
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const statement of content.matchAll(/[^;]+;?/g)) {
    const squashed = statement[0].replace(/['"`\s+()\\]/g, '');
    const segmented =
      /(?:flow-agents|station|node_modules).{0,160}(?:\/|,)(?:src|build|kits|dist|src-server|src-ui|packages)(?:\/|,|\b)/m.exec(
        squashed,
      );
    if (segmented)
      findings.push(
        finding(
          file,
          'segmented-filesystem-workaround',
          content,
          statement.index,
        ),
      );
    const splitStationPrivate =
      /(?:\/|,)(?:src-server|src-ui)(?:\/|,|\b)/m.exec(squashed);
    if (splitStationPrivate)
      findings.push(
        finding(file, 'station-private-import', content, statement.index),
      );
  }
  return findings.filter(
    (entry, index) =>
      findings.findIndex(
        (candidate) =>
          candidate.kind === entry.kind && candidate.line === entry.line,
      ) === index,
  );
}

export function scopedFiles() {
  return execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      `${ROOT}/src/**`,
      `${ROOT}/server/**`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
    .trim()
    .split('\n')
    .filter(
      (file) =>
        /\.(?:[cm]?[jt]sx?)$/.test(file) && !file.includes('/__tests__/'),
    );
}

function main() {
  const findings = scopedFiles().flatMap((file) =>
    scanFile(file, readFileSync(file, 'utf8')),
  );
  if (findings.length) {
    console.error('Builder Delivery Viewer import gate failed:');
    for (const finding of findings)
      console.error(`  ${finding.kind}: ${finding.file}:${finding.line}`);
    process.exit(1);
  }
  console.log(
    `OK: Builder Delivery Viewer uses only published contracts (${scopedFiles().length} files scanned).`,
  );
}
if (import.meta.url === `file://${process.argv[1]}`) main();
