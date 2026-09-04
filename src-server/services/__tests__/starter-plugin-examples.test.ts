import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { readPluginManifestFile } from '../plugins/plugin-manifest-loader.js';

const repoRoot = process.cwd();
const examplesDir = join(repoRoot, 'examples');
const registryManifestPath = join(examplesDir, 'registry', 'manifest.json');

const starterPlugins = [
  {
    id: 'getting-started-starter',
    displayName: 'Getting Started Starter',
    expectedTabs: ['start', 'patterns'],
    expectedComponents: ['getting-started-home', 'getting-started-patterns'],
    readmeTerms: ['useAgents()', 'useNavigation()', 'useToast()'],
  },
  {
    id: 'coding-starter',
    displayName: 'Coding Starter',
    expectedTabs: ['workspace', 'diff'],
    expectedComponents: ['coding-workspace', 'coding-diff-review'],
    readmeTerms: ['file-browser', 'terminal-output', 'diff-review'],
  },
  {
    id: 'knowledge-docs-starter',
    displayName: 'Knowledge Docs Starter',
    expectedTabs: ['library', 'ask', 'sources'],
    expectedComponents: [
      'knowledge-library',
      'knowledge-ask',
      'knowledge-sources',
    ],
    readmeTerms: ['knowledge namespace', 'document intake', 'source-review'],
  },
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

function registrationObject(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expression)) return expression;
  if (
    ts.isSatisfiesExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return registrationObject(expression.expression);
  }
  return undefined;
}

