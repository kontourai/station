import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { knowledgeRootIncarnationKey } from '@kontourai/station-shared/knowledge-root-identity';
import ts from 'typescript-api';
import { describe, expect, test } from 'vitest';
import { serializeSDKMock } from '../dev/sdk-mock.js';
import { buildDevSharedRuntimeScript } from '../dev/template-scripts.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const examplesRoot = fileURLToPath(
  new URL('../../../../examples/', import.meta.url),
);

/** The SDK specifiers a plugin build leaves to the host (shared `build.ts`). */
const HOST_SDK_SPECIFIERS = [
  '@kontourai/station-sdk',
  '@kontourai/station-sdk/agent',
  '@kontourai/station-sdk/client',
  '@kontourai/station-sdk/voice',
] as const;

/**
 * Examples `station dev` can preview: every example with a plugin manifest,
 * plus the guide snippets, which are plugin code quoted by the docs.
 */
function previewableExampleDirectories(): string[] {
  return readdirSync(examplesRoot)
    .map((name) => join(examplesRoot, name))
    .filter(
      (directory) =>
        statSync(directory).isDirectory() &&
        existsSync(join(directory, 'src')) &&
        (existsSync(join(directory, 'plugin.json')) ||
          directory.endsWith('docs-snippets')),
    );
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === '__tests__' || entry.name === 'node_modules'
        ? []
        : sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name)
      ? [path]
      : [];
  });
}

/** Value names (types are erased) each file imports or re-exports from the host SDK. */
function hostSdkValueImports(file: string): Array<[string, string]> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Array<[string, string]> = [];
  for (const statement of source.statements) {
    const specifier =
      (ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (
      !specifier ||
      !(HOST_SDK_SPECIFIERS as readonly string[]).includes(specifier)
    )
      continue;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          found.push([specifier, (element.propertyName ?? element.name).text]);
        }
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        found.push([specifier, (element.propertyName ?? element.name).text]);
      }
    }
  }
  return found;
}

function exampleImports(): Map<string, Set<string>> {
  const imports = new Map<string, Set<string>>();
  for (const directory of previewableExampleDirectories()) {
    for (const file of sourceFiles(join(directory, 'src'))) {
      for (const [specifier, name] of hostSdkValueImports(file)) {
        const key = `${specifier} ${name}`;
        const users = imports.get(key) ?? new Set<string>();
        users.add(relative(repoRoot, file));
        imports.set(key, users);
      }
    }
  }
  return imports;
}

/** Run the harness's shared-runtime script and return what each specifier resolves to. */
function harnessSharedModules(): Record<string, Record<string, unknown>> {
  const element = () => ({ appendChild() {}, remove() {}, className: '' });
  const window: Record<string, unknown> = {};
  runInNewContext(
    buildDevSharedRuntimeScript(serializeSDKMock({ layoutSlug: 'example' })),
    {
      window,
      document: { createElement: element, body: element() },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      setTimeout,
      Proxy,
    },
  );
  return window.__station_ai_shared as Record<string, Record<string, unknown>>;
}

describe('station dev SDK mock', () => {
  test('exposes every SDK value a previewable example imports', () => {
    const imports = exampleImports();
    // A broken scan would vacuously pass; these are imported today.
    expect(imports.has('@kontourai/station-sdk useKnowledgeRecordQuery')).toBe(
      true,
    );
    expect(
      imports.has('@kontourai/station-sdk/voice voiceSessionAdapterRegistry'),
    ).toBe(true);

    const shared = harnessSharedModules();
    const missing = [...imports]
      .filter(([key]) => {
        const [specifier, name] = key.split(' ');
        return shared[specifier]?.[name] === undefined;
      })
      .map(([key, users]) => `${key} (${[...users].join(', ')})`);
    expect(missing).toEqual([]);
  });

  test('the mock pure helpers match the SDK they stand in for', () => {
    const sdk = harnessSharedModules()['@kontourai/station-sdk'] as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const personal = { scope: { kind: 'personal' } };
    const project = {
      id: 'root-1',
      scope: { kind: 'project', projectSlug: 'alpha' },
      adapterId: 'kit',
      storeRoot: '/store',
      displayName: 'Alpha',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(sdk.isRelevantKnowledgeRoot(personal, null)).toBe(true);
    expect(sdk.isRelevantKnowledgeRoot(project, 'alpha')).toBe(true);
    expect(sdk.isRelevantKnowledgeRoot(project, 'beta')).toBe(false);
    expect(sdk.isRelevantKnowledgeRoot(project, null)).toBe(false);
    expect(sdk.knowledgeRootIncarnationKey(project)).toBe(
      knowledgeRootIncarnationKey(project as never),
    );
    const freshness = (record: Record<string, unknown>) =>
      sdk.knowledgeFreshnessLabel(sdk.knowledgeRecordFreshness(record));
    expect(freshness({ created_at: '2026-01-01T00:00:00.000Z' })).toBe(
      'No expiry declared',
    );
    expect(
      freshness({ created_at: '2026-01-01T00:00:00.000Z', ttl_seconds: 60 }),
    ).toBe('Expires at 2026-01-01T00:01:00.000Z');
    expect(freshness({ expires_at: 'soon', created_at: 'x' })).toBe(
      'Invalid expiry declaration: soon',
    );
    expect(sdk.knowledgeRootIncarnationKey(project)).toBe(
      '["root-1","project","alpha","kit","/store","Alpha","2026-01-01T00:00:00.000Z"]',
    );
  });
});
