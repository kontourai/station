import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript-api';

/** Concrete implementations across production src-server TypeScript, not adapter references. */
export function providerShapeImplementations(root: string): string[] {
  const serverRoot = join(root, 'src-server');
  const providerRoot = join(serverRoot, 'providers');
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['__tests__', 'tests', '__test-utils__'].includes(entry.name))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (
        /\.(?:[cm]?ts|tsx)$/.test(entry.name) &&
        !/\.(?:test|spec|d)\.(?:[cm]?ts|tsx)$/.test(entry.name)
      )
        files.push(path);
    }
  };
  walk(serverRoot);
  const config = ts.readConfigFile(
    join(root, 'tsconfig.json'),
    ts.sys.readFile,
  );
  if (config.error)
    throw new Error(
      ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
    );
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const shapeFile = program.getSourceFile(
    join(providerRoot, 'adapter-shape.ts'),
  );
  const declaration = shapeFile?.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === 'ProviderAdapterShape',
  );
  if (!declaration)
    throw new Error('ProviderAdapterShape declaration was not resolved');
  const target = checker.getTypeAtLocation(declaration);
  const shape = (type: ts.Type | undefined) =>
    type !== undefined &&
    !(
      type.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
    ) &&
    checker.getPropertyOfType(type, 'sendTurn') !== undefined &&
    checker.isTypeAssignableTo(type, target);
  const found: string[] = [];
  for (const file of files) {
    const source = program.getSourceFile(resolve(file));
    if (!source) throw new Error(`Compiler did not load ${file}`);
    const visit = (node: ts.Node) => {
      const isClass = ts.isClassDeclaration(node) || ts.isClassExpression(node);
      const isObject = ts.isObjectLiteralExpression(node);
      if (isClass || isObject) {
        const abstract =
          isClass &&
          ts
            .getModifiers(node)
            ?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword,
            );
        const raw = checker.getTypeAtLocation(node);
        const type = isClass
          ? (raw.getConstructSignatures()[0]?.getReturnType() ?? raw)
          : raw;
        // Context catches declared-but-incomplete object implementations too;
        // assignability also catches an unannotated structural implementation.
        const contextual = isObject
          ? checker.getContextualType(node)
          : undefined;
        const heritage =
          isClass &&
          node.heritageClauses?.some((clause) =>
            clause.types.some((type) => shape(checker.getTypeAtLocation(type))),
          );
        if (!abstract && (shape(type) || shape(contextual) || heritage)) {
          let owner: ts.Node = node;
          while (
            ts.isParenthesizedExpression(owner.parent) ||
            ts.isSatisfiesExpression(owner.parent) ||
            ts.isAsExpression(owner.parent)
          )
            owner = owner.parent;
          const named =
            isClass && node.name
              ? node.name.text
              : ts.isVariableDeclaration(owner.parent)
                ? owner.parent.name.getText(source)
                : `anonymous@${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
          found.push(
            `${relative(serverRoot, file).replaceAll('\\', '/')}#${named}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found.sort();
}