function componentRegistrations(sourceText: string, entrypointPath: string) {
  const sourceFile = ts.createSourceFile(
    entrypointPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const implementations = new Map<string, ts.FunctionLikeDeclaration>();
  let registrations: ts.ObjectLiteralExpression | undefined;

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      implementations.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (
        declaration.name.text === 'components' &&
        exported &&
        declaration.initializer
      ) {
        registrations = registrationObject(declaration.initializer);
      }
      if (
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        implementations.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  if (!registrations) {
    throw new Error(`${entrypointPath}: missing exported components object`);
  }

  const registered = new Map<string, ts.FunctionLikeDeclaration>();
  for (const property of registrations.properties) {
    if (
      !ts.isPropertyAssignment(property) &&
      !ts.isShorthandPropertyAssignment(property)
    ) {
      continue;
    }
    const componentName = propertyNameText(property.name);
    const implementationName = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : ts.isIdentifier(property.initializer)
        ? property.initializer.text
        : null;
    if (!componentName || !implementationName) continue;
    const implementation = implementations.get(implementationName);
    if (implementation) registered.set(componentName, implementation);
  }
  return { registered, sourceFile };
}

function exportedComponentRegistrations(entrypointPath: string) {
  return componentRegistrations(
    readFileSync(entrypointPath, 'utf-8'),
    entrypointPath,
  );
}

function hasRenderedImplementation(
  implementation: ts.FunctionLikeDeclaration,
): boolean {
  if (!implementation.body) return false;
  if (!ts.isBlock(implementation.body)) {
    return implementation.body.kind !== ts.SyntaxKind.NullKeyword;
  }
  let rendered = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      node.expression.kind !== ts.SyntaxKind.NullKeyword
    ) {
      rendered = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(implementation.body);
  return rendered;
}

describe('starter plugin examples', () => {
  test('minimal example installs as an immediately usable layout', async () => {
    const pluginDir = join(examplesDir, 'minimal-layout');
    const manifest = await readPluginManifestFile(
      join(pluginDir, 'plugin.json'),
    );
    const layout = readJson<{
      icon: string;
      tabs: Array<{ component: string }>;
    }>(join(pluginDir, manifest.layout?.source ?? 'missing-layout.json'));
    const entrypoint = readFileSync(
      join(pluginDir, manifest.entrypoint ?? ''),
      'utf-8',
    );

    expect(manifest.layout?.slug).toBe('minimal');
    expect(layout.icon).toBe('🧩');
    expect(layout.tabs.map((tab) => tab.component)).toEqual([
      'minimal-workspace',
    ]);
    expect(entrypoint).toContain("'minimal-workspace'");
  });

  test('registry manifest curates the Phase 2 starter set', () => {
    const registry = readJson<{
      plugins: Array<{
        id: string;
        displayName: string;
        description: string;
        source: string;
        version: string;
      }>;
    }>(registryManifestPath);

    for (const starter of starterPlugins) {
      const entry = registry.plugins.find((plugin) => plugin.id === starter.id);
      if (!entry) {
        throw new Error(`Missing starter plugin registry entry: ${starter.id}`);
      }
      expect(entry).toMatchObject({
        id: starter.id,
        displayName: starter.displayName,
        version: '1.0.0',
      });
      expect(entry.description.length).toBeGreaterThan(40);

      const sourceDir = resolve(dirname(registryManifestPath), entry.source);
      expect(sourceDir).toBe(join(examplesDir, starter.id));
      expect(existsSync(join(sourceDir, 'plugin.json'))).toBe(true);
    }
  });

  test('starter manifests and layout component references stay coherent', async () => {
    for (const starter of starterPlugins) {
      const pluginDir = join(examplesDir, starter.id);
      const manifest = await readPluginManifestFile(
        join(pluginDir, 'plugin.json'),
      );
      const layout = readJson<{
        tabs: Array<{ id: string; component: string }>;
      }>(join(pluginDir, manifest.layout?.source ?? 'missing-layout.json'));
      const entrypointPath = join(pluginDir, manifest.entrypoint ?? '');
      const entrypoint = readFileSync(entrypointPath, 'utf-8');

      expect(manifest).toMatchObject({
        name: starter.id,
        displayName: starter.displayName,
        version: '1.0.0',
      });
      expect(manifest.capabilities).toEqual(
        expect.arrayContaining(['chat', 'navigation']),
      );
      expect(manifest.permissions).toContain('navigation.dock');
      expect(existsSync(entrypointPath)).toBe(true);

      expect(layout.tabs.map((tab) => tab.id)).toEqual(starter.expectedTabs);
      expect(layout.tabs.map((tab) => tab.component)).toEqual(
        starter.expectedComponents,
      );
      for (const component of starter.expectedComponents) {
        expect(entrypoint).toContain(`'${component}'`);
      }
    }
  });

  /**
   * #765 D1 class pin, over the WHOLE bundled default registry rather than
   * one plugin. Every layout component a bundled plugin's layout declares
   * must be a key in its exported `components` object, backed by a component
   * function with rendered output. The old text search only proved that a
   * quoted name occurred somewhere in the entrypoint; a comment, constant,
   * or unrelated object could satisfy it without registering anything.
   * The plugin must also be buildable
   * by the host pipeline at all: an `entrypoint` (that is what produces
   * `dist/bundle.js` — without it the client PluginRegistry skips the plugin
   * and each declared component renders "Unsupported layout tab"), and no
   * `build` field (the host refuses manifest-controlled shell builds). The
   * install-path half of the defect — a registry face that materialized the
   * tree without ever building it — is pinned in registry.routes.test.ts.
   */
  test('every bundled default-registry plugin declares layout components its entrypoint registers', async () => {
    const defaultRegistry = readJson<{
      plugins: Array<{ id: string; source: string }>;
    }>(join(examplesDir, 'registry', 'default.json'));
    expect(defaultRegistry.plugins.length).toBeGreaterThan(0);

    for (const entry of defaultRegistry.plugins) {
      const pluginDir = resolve(examplesDir, 'registry', entry.source);
      const manifest = await readPluginManifestFile(
        join(pluginDir, 'plugin.json'),
      );

      expect(manifest.build, `${entry.id}: manifest.build`).toBeUndefined();

      if (!manifest.layout) continue;
      expect(
        manifest.entrypoint,
        `${entry.id}: a layout plugin needs an entrypoint to build a bundle`,
      ).toBeTruthy();
      const entrypointPath = join(pluginDir, manifest.entrypoint ?? '');
      const { registered } = exportedComponentRegistrations(entrypointPath);
      const layout = readJson<{
        tabs?: Array<{ id: string; component?: unknown }>;
      }>(join(pluginDir, manifest.layout.source));
      for (const tab of layout.tabs ?? []) {
        // Only plain-string components are plugin components the bundle must
        // register; builtin/mcp references resolve elsewhere.
        if (typeof tab.component !== 'string') continue;
        const implementation = registered.get(tab.component);
        expect(
          implementation,
          `${entry.id}: layout tab '${tab.id}' declares component '${tab.component}' the entrypoint never registers`,
        ).toBeDefined();
        expect(
          implementation && hasRenderedImplementation(implementation),
          `${entry.id}: registered component '${tab.component}' has no rendered implementation`,
        ).toBe(true);
      }
    }
  });

  test('component registration proof does not accept a name mentioned outside the exported map', () => {
    const { registered } = componentRegistrations(
      [
        'const Missing = () => <main>real UI</main>;',
        "const declaredName = 'declared-but-unregistered';",
        "export const components = { 'something-else': Missing };",
      ].join('\n'),
      'false-positive.tsx',
    );

    expect(registered.has('declared-but-unregistered')).toBe(false);
    expect(registered.has('something-else')).toBe(true);
  });

  test('starter READMEs explain copyable scope and local registry install', () => {
    for (const starter of starterPlugins) {
      const readme = readFileSync(
        join(examplesDir, starter.id, 'README.md'),
        'utf-8',
      );

      expect(readme).toContain(`# ${starter.displayName}`);
      expect(readme).toContain('## What It Demonstrates');
      expect(readme).toContain('## Run It');
      expect(readme).toContain(`station registry install ${starter.id}`);
      for (const term of starter.readmeTerms) {
        expect(readme).toContain(term);
      }
    }
  });
});
