import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript-api';
import { invokedDirectly } from './lib/module-entry.mjs';
import { toPosixPath } from './lib/posix-path.mjs';

const registryPath =
  'src-server/services/feature-previews/feature-preview-registry.ts';
const settingsPath = 'docs/user/settings.md';
const previewId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return [
        'node_modules',
        '__tests__',
        '__test-utils__',
        'fixtures',
      ].includes(entry.name)
        ? []
        : sourceFiles(path);
    }
    return entry.isFile() &&
      /\.(?:[cm]?ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\./.test(entry.name)
      ? [path]
      : [];
  });
}

function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function propertyName(node) {
  if (ts.isComputedPropertyName(node)) {
    return ts.isStringLiteral(node.expression)
      ? node.expression.text
      : undefined;
  }
  return ts.isIdentifier(node) || ts.isStringLiteral(node)
    ? node.text
    : undefined;
}

function boundIds(root) {
  const files = sourceFiles(join(root, 'src-server')).sort();
  const owner = resolve(root, registryPath);
  // Only server source participates in symbol resolution. This is a source
  // consistency check, independent of installed provider types and full tsc.
  const program = ts.createProgram(files, {
    noResolve: true,
    noLib: true,
    types: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();
  const registry = program.getSourceFile(owner);
  const declaration = registry?.statements.find(
    (node) =>
      ts.isClassDeclaration(node) &&
      node.name?.text === 'FeaturePreviewRegistry',
  );
  const bind = declaration?.members.find(
    (node) =>
      ts.isMethodDeclaration(node) && propertyName(node.name) === 'bind',
  );
  if (!bind)
    throw new Error(
      `Cannot resolve FeaturePreviewRegistry.bind in ${registryPath}`,
    );
  const ids = new Set();
  for (const file of program.getSourceFiles()) {
    const location = (node) => {
      const { line, character } = file.getLineAndCharacterOfPosition(
        node.getStart(file),
      );
      return `${toPosixPath(relative(root, file.fileName))}:${line + 1}:${character + 1}`;
    };
    for (const diagnostic of file.parseDiagnostics) {
      throw new Error(
        `${toPosixPath(relative(root, file.fileName))}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
      );
    }
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const expression = unwrap(node.expression);
        const name = ts.isPropertyAccessExpression(expression)
          ? expression.name.text
          : ts.isElementAccessExpression(expression) &&
              ts.isStringLiteral(expression.argumentExpression)
            ? expression.argumentExpression.text
            : undefined;
        if (name === 'bind') {
          const receiver = checker.getTypeAtLocation(expression.expression);
          const declarations = receiver.getProperty('bind')?.declarations ?? [];
          if (declarations.includes(bind)) {
            const fail = (message) => {
              throw new Error(`${location(node)}: preview bind ${message}`);
            };
            const definition = node.arguments[0] && unwrap(node.arguments[0]);
            if (!definition || !ts.isObjectLiteralExpression(definition)) {
              fail('must use an inline object with a string literal id');
            }
            if (definition.properties.some(ts.isSpreadAssignment)) {
              fail('cannot use spreads that could hide or override its id');
            }
            if (
              definition.properties.some(
                (property) =>
                  property.name && propertyName(property.name) === undefined,
              )
            ) {
              fail(
                'cannot use computed properties that could hide or override its id',
              );
            }
            const properties = definition.properties.filter(
              (property) =>
                property.name && propertyName(property.name) === 'id',
            );
            const property = properties[0];
            if (
              properties.length !== 1 ||
              !property ||
              !ts.isPropertyAssignment(property) ||
              !ts.isStringLiteral(unwrap(property.initializer))
            ) {
              fail('id must be exactly one string literal property');
            }
            const id = unwrap(property.initializer).text;
            if (!previewId.test(id))
              fail(`id '${id}' must be stable kebab-case`);
            ids.add(id);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return ids;
}

function documentedIds(root) {
  const markdown = readFileSync(join(root, settingsPath), 'utf8');
  const section = markdown.match(
    /^## Feature previews\s*\r?\n([\s\S]*?)(?=^#{1,2} |$(?![\s\S]))/m,
  )?.[1];
  if (section === undefined)
    throw new Error(`${settingsPath}: missing Feature previews section`);
  const lines = section.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\| ID \| Name \|/.test(line));
  if (
    header < 0 ||
    !/^\|(?:\s*:?-+:?\s*\|){4}\s*$/.test(lines[header + 1] ?? '')
  ) {
    throw new Error(
      `${settingsPath}: missing four-column offered previews table (ID, Name, what it does, cost/risk)`,
    );
  }
  const ids = new Set();
  for (const line of lines.slice(header + 2)) {
    if (!line.trim().startsWith('|')) break;
    const cells = line
      .trim()
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim());
    const id = cells[0]?.match(/^`([^`]+)`$/)?.[1];
    if (
      cells.length !== 4 ||
      !id ||
      !previewId.test(id) ||
      cells.some((cell) => !cell)
    ) {
      throw new Error(`${settingsPath}: invalid offered preview row: ${line}`);
    }
    if (ids.has(id))
      throw new Error(`${settingsPath}: duplicate preview row '${id}'`);
    ids.add(id);
  }
  return ids;
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1)
      throw new Error(
        'Usage: feature-preview-docs-check.mjs [repository-root]',
      );
    const root = resolve(
      args[0] ?? fileURLToPath(new URL('../', import.meta.url)),
    );
    const bound = boundIds(root);
    const documented = documentedIds(root);
    const problems = [
      ...[...bound]
        .filter((id) => !documented.has(id))
        .map((id) => `Missing preview row '${id}' in ${settingsPath}`),
      ...[...documented]
        .filter((id) => !bound.has(id))
        .map(
          (id) =>
            `Stale preview row '${id}' in ${settingsPath}: no registry bind in src-server`,
        ),
    ];
    if (problems.length) throw new Error(problems.join('\n'));
    console.log(`Feature preview docs match ${bound.size} bound preview(s).`);
  } catch (error) {
    console.error(`Feature preview docs check FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}
