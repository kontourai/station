import { readFileSync } from 'node:fs';
import ts from 'typescript-api';

export function createRequiredSourceReader({
  baseUrl,
  reportMissing,
  readSource = (sourceUrl) => readFileSync(sourceUrl, 'utf8'),
}) {
  if (typeof reportMissing !== 'function') {
    throw new TypeError('reportMissing must be a function');
  }

  return (relativePath) => {
    const sourceUrl = new URL(relativePath, baseUrl);
    try {
      return readSource(sourceUrl);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      reportMissing(relativePath);
      return '';
    }
  };
}

/** Calls through named bindings from one module, excluding type-only imports. */
export function collectCalledModuleImports(source, moduleName) {
  const tree = ts.createSourceFile(
    'guardrail-source.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const options = { noLib: true, noResolve: true };
  const host = {
    ...ts.createCompilerHost(options),
    getSourceFile: (name) => (name === tree.fileName ? tree : undefined),
  };
  const symbols = ts
    .createProgram([tree.fileName], options, host)
    .getTypeChecker();
  const imported = new Map();
  const called = new Set();
  const register = ({ name, propertyName }) => {
    const binding = symbols.getSymbolAtLocation(name);
    if (binding) imported.set(binding, (propertyName ?? name).text);
  };
  const matchesModule = (node) =>
    node && ts.isStringLiteral(node) && node.text === moduleName;
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && matchesModule(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      if (bindings && !clause.isTypeOnly && ts.isNamedImports(bindings)) {
        for (const item of bindings.elements) {
          if (!item.isTypeOnly) register(item);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const initializer = node.initializer;
      const call =
        initializer && ts.isAwaitExpression(initializer)
          ? initializer.expression
          : initializer;
      if (
        call &&
        ts.isCallExpression(call) &&
        call.expression.kind === ts.SyntaxKind.ImportKeyword &&
        matchesModule(call.arguments[0])
      ) {
        for (const item of node.name.elements) {
          if (ts.isIdentifier(item.name)) register(item);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      called.add(symbols.getSymbolAtLocation(node.expression));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return new Set(
    [...imported]
      .filter(([local]) => called.has(local))
      .map(([, name]) => name),
  );
}

const PANE_HOST_COMPOSITION_REQUIREMENTS = [
  {
    sourceKey: 'projectLayoutRenderer',
    sourceLabel: 'ProjectLayoutRenderer',
    marker: "from '../workspace-panes/builtinWorkspacePaneRegistry'",
    expectation: 'resolve builtin panes through builtinWorkspacePaneRegistry',
  },
  {
    sourceKey: 'projectLayoutRenderer',
    sourceLabel: 'ProjectLayoutRenderer',
    marker: '<WorkspacePaneHost',
    expectation: 'own the WorkspacePaneHost composition boundary',
  },
  {
    sourceKey: 'projectLayoutRenderer',
    sourceLabel: 'ProjectLayoutRenderer',
    marker: `const Pane =
              descriptor &&
              getBuiltinWorkspacePaneRenderer(`,
    expectation: 'delegate builtin renderer selection to the pane registry',
  },
  {
    sourceKey: 'builtinWorkspacePaneRegistry',
    sourceLabel: 'builtinWorkspacePaneRegistry',
    marker: 'export function getBuiltinWorkspacePaneRenderer(',
    expectation: 'export the builtin renderer selection seam',
  },
  ...[
    [
      '[WORKSPACE_CODING_FILE_BROWSER_PANE_RENDERER_NAME]: CodingFileBrowserPane,',
      'map file-browser panes to CodingFileBrowserPane',
    ],
    [
      '[WORKSPACE_CODING_DIFF_PANE_RENDERER_NAME]: CodingDiffPane,',
      'map diff panes to CodingDiffPane',
    ],
    [
      '[WORKSPACE_CODING_TERMINAL_PANE_RENDERER_NAME]: CodingTerminalWorkspacePane,',
      'map terminal panes to CodingTerminalWorkspacePane',
    ],
  ].map(([marker, expectation]) => ({
    sourceKey: 'builtinWorkspacePaneRegistry',
    sourceLabel: 'builtinWorkspacePaneRegistry',
    marker,
    expectation,
  })),
  {
    sourceKey: 'builtinWorkspacePaneRegistry',
    sourceLabel: 'getBuiltinWorkspacePaneRenderer',
    marker: 'builtinWorkspacePaneRegistry[',
    expectation: 'delegate selection to the builtin workspace pane registry',
  },
];

/**
 * The current pane-host invariant: the project renderer owns host composition,
 * while the builtin registry owns builtin renderer selection and leaf panels.
 */
export function collectPaneHostCompositionFindings({
  projectLayoutRenderer,
  builtinWorkspacePaneRegistry,
}) {
  // Markers are code, not layout: compare with whitespace runs collapsed so a
  // re-indent (#3229 moved the Pane resolution out of a nested callback) does
  // not read as the delegation being removed.
  const collapse = (text) => (text ?? '').replace(/\s+/g, ' ');
  const sources = {
    projectLayoutRenderer: collapse(projectLayoutRenderer),
    builtinWorkspacePaneRegistry: collapse(builtinWorkspacePaneRegistry),
  };
  return PANE_HOST_COMPOSITION_REQUIREMENTS.flatMap((requirement) =>
    sources[requirement.sourceKey].includes(collapse(requirement.marker))
      ? []
      : [`${requirement.sourceLabel} must ${requirement.expectation}.`],
  );
}
