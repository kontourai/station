#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-api';
import { createLearningSourceReader } from './lib/learning-source-reader.mjs';
import { publishMetricReference } from './lib/metric-reference-output.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = 'src-server/telemetry/metrics.ts';
const outputPath = 'docs/reference/metrics.md';
const factories = new Set([
  'createCounter',
  'createUpDownCounter',
  'createHistogram',
  'createGauge',
  'createObservableCounter',
  'createObservableUpDownCounter',
  'createObservableGauge',
]);

function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return node.argumentExpression.text;
  return undefined;
}

function exported(node) {
  return (
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) ?? false
  );
}

function declarationContext(call) {
  let expression = call;
  while (expression.parent && unwrap(expression.parent) === call)
    expression = expression.parent;
  const declaration = expression.parent;
  const binding =
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer === expression
      ? declaration.name.getText()
      : null;
  let declarationExported = false;
  if (binding) {
    const statement = declaration.parent.parent;
    declarationExported =
      ts.isVariableStatement(statement) && exported(statement);
  }
  let container = call.parent;
  while (container && !ts.isFunctionDeclaration(container))
    container = container.parent;
  return {
    binding,
    declarationExported,
    container: container?.name?.text ?? null,
  };
}

/** Parse declarations only. Never import or execute the metric module. */
export function parseMetricDeclarations(source) {
  const file = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const fail = (node, message) => {
    const { line, character } = file.getLineAndCharacterOfPosition(
      node.getStart(file),
    );
    throw new Error(`${sourcePath}:${line + 1}:${character + 1}: ${message}`);
  };
  if (file.parseDiagnostics.length) {
    const diagnostic = file.parseDiagnostics[0];
    const position = file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new Error(
      `${sourcePath}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  }
  const meters = new Set();
  const meterBindings = new Set();
  const apiBindings = new Set();
  for (const statement of file.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      !statement.isTypeOnly
    )
      fail(
        statement,
        'Runtime re-exports are unsupported in the metric owner.',
      );
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.isTypeOnly) continue;
    if (
      statement.moduleSpecifier.text !== '@opentelemetry/api' ||
      clause?.name ||
      !clause?.namedBindings ||
      !ts.isNamedImports(clause.namedBindings)
    )
      fail(
        statement,
        'Unsupported runtime import; the metric owner requires named metrics/trace imports from @opentelemetry/api.',
      );
    for (const specifier of clause.namedBindings.elements) {
      if (specifier.isTypeOnly) continue;
      if (
        specifier.propertyName ||
        !['metrics', 'trace'].includes(specifier.name.text)
      )
        fail(
          specifier,
          'Unsupported API import alias or binding; use metrics/trace directly.',
        );
      if (specifier.name.text === 'metrics') apiBindings.add(specifier.name);
    }
  }
  if (apiBindings.size !== 1)
    fail(
      file,
      'Exactly one named metrics import from @opentelemetry/api is required.',
    );
  const isMeterCreation = (node) =>
    ts.isCallExpression(node) &&
    memberName(node.expression) === 'getMeter' &&
    ts.isIdentifier(unwrap(node.expression.expression)) &&
    unwrap(node.expression.expression).text === 'metrics';
  function findMeters(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isMeterCreation(unwrap(node.initializer))
    ) {
      if (!ts.isIdentifier(node.name))
        fail(node, 'Unsupported meter binding; use a named variable.');
      const statement = node.parent.parent;
      if (
        !ts.isVariableStatement(statement) ||
        statement.parent !== file ||
        !(node.parent.flags & ts.NodeFlags.Const) ||
        exported(statement)
      )
        fail(
          node,
          'getMeter must initialize a non-exported top-level const binding.',
        );
      const call = unwrap(node.initializer);
      if (
        call.arguments.length !== 1 ||
        !ts.isStringLiteralLike(call.arguments[0])
      )
        fail(call, 'getMeter requires one literal scope name.');
      if (meters.has(node.name.text)) fail(node, 'Duplicate meter binding.');
      meters.add(node.name.text);
      meterBindings.add(node.name);
    }
    ts.forEachChild(node, findMeters);
  }
  findMeters(file);
  const isMeter = (node) => {
    const value = unwrap(node);
    return (
      (ts.isIdentifier(value) && meters.has(value.text)) ||
      isMeterCreation(value)
    );
  };
  const literal = (node, label) => {
    if (!node || !ts.isStringLiteralLike(unwrap(node)))
      fail(node ?? file, `${label} must be a string literal.`);
    return unwrap(node).text;
  };
  function options(call) {
    const values = { description: null, unit: null };
    if (call.arguments.length === 1) return values;
    const metadata = unwrap(call.arguments[1]);
    if (!ts.isObjectLiteralExpression(metadata))
      fail(metadata, 'Instrument options must be an object literal.');
    const seen = new Set();
    for (const property of metadata.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) &&
          !ts.isStringLiteralLike(property.name))
      )
        fail(
          property,
          'Unsupported instrument metadata; use literal description/unit properties without spreads or computed keys.',
        );
      const key = property.name.text;
      if (!Object.hasOwn(values, key))
        fail(
          property,
          `Unsupported instrument option '${key}'; extend the reference parser before adding metadata.`,
        );
      if (seen.has(key))
        fail(property, `Duplicate instrument option '${key}'.`);
      seen.add(key);
      values[key] = literal(property.initializer, `Instrument ${key}`);
    }
    return values;
  }
  const declarations = [];
  const names = new Set();
  function visit(node) {
    if (
      ts.isImportEqualsDeclaration(node) ||
      (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    )
      fail(
        node,
        'Dynamic imports and import aliases are unsupported in the metric owner.',
      );
    if (
      ts.isIdentifier(node) &&
      ['eval', 'Function', 'require'].includes(node.text)
    )
      fail(node, 'Opaque code evaluation is unsupported in the metric owner.');
    if (
      ts.isIdentifier(node) &&
      node.text === 'metrics' &&
      !apiBindings.has(node)
    ) {
      const access = node.parent;
      if (
        (!ts.isPropertyAccessExpression(access) &&
          !ts.isElementAccessExpression(access)) ||
        access.expression !== node ||
        memberName(access) !== 'getMeter' ||
        !ts.isCallExpression(access.parent) ||
        access.parent.expression !== access
      )
        fail(
          node,
          'The metrics API may only be used by a direct getMeter declaration; API aliases and escaping references are unsupported.',
        );
    }
    if (isMeterCreation(node)) {
      let expression = node;
      while (expression.parent && unwrap(expression.parent) === node)
        expression = expression.parent;
      const declaration = expression.parent;
      if (
        !ts.isVariableDeclaration(declaration) ||
        declaration.initializer !== expression ||
        !meterBindings.has(declaration.name)
      )
        fail(
          node,
          'getMeter results must initialize a non-exported top-level const; escaping or inline results are unsupported.',
        );
    }
    if (
      ts.isIdentifier(node) &&
      meters.has(node.text) &&
      !meterBindings.has(node)
    ) {
      let receiver = node;
      while (receiver.parent && unwrap(receiver.parent) === node)
        receiver = receiver.parent;
      const access = receiver.parent;
      const directReceiver =
        (ts.isPropertyAccessExpression(access) ||
          ts.isElementAccessExpression(access)) &&
        access.expression === receiver;
      const propertyName =
        ts.isPropertyAccessExpression(access) && access.name === node;
      if (!directReceiver && !propertyName)
        fail(
          node,
          'Meter aliases are unsupported, as are escaping references; use direct factory calls.',
        );
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const method = memberName(node);
      const receiverIsMeter = isMeter(node.expression);
      if (receiverIsMeter && !method)
        fail(node, 'Dynamic meter member access is unsupported.');
      if (receiverIsMeter && !factories.has(method))
        fail(node, `Unsupported instrument factory '${method}'.`);
      if (factories.has(method)) {
        if (!receiverIsMeter)
          fail(
            node,
            'Instrument factory must be called on a getMeter binding; aliases are unsupported.',
          );
        const call = node.parent;
        if (!ts.isCallExpression(call) || call.expression !== node)
          fail(
            node,
            'Instrument factory references are unsupported; call the factory directly.',
          );
        if (call.arguments.length < 1 || call.arguments.length > 2)
          fail(
            call,
            'Instrument factory requires a literal name and optional literal options.',
          );
        const name = literal(call.arguments[0], 'Instrument name');
        if (!name.trim()) fail(call, 'Instrument name must not be empty.');
        if (names.has(name)) fail(call, `Duplicate instrument name '${name}'.`);
        names.add(name);
        declarations.push({
          name,
          kind: method,
          ...options(call),
          ...declarationContext(call),
          line:
            file.getLineAndCharacterOfPosition(call.getStart(file)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!declarations.length)
    throw new Error(`${sourcePath}: no metric instrument declarations found.`);
  return declarations;
}

function cell(value) {
  if (value === null) return 'not declared';
  return JSON.stringify(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '&#124;')
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('~', '\\~');
}

export function renderMetricReference(source) {
  const declarations = parseMetricDeclarations(source);
  const digest = createHash('sha256').update(source).digest('hex');
  const rows = declarations.map((entry) => {
    const binding = entry.binding
      ? `${entry.binding}${entry.declarationExported ? ' (exported declaration)' : ' (local declaration)'}`
      : `unbound call${entry.container ? ` in ${entry.container}` : ''}`;
    return `| ${cell(entry.name)} | ${entry.kind} | ${cell(binding)} | ${cell(entry.description)} | ${cell(entry.unit)} | [line ${entry.line}](../../${sourcePath}#L${entry.line}) |`;
  });
  return [
    '# Metric declarations — not emitted-metric evidence',
    '',
    '<!-- Generated by scripts/generate-metric-reference.mjs. Do not edit this file by hand. -->',
    '',
    'These source declarations do **not** establish producers, live collection, correct labels, observed units or billing accuracy. Names and descriptions below are declared metadata; even a description copied exactly from source may be wrong about runtime behavior.',
    '',
    'The [Monitoring guide](../guides/monitoring.md) owns producer semantics, configuration and current limitations. Follow a declaration’s source link to find its callers before making an operational claim. Observable declarations inside a function do not establish that the function is called or its callback runs.',
    '',
    `Source: [\`${sourcePath}\`](../../${sourcePath}).`,
    `Source SHA-256: \`${digest}\`. This identifies the input file, not a running build or collection receipt.`,
    '',
    `The TypeScript AST contains **${declarations.length} creation calls**, listed in source order. Binding/export labels describe the creation declaration, not later aliases or re-exports. String cells use JSON notation, preserving quotes, backslashes and control characters; “not declared” does not infer an SDK default.`,
    '',
    'Regenerate with `npm run docs:metrics:generate`; verify exact output with `npm run docs:metrics:check`. The documentation gate runs the check. This owner supports named metrics/trace imports from `@opentelemetry/api`, direct `metrics.getMeter` calls initializing non-exported top-level constants, and direct meter factories with literal names and description/unit options. Other runtime imports, API/meter escapes, unsupported factories, dynamic metadata, duplicate names and an empty inventory fail. This is a deliberately restricted declaration grammar, not analysis of arbitrary JavaScript execution.',
    '',
    '| Declared instrument name | Factory kind | Binding at declaration | Declared description | Declared unit | Source |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

async function generateMetricReference({
  check = false,
  root: inputRoot = root,
} = {}) {
  const reader = createLearningSourceReader(inputRoot);
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      reader.read(sourcePath),
    );
  } catch (error) {
    if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA')
      throw new Error(`${sourcePath} is not valid UTF-8.`);
    throw error;
  }
  const expected = renderMetricReference(source);
  if (check) {
    let actual;
    try {
      actual = reader.read(outputPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(
        `${outputPath} is missing; run npm run docs:metrics:generate.`,
      );
    }
    if (!actual.equals(Buffer.from(expected)))
      throw new Error(
        `${outputPath} is stale; run npm run docs:metrics:generate.`,
      );
  } else {
    publishMetricReference(inputRoot, outputPath, expected);
  }
  return Buffer.byteLength(expected);
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.some((arg) => arg !== '--check' && !arg.startsWith('--root=')) ||
      args.filter((arg) => arg === '--check').length > 1 ||
      args.filter((arg) => arg.startsWith('--root=')).length > 1
    )
      throw new Error(
        'Usage: generate-metric-reference.mjs [--check] [--root=<checkout>]',
      );
    const selectedRoot = args
      .find((arg) => arg.startsWith('--root='))
      ?.slice(7);
    if (selectedRoot === '')
      throw new Error('--root requires a checkout path.');
    const bytes = await generateMetricReference({
      check: args.includes('--check'),
      root: selectedRoot ? path.resolve(selectedRoot) : root,
    });
    console.log(
      `${args.includes('--check') ? 'Checked' : 'Generated'} ${outputPath} (${bytes} bytes; declarations only).`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
