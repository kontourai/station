import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { DistributionProfileService } from '../plugins/distribution-profile-service.js';
import { readPluginManifestFile } from '../plugins/plugin-manifest-loader.js';
import { readCurrentWorkspacePaneCatalog } from '../projects/workspace-pane-catalog.js';

const repoRoot = process.cwd();
const examplesDir = join(repoRoot, 'examples');
const registryManifestPath = join(examplesDir, 'registry', 'manifest.json');

const starterPlugins = [
  {
    id: 'getting-started-starter',
    displayName: 'Getting Started Starter',
    expectedPaneIds: [
      'pane:plugin%3Agetting-started-starter:getting-started:start',
      'pane:plugin%3Agetting-started-starter:getting-started:patterns',
    ],
    expectedComponents: ['getting-started-home', 'getting-started-patterns'],
    readmeTerms: ['useAgents()', 'useNavigation()', 'useToast()'],
  },
  {
    id: 'coding-starter',
    displayName: 'Coding Starter',
    expectedPaneIds: [
      'pane:plugin%3Acoding-starter:coding:workspace',
      'pane:plugin%3Acoding-starter:coding:diff',
    ],
    expectedComponents: ['coding-workspace', 'coding-diff-review'],
    readmeTerms: ['file-browser', 'terminal-output', 'diff-review'],
  },
  {
    id: 'knowledge-docs-starter',
    displayName: 'Knowledge Docs Starter',
    expectedPaneIds: [
      'pane:plugin%3Aknowledge-docs-starter:knowledge-docs:library',
      'pane:plugin%3Aknowledge-docs-starter:knowledge-docs:ask',
      'pane:plugin%3Aknowledge-docs-starter:knowledge-docs:sources',
    ],
    expectedComponents: [
      'knowledge-library',
      'knowledge-ask',
      'knowledge-sources',
    ],
    readmeTerms: ['knowledge namespace', 'document intake', 'source-review'],
  },
];

