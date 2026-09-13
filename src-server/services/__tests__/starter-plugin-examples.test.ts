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
  /**
   * The minimal example is the first-party portable starter (#265): an Agent
   * Plugins 1.0 package whose only Station contribution is one Workspace Pane.
   * The manifest is read through the loader the product installs with, so
   * the assertions bind to what Station admits rather than to a hand-read
   * JSON shape: the `minimal-layout` package identity survives the migration,
   * the single Pane names that package as its provenance and a
   * `plugin-component` renderer the entrypoint really registers with rendered
   * output, and no legacy `layout` is co-declared. The loader refuses a
   * manifest that declares both channels, but an unreferenced layout.json on
   * disk would be inert to it, so the file's absence is pinned separately.
   */
  test('minimal example declares one portable Workspace Pane its entrypoint renders', async () => {
    const pluginDir = join(examplesDir, 'minimal-layout');
    const manifest = await readPluginManifestFile(
      join(pluginDir, 'plugin.json'),
    );

    expect(manifest).toMatchObject({
      name: 'minimal-layout',
      displayName: 'Minimal Workspace',
      version: '1.0.0',
    });
    expect(manifest.layout).toBeUndefined();
    expect(manifest.layouts).toBeUndefined();
    expect(manifest.build).toBeUndefined();
    expect(existsSync(join(pluginDir, 'layout.json'))).toBe(false);
    expect(manifest.permissions).toContain('navigation.dock');

    const panes = manifest.workspacePanes ?? [];
    expect(panes).toHaveLength(1);
    expect(panes[0]).toMatchObject({
      id: 'pane:plugin%3Aminimal-layout:minimal:workspace',
      name: 'Minimal Workspace',
      renderer: { kind: 'plugin-component', name: 'minimal-workspace' },
      provenance: { origin: 'plugin', pluginId: 'minimal-layout' },
    });

    expect(manifest.entrypoint).toBeTruthy();
    const entrypointPath = join(pluginDir, manifest.entrypoint ?? '');
    expect(existsSync(entrypointPath)).toBe(true);
    const { registered } = exportedComponentRegistrations(entrypointPath);
    const implementation = registered.get('minimal-workspace');
    expect(implementation).toBeDefined();
    expect(implementation && hasRenderedImplementation(implementation)).toBe(
      true,
    );
  });

  /**
   * The coding example is the second portable starter (#265): two Project
   * Workspace Panes plus one package-level `workspacePaneHost` contribution.
   * Read through the product loader for the same reason as the minimal case.
   * The two Panes must stay distinct at the descriptor AND renderer level: a
   * duplicated `rendererId` would collapse both Panes onto one renderer while
   * every per-Pane assertion below still passed, so ids and renderer ids are
   * pinned as exact sets rather than by count. The host contribution is
   * pinned as one action and one own-plugin default Agent, never per Pane.
   */
  test('coding example declares two portable Workspace Panes and one host contribution its entrypoint renders', async () => {
    const pluginDir = join(examplesDir, 'coding-starter');
    const manifest = await readPluginManifestFile(
      join(pluginDir, 'plugin.json'),
    );

    expect(manifest).toMatchObject({
      name: 'coding-starter',
      displayName: 'Coding Starter',
      version: '1.0.0',
    });
    expect(manifest.layout).toBeUndefined();
    expect(manifest.layouts).toBeUndefined();
    expect(manifest.build).toBeUndefined();
    expect(existsSync(join(pluginDir, 'layout.json'))).toBe(false);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['navigation.dock', 'agents.invoke']),
    );

    const panes = manifest.workspacePanes ?? [];
    expect(panes).toHaveLength(2);
    expect(panes.map((pane) => pane.id).sort()).toEqual([
      'pane:plugin%3Acoding-starter:coding:diff',
      'pane:plugin%3Acoding-starter:coding:workspace',
    ]);
    expect(panes.map((pane) => pane.rendererId).sort()).toEqual([
      'renderer:plugin%3Acoding-starter:plugin-component:coding-diff-review',
      'renderer:plugin%3Acoding-starter:plugin-component:coding-workspace',
    ]);
    const byId = new Map(panes.map((pane) => [pane.id, pane]));
    expect(
      byId.get('pane:plugin%3Acoding-starter:coding:workspace'),
    ).toMatchObject({
      name: 'Coding Workspace',
      renderer: { kind: 'plugin-component', name: 'coding-workspace' },
    });
    expect(byId.get('pane:plugin%3Acoding-starter:coding:diff')).toMatchObject({
      name: 'Coding Diff Review',
      renderer: { kind: 'plugin-component', name: 'coding-diff-review' },
    });
    for (const pane of panes) {
      expect(pane.provenance).toEqual({
        origin: 'plugin',
        pluginId: 'coding-starter',
      });
    }

    expect(manifest.workspacePaneHost).toBeDefined();
    const host = manifest.workspacePaneHost;
    expect(host?.actions.map((action) => action.id)).toEqual(['review-diff']);
    expect(host?.agentSelection.defaultAgent).toEqual({
      kind: 'own-plugin-agent',
      agentId: 'coding-starter-assistant',
    });
    expect(manifest.agents?.map((agent) => agent.slug)).toEqual([
      'coding-starter-assistant',
    ]);

    expect(manifest.entrypoint).toBeTruthy();
    const entrypointPath = join(pluginDir, manifest.entrypoint ?? '');
    expect(existsSync(entrypointPath)).toBe(true);
    const { registered } = exportedComponentRegistrations(entrypointPath);
    for (const pane of panes) {
      if (pane.renderer.kind !== 'plugin-component') {
        throw new Error(`${pane.id}: expected a plugin-component renderer`);
      }
      const implementation = registered.get(pane.renderer.name);
      expect(implementation, `${pane.id}: ${pane.renderer.name}`).toBeDefined();
      expect(
        implementation && hasRenderedImplementation(implementation),
        `${pane.id}: ${pane.renderer.name} has no rendered implementation`,
      ).toBe(true);
    }
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
   * one plugin. Every plugin component a bundled plugin declares — through a
   * legacy layout tab or a Workspace Pane's `plugin-component` renderer —
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
  test('every bundled default-registry plugin declares plugin components its entrypoint registers', async () => {
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

      const declared: Array<{ site: string; component: string }> = [];
      if (manifest.layout) {
        const layout = readJson<{
          tabs?: Array<{ id: string; component?: unknown }>;
        }>(join(pluginDir, manifest.layout.source));
        for (const tab of layout.tabs ?? []) {
          // Only plain-string components are plugin components the bundle must
          // register; builtin/mcp references resolve elsewhere.
          if (typeof tab.component !== 'string') continue;
          declared.push({
            site: `layout tab '${tab.id}'`,
            component: tab.component,
          });
        }
      }
      for (const pane of manifest.workspacePanes ?? []) {
        if (pane.renderer.kind !== 'plugin-component') continue;
        declared.push({
          site: `workspace pane '${pane.id}'`,
          component: pane.renderer.name,
        });
      }
      if (declared.length === 0) continue;

      expect(
        manifest.entrypoint,
        `${entry.id}: a plugin declaring plugin components needs an entrypoint to build a bundle`,
      ).toBeTruthy();
      const entrypointPath = join(pluginDir, manifest.entrypoint ?? '');
      const { registered } = exportedComponentRegistrations(entrypointPath);
      for (const { site, component } of declared) {
        const implementation = registered.get(component);
        expect(
          implementation,
          `${entry.id}: ${site} declares component '${component}' the entrypoint never registers`,
        ).toBeDefined();
        expect(
          implementation && hasRenderedImplementation(implementation),
          `${entry.id}: registered component '${component}' has no rendered implementation`,
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

  /**
   * The Pane-era starters keep the same README contract — what the package
   * demonstrates, how to install it locally, and what a copier takes with
   * them — under the sections their rewritten READMEs actually carry. The
   * install path is `station plugin install .` from the package directory
   * rather than the registry verb, and scope is a package/migration section
   * rather than a "Run It" recipe. Each starter's own surface is named so a
   * README that dropped a Pane or the review action would go red.
   */
  test('Pane-era starter READMEs explain local install and copyable package scope', () => {
    const paneStarters = [
      {
        id: 'coding-starter',
        title: '# Coding Starter',
        scopeHeading: '## Package and migration',
        terms: [
          'Coding Workspace',
          'Coding Diff Review',
          'Review current diff',
          'coding-starter-assistant',
          'navigation.dock',
          'agents.invoke',
        ],
      },
      {
        id: 'minimal-layout',
        title: '# Minimal Workspace',
        scopeHeading: '## Develop and package',
        terms: ['navigation.dock'],
      },
    ];

    for (const starter of paneStarters) {
      // Prose is hard-wrapped, so phrases are matched across line breaks.
      const readme = readFileSync(
        join(examplesDir, starter.id, 'README.md'),
        'utf-8',
      ).replace(/\s+/g, ' ');

      expect(readme, starter.id).toContain(starter.title);
      expect(readme, starter.id).toContain('## Install and place');
      expect(readme, starter.id).toContain(starter.scopeHeading);
      expect(readme, starter.id).toContain('station plugin install .');
      expect(readme, starter.id).not.toContain(
        `station registry install ${starter.id}`,
      );
      for (const term of starter.terms) {
        expect(readme, `${starter.id}: ${term}`).toContain(term);
      }
    }
  });
});