const migratedPaneExamples = [
  'builder-delivery-viewer',
  'coding-starter',
  'demo-layout',
  'enterprise-layout',
  'fieldwork-review',
  'getting-started-starter',
  'knowledge-docs-starter',
  'knowledge-library',
  'meeting-notes',
  'minimal-layout',
  'survey-review-workbench',
] as const;

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

  const registered = new Map<string, ts.FunctionLikeDeclaration | null>();
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
        : ts.isCallExpression(property.initializer) &&
            ts.isIdentifier(property.initializer.expression)
          ? property.initializer.expression.text
          : null;
    if (!componentName || !implementationName) continue;
    registered.set(
      componentName,
      implementations.get(implementationName) ?? null,
    );
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
  test('minimal example declares an immediately usable Project pane', async () => {
    const pluginDir = join(examplesDir, 'minimal-layout');
    const manifest = await readPluginManifestFile(
      join(pluginDir, 'plugin.json'),
    );
    const entrypoint = readFileSync(
      join(pluginDir, manifest.entrypoint ?? ''),
      'utf-8',
    );

    expect(manifest.layout).toBeUndefined();
    expect(manifest.layouts).toBeUndefined();
    expect(manifest.workspacePanes).toMatchObject([
      {
        version: '1.0',
        id: 'pane:plugin%3Aminimal-layout:minimal:workspace',
        renderer: { kind: 'plugin-component', name: 'minimal-workspace' },
        modes: [{ id: 'default', contextRequirement: { project: true } }],
        provenance: { origin: 'plugin', pluginId: 'minimal-layout' },
      },
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

  test('starter manifests and Workspace Pane renderer references stay coherent', async () => {
    for (const starter of starterPlugins) {
      const pluginDir = join(examplesDir, starter.id);
      const manifest = await readPluginManifestFile(
        join(pluginDir, 'plugin.json'),
      );
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

      expect(manifest.layout).toBeUndefined();
      expect(manifest.layouts).toBeUndefined();
      expect(manifest.workspacePanes?.map((pane) => pane.id)).toEqual(
        starter.expectedPaneIds,
      );
      expect(
        manifest.workspacePanes?.map((pane) =>
          pane.renderer.kind === 'plugin-component'
            ? pane.renderer.name
            : undefined,
        ),
      ).toEqual(starter.expectedComponents);
      for (const component of starter.expectedComponents) {
        expect(entrypoint).toContain(`'${component}'`);
      }
    }
  });

  /**
   * Every first-party plugin-component Pane must be a key in its exported
   * `components` object, backed by a component function with rendered output.
   * This walks meeting-notes and knowledge-library as well as both bundled
   * registry catalogs so a newly added example cannot escape the check.
   */
  test('every first-party pane example registers each plugin-component renderer', async () => {
    const exampleIds = readdirSync(examplesDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(join(examplesDir, entry.name, 'plugin.json')),
      )
      .map((entry) => entry.name)
      .sort();
    expect(exampleIds.length).toBeGreaterThan(0);

    for (const id of exampleIds) {
      const pluginDir = join(examplesDir, id);
      const manifest = await readPluginManifestFile(
        join(pluginDir, 'plugin.json'),
      );

      expect(manifest.layout, `${id}: manifest.layout`).toBeUndefined();
      expect(manifest.layouts, `${id}: manifest.layouts`).toBeUndefined();
      const pluginComponentPanes = (manifest.workspacePanes ?? []).filter(
        (pane) => pane.renderer.kind === 'plugin-component',
      );
      if (pluginComponentPanes.length === 0) continue;

      expect(
        manifest.entrypoint,
        `${id}: a plugin-component pane needs an entrypoint to build a bundle`,
      ).toBeTruthy();
      const entrypointPath = join(pluginDir, manifest.entrypoint ?? '');
      const { registered } = exportedComponentRegistrations(entrypointPath);
      for (const pane of pluginComponentPanes) {
        if (pane.renderer.kind !== 'plugin-component') continue;
        const registeredRenderer = registered.has(pane.renderer.name);
        const implementation = registered.get(pane.renderer.name);
        expect(
          registeredRenderer,
          `${id}: pane '${pane.id}' declares renderer '${pane.renderer.name}' the entrypoint never registers`,
        ).toBe(true);
        if (implementation) {
          expect(
            hasRenderedImplementation(implementation),
            `${id}: registered renderer '${pane.renderer.name}' has no rendered implementation`,
          ).toBe(true);
        }
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

  test('materialized examples receive Project-bound instances and disabled panes stay discoverable', () => {
    const projectHome = mkdtempSync(join(tmpdir(), 'station-pane-examples-'));
    try {
      const pluginsDir = join(projectHome, 'plugins');
      mkdirSync(pluginsDir, { recursive: true });
      for (const id of migratedPaneExamples) {
        cpSync(join(examplesDir, id), join(pluginsDir, id), {
          recursive: true,
        });
      }

      const service = new DistributionProfileService(projectHome);
      const contributions = service.listPluginWorkspacePaneContributions();
      expect(service.listPluginWorkspacePaneContributions()).toEqual(
        contributions,
      );
      expect(new Set(contributions.map((entry) => entry.pluginName))).toEqual(
        new Set(migratedPaneExamples),
      );
      const directCatalogSource = (current: DistributionProfileService) =>
        ({
          listLayouts: () => [],
          listPluginWorkspacePaneContributions: () =>
            current.listPluginWorkspacePaneContributions(),
          resolveForCatalog: () => {
            throw new Error('direct Pane declarations must not read a Layout');
          },
        }) as unknown as DistributionProfileService;
      const snapshot = readCurrentWorkspacePaneCatalog(
        directCatalogSource(service),
        'project-examples',
      );
      for (const contribution of contributions) {
        expect(snapshot.descriptors).toContainEqual(contribution.descriptor);
        expect(snapshot.instances).toContainEqual(
          expect.objectContaining({
            descriptorId: contribution.descriptor.id,
            instanceId: `instance:plugin:project-examples:${contribution.id}`,
            stateKey: `state:plugin:project-examples:${contribution.id}`,
            boundContext: expect.objectContaining({
              projectId: 'project-examples',
              contribution: contribution.contribution,
            }),
          }),
        );
        expect(contribution.contribution.provenance).toEqual({
          origin: 'plugin',
          pluginId: contribution.pluginName,
        });
        expect(contribution.descriptor.placement).toMatchObject({
          supportedRegions: ['primary'],
          preferredRegion: 'primary',
        });
      }

      const disabled = contributions.find(
        (entry) => entry.pluginName === 'minimal-layout',
      );
      expect(disabled).toBeDefined();
      mkdirSync(join(projectHome, 'config'), { recursive: true });
      writeFileSync(
        join(projectHome, 'config', 'distribution-lifecycle.json'),
        JSON.stringify({
          version: 1,
          items: { [disabled!.id]: { enabled: false } },
        }),
      );
      const disabledSnapshot = readCurrentWorkspacePaneCatalog(
        directCatalogSource(new DistributionProfileService(projectHome)),
        'project-examples',
      );
      expect(disabledSnapshot.descriptors).toContainEqual(disabled!.descriptor);
      expect(
        disabledSnapshot.availability.find(
          (entry) => entry.descriptorId === disabled!.descriptor.id,
        ),
      ).toMatchObject({
        input: { distribution: 'disabled' },
        availability: {
          state: 'not-configured',
          reason: { code: 'distribution-disabled' },
        },
      });
    } finally {
      rmSync(projectHome, { recursive: true, force: true });
    }
  });
});
