/// <reference types="vite/client" />

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the #591 bug class: a hook/type family lands in
 * packages/sdk/src/query-domains/<file>.ts, gets aggregated by
 * queries.ts, but index.ts's manually curated named-export list never
 * picks it up — so the published @kontourai/station-sdk surface silently
 * lacks it. This already happened once for the `workflowTasks` family
 * (fixed in #582) and again for several more families in #591's first
 * pass.
 *
 * PUBLIC_QUERY_DOMAINS below is a checked-in manifest, not derived from
 * queries.ts's own `from './query-domains/x'` specifiers. An earlier
 * version of this guard parsed that specifier list to decide which
 * modules to check — but that made the check self-referential: a wholly
 * new query-domains module that queries.ts never sources at all (the
 * exact shape of the #582/#591 bug, one layer up) would be invisible to
 * a guard built that way. Deriving the domain list independently, and
 * separately requiring every file in query-domains/ to be classified
 * (public or internal) below, closes that hole: an unclassified new file
 * fails the guard instead of silently passing.
 */
const PUBLIC_QUERY_DOMAINS = [
  'acpWorkspace',
  'agentAdmin',
  'answerShares',
  'analytics',
  'answerShares',
  'attention',
  'board',
  'catalog',
  'chatRuntime',
  'devicePairingRequests',
  'diffComments',
  'featurePreviews',
  'flowRuns',
  'peerCredentials',
  'knowledgeStores',
  'knownEnvironments',
  'notifications',
  'operatingState',
  'plugins',
  'projectData',
  'projectTaskRooms',
  'proposedChanges',
  'pullRequests',
  'reviewEvidence',
  'scheduler',
  'skills',
  'sshEnvironments',
  'systemRuntime',
  'taskGraph',
  'trustBundles',
  'veritasReadiness',
  'workflowTasks',
  'workItems',
  'workspace',
];

/**
 * Modules whose entire export surface is an internal implementation
 * detail — raw fetchers/mappers consumed by one of the PUBLIC_QUERY_DOMAINS
 * wrapper modules above, never intended as a standalone plugin-facing
 * import. Every entry here is a reviewed decision, not a default; see the
 * inline reason.
 */
const INTERNAL_QUERY_DOMAINS: Record<string, string> = {
  catalogRequests:
    "backs catalog.ts's hooks internally; its raw fetchers are deliberately not public.",
  chatRuntimeCoding:
    'implementation detail folded into chatRuntime.ts via `export *`.',
  chatRuntimeConversations:
    'implementation detail folded into chatRuntime.ts via `export *`.',
  chatRuntimeDevice:
    'implementation detail folded into chatRuntime.ts via `export *`.',
  chatRuntimeOrchestration:
    "implementation detail folded into chatRuntime.ts via `export *`; its public hooks/fetchers (e.g. fetchProjectSessionBoard) are checked through chatRuntime's own runtime surface.",
  chatRuntimeStream:
    'implementation detail folded into chatRuntime.ts via `export *`; buildConversationTurnInput/buildConversationTurnPayload/mapConversationMessages are turn-serialization/message-shaping helpers (see client/conversations.ts) that expose generated IDs and raw HTTP payload shape, not a stable plugin contract — deliberately kept out of the public barrel.',
  chatRuntimeTypes:
    'implementation detail folded into chatRuntime.ts via `export *`.',
  sessionSummaryNormalize:
    'lazy parser used only by the summary fetcher so strict persisted-data validation does not enter the application shell.',
  developerRuntime:
    'lazy-only developer-surface hooks, intentionally published only from the `@kontourai/station-sdk/developer-runtime` subpath to keep them out of the root entry bundle.',
  actionOperations:
    'Activity-only operation query, intentionally published from the `@kontourai/station-sdk/action-operations` subpath to preserve the lazy Activity bundle boundary.',
  liveActivity:
    'station#3819: Activity-only roster query, intentionally published from the `@kontourai/station-sdk/live-activity` subpath to preserve the lazy Activity bundle boundary.',
  resourcePosture:
    'diagnostic-only and consumed by the lazy developer System tab; published only from the `@kontourai/station-sdk/resource-posture` subpath to keep it out of the root entry bundle graph.',
  setupImports:
    'published only from the `@kontourai/station-sdk/setup-imports-query` subpath to keep the capability-gated setup-import workflow out of the root entry bundle graph.',
  'secret-bindings':
    'published only from the `@kontourai/station-sdk/secret-bindings-query` subpath for the access-managed, lazy Integrations surface; deliberately excluded from the root barrel to avoid eager bytes.',
  'plugin-mutations':
    'implementation detail folded into plugins.ts via `export *`.',
  'plugin-queries':
    'implementation detail folded into plugins.ts via `export *`.',
  'plugin-types':
    'implementation detail folded into plugins.ts via `export *`.',
  systemRuntimeRequests:
    'fully re-exported by name from systemRuntime.ts already.',
  uiBlocks:
    "extractUIBlocks is exported directly by index.ts (`export { extractUIBlocks } from './query-domains/uiBlocks.js'`), bypassing queries.ts on purpose.",
  workspaceConnections:
    'implementation detail folded into workspace.ts via `export *`.',
  workspaceCredentialRecovery:
    'implementation detail folded into workspace.ts via `export *`.',
  workspaceProjects:
    'implementation detail folded into workspace.ts via `export *`.',
  workspaceWorkflows:
    'implementation detail folded into workspace.ts via `export *`.',
};

/**
 * Per-PUBLIC-domain-module export names that are intentionally excluded
 * from the public barrel even though the module exports them (directly or
 * via an `export *` chain into an internal sub-module). Each entry must be
 * commented with why it's excluded, so the exclusion stays reviewable
 * rather than becoming a silent escape hatch.
 */
const PUBLIC_DOMAIN_EXCLUSIONS: Record<string, string[]> = {
  chatRuntime: [
    // Internal turn-serialization / message-shaping helpers (see
    // client/conversations.ts's doc comment on the mapper) — they expose
    // generated IDs and raw HTTP payload shape, not a stable plugin
    // contract. Plugins call the exported hooks (useConversationsQuery,
    // useDelegateOrchestrationTaskMutation, etc.), not these.
    'buildConversationTurnInput',
    'buildConversationTurnPayload',
    'mapConversationMessages',
  ],
  workspace: [
    // Workspace Pane catalog data is intentionally opt-in at
    // `@kontourai/station-sdk/workspace-pane`: the Station UI keeps the
    // root SDK module as a plugin-shared namespace, so re-exporting this
    // hook there defeats the Pane contract's no-default-bundle-cost boundary.
    'useProjectWorkspacePanesQuery',
    'useProjectWorkspaceFilePreviewQuery',
  ],
};

const QUERY_DOMAINS_DIR = path.resolve(__dirname, '../query-domains');
const INDEX_PATH = path.resolve(__dirname, '../index.ts');
const SDK_PACKAGE_PATH = path.resolve(__dirname, '../../package.json');
const VOICE_DIR = path.resolve(__dirname, '../voice');
/** Source dir of the contracts package, read only to parse its exported type names. */
const CONTRACTS_SRC_DIR = path.resolve(__dirname, '../../../contracts/src');
const CONTRACTS_PACKAGE_PATH = path.resolve(
  __dirname,
  '../../../contracts/package.json',
);

it('publishes the pull-request record types consumed by SDK UI components', () => {
  const indexSource = fs.readFileSync(INDEX_PATH, 'utf8');
  expect(indexSource).toContain('PullRequest,');
  expect(indexSource).toContain('PullRequestResult,');
  expect(indexSource).toContain(
    "from '@kontourai/station-contracts/pull-request-provider'",
  );
});

function listQueryDomainModuleNames(): string[] {
  return fs
    .readdirSync(QUERY_DOMAINS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.slice(0, -3));
}

/**
 * Parses the exported type names (`export type X`, `export interface X`,
 * and re-exported `type X` / `export type { X }` specifiers) directly out
 * of a single query-domains module's own source — scoped to that specific
 * file, not a whole-file/whole-barrel regex — because `export type` names
 * are erased at runtime and can't be verified by import-and-compare like
 * the value checks below. When `recurseStars` is true, `export * from
 * './sibling'` re-export chains are followed within query-domains/ (the
 * only place this codebase's `export *` chains point), since a public
 * wrapper module's own file (e.g. chatRuntime.ts) often has no direct type
 * declarations of its own and gets its full type surface entirely from
 * `export *`-ing its internal sub-modules.
 */
function extractExportedTypeNames(
  moduleBaseName: string,
  dir: string,
  {
    recurseStars = false,
    visited = new Set<string>(),
  }: { recurseStars?: boolean; visited?: Set<string> } = {},
): Set<string> {
  const names = new Set<string>();
  if (visited.has(moduleBaseName)) return names;
  visited.add(moduleBaseName);

  const filePath = path.join(dir, `${moduleBaseName}.ts`);
  if (!fs.existsSync(filePath)) return names;
  const src = fs.readFileSync(filePath, 'utf8');

  for (const match of src.matchAll(
    /^export\s+(?:type|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/gm,
  )) {
    names.add(match[1]);
  }

  // A specifier's *public* name is what a consumer imports as — for a
  // renamed re-export (`X as Y`) that's the alias (Y), not the source
  // module's local name (X), so every specifier is resolved through this
  // helper rather than used as-is.
  const publicSpecifierName = (rawSpecifier: string): string | null => {
    const trimmed = rawSpecifier.trim().replace(/^type\s+/, '');
    if (!trimmed) return null;
    const asMatch = trimmed.match(
      /^(?:[A-Za-z_][A-Za-z0-9_]*)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/,
    );
    return asMatch ? asMatch[1] : trimmed;
  };

  // `export type { A, B as C } from '...'` — every specifier in the block is a type.
  for (const block of src.matchAll(
    /export\s+type\s*\{([^}]*)\}\s*from\s*'[^']+'/g,
  )) {
    for (const raw of block[1].split(',')) {
      const name = publicSpecifierName(raw);
      if (name) names.add(name);
    }
  }

  // `export { a, type B, type C as D } from '...'` — only `type`-prefixed specifiers.
  // (Named re-export blocks never need recursion: the type name itself is
  // already spelled out at this call site, unlike `export *` below.)
  for (const block of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*'[^']+'/g)) {
    for (const raw of block[1].split(',')) {
      const trimmed = raw.trim();
      if (trimmed.startsWith('type ')) {
        const name = publicSpecifierName(trimmed);
        if (name) names.add(name);
      }
    }
  }

  if (recurseStars) {
    for (const match of src.matchAll(
      /export\s+\*\s+from\s+'\.\/([A-Za-z0-9_-]+)(?:\.js)?'/g,
    )) {
      for (const name of extractExportedTypeNames(match[1], dir, {
        recurseStars,
        visited,
      })) {
        names.add(name);
      }
    }
  }

  return names;
}

describe('query-domains module classification stays exhaustive', () => {
  it('classifies every query-domains/*.ts module as public or internal', () => {
    const actualModules = new Set(listQueryDomainModuleNames());
    const classifiedModules = new Set([
      ...PUBLIC_QUERY_DOMAINS,
      ...Object.keys(INTERNAL_QUERY_DOMAINS),
    ]);

    const unclassified = [...actualModules].filter(
      (name) => !classifiedModules.has(name),
    );
    expect(
      unclassified,
      unclassified.length > 0
        ? `unclassified domain: ${unclassified.join(', ')} — add to PUBLIC_QUERY_DOMAINS or INTERNAL_QUERY_DOMAINS in publicBarrel.test.ts`
        : undefined,
    ).toEqual([]);

    // Guard the manifest itself against stale/typo'd entries pointing at
    // files that no longer exist.
    const staleEntries = [...classifiedModules].filter(
      (name) => !actualModules.has(name),
    );
    expect(staleEntries).toEqual([]);
  });
});

describe('sdk public barrel (index.ts) covers every PUBLIC_QUERY_DOMAINS value export', () => {
  // station#3161: this test's cost is dominated by module resolution/dynamic
  // import (import.meta.glob over every query-domains module, then a dynamic
  // import per PUBLIC_QUERY_DOMAINS entry) rather than by assertions, so it
  // is unusually sensitive to a contended host — measured 44-55ms isolated
  // vs. a 5007ms timeout against vitest's 5000ms default during a loaded
  // multi-file run (station#3161 A/B). The bound below scales with the
  // number of domains it imports rather than hard-coding a single constant,
  // so it stays proportional as PUBLIC_QUERY_DOMAINS grows; the floor keeps
  // it generous even while the list is still short. This must stay a
  // per-file override, not a change to vitest's global testTimeout — that
  // would mask genuinely hung tests elsewhere in the suite.
  const DOMAIN_IMPORT_TIMEOUT_MS = Math.max(
    10_000,
    PUBLIC_QUERY_DOMAINS.length * 1_000,
  );

  it(
    're-exports the same binding for every non-excluded value each public domain module exports',
    async () => {
      const indexModule: Record<string, unknown> = await import('../index');
      const domainModuleLoaders = import.meta.glob<Record<string, unknown>>(
        '../query-domains/*.ts',
      );

      const problems: string[] = [];
      for (const domain of PUBLIC_QUERY_DOMAINS) {
        const loader = domainModuleLoaders[`../query-domains/${domain}.ts`];
        expect(
          loader,
          `PUBLIC_QUERY_DOMAINS references '${domain}' but no such module exists`,
        ).toBeDefined();
        const domainModule = await loader();
        const excluded = new Set(PUBLIC_DOMAIN_EXCLUSIONS[domain] ?? []);

        for (const name of Object.keys(domainModule)) {
          if (excluded.has(name)) continue;
          if (!(name in indexModule)) {
            problems.push(`${domain}.${name}: missing from index.ts`);
            continue;
          }
          if (indexModule[name] !== domainModule[name]) {
            problems.push(
              `${domain}.${name}: index.ts re-exports a different binding than ${domain}.ts exports (name collision with a wrong source)`,
            );
          }
        }
      }
      expect(problems).toEqual([]);
    },
    DOMAIN_IMPORT_TIMEOUT_MS,
  );
});

describe('ProjectTaskRoom public SDK surface', () => {
  it('publishes the same room client and hook bindings from root and subpath', async () => {
    const packageJson = JSON.parse(fs.readFileSync(SDK_PACKAGE_PATH, 'utf8'));
    expect(packageJson.exports['./project-task-rooms']).toBe(
      './src/query-domains/projectTaskRooms.ts',
    );
    const [root, rooms] = await Promise.all([
      import('../index'),
      import('../query-domains/projectTaskRooms'),
    ]);
    for (const name of [
      'commandProjectTaskRoomLive',
      'fetchProjectTaskRoomDocument',
      'projectTaskRoomQueries',
      'useCommandProjectTaskRoomLiveMutation',
      'useProjectTaskRoomStream',
    ] as const)
      expect(root[name]).toBe(rooms[name]);
  });
});

describe('sdk public barrel (index.ts) covers every PUBLIC_QUERY_DOMAINS type export', () => {
  it('has a matching type re-export for every non-excluded type name each public domain module exports', () => {
    const indexTypeNames = extractExportedTypeNames(
      'index',
      path.dirname(INDEX_PATH),
      {
        recurseStars: false,
      },
    );

    const problems: string[] = [];
    for (const domain of PUBLIC_QUERY_DOMAINS) {
      const domainTypeNames = extractExportedTypeNames(
        domain,
        QUERY_DOMAINS_DIR,
        {
          recurseStars: true,
        },
      );
      const excluded = new Set(PUBLIC_DOMAIN_EXCLUSIONS[domain] ?? []);
      for (const name of domainTypeNames) {
        if (excluded.has(name)) continue;
        if (!indexTypeNames.has(name)) {
          problems.push(
            `${domain}.${name}: missing type re-export from index.ts`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('sdk voice subpath has the curated voice-session surface', () => {
  it('publishes runtime voice helpers outside the production root barrel', async () => {
    const packageJson = JSON.parse(fs.readFileSync(SDK_PACKAGE_PATH, 'utf8'));
    expect(packageJson.exports['./voice']).toBe('./src/voice/session.ts');

    const [
      sessionModule,
      typesModule,
      registryModule,
      managerModule,
      providerAdapterModule,
    ] = await Promise.all([
      import('../voice/session'),
      import('../voice/session-types'),
      import('../voice/session-registry'),
      import('../voice/session-manager'),
      import('../voice/provider-session-adapter'),
    ]);

    expect(sessionModule.VOICE_SESSION_LIFECYCLE_STATES).toBe(
      typesModule.VOICE_SESSION_LIFECYCLE_STATES,
    );
    expect(sessionModule.VoiceSessionError).toBe(typesModule.VoiceSessionError);
    expect(sessionModule.VoiceSessionAdapterRegistry).toBe(
      registryModule.VoiceSessionAdapterRegistry,
    );
    expect(sessionModule.voiceSessionAdapterRegistry).toBe(
      registryModule.voiceSessionAdapterRegistry,
    );
    expect(sessionModule.VoiceSessionManager).toBe(
      managerModule.VoiceSessionManager,
    );
    expect(sessionModule.ProviderVoiceSessionAdapter).toBe(
      providerAdapterModule.ProviderVoiceSessionAdapter,
    );
    expect(sessionModule.createProviderVoiceSessionAdapter).toBe(
      providerAdapterModule.createProviderVoiceSessionAdapter,
    );
  });

  it('spells every intended voice-session type export in the voice module', () => {
    const sessionTypeNames = extractExportedTypeNames('session', VOICE_DIR);

    expect([...sessionTypeNames]).toEqual(
      expect.arrayContaining([
        'VoiceSessionAdapter',
        'VoiceSessionAdapterCapabilities',
        'VoiceSessionAdapterDescriptor',
        'VoiceSessionAdapterRegistration',
        'VoiceSessionContextUpdate',
        'VoiceSessionErrorCode',
        'VoiceSessionLifecycleState',
        'VoiceSessionOperation',
        'VoiceSessionOperationResult',
        'VoiceSessionSnapshot',
        'VoiceSessionStartInput',
        'VoiceSessionTextTurn',
      ]),
    );
  });
});

describe('sdk public barrel re-exports the Workspace Pane contract API (#1369/#1370)', () => {
  it('declares the Workspace Pane contract subpaths in the contracts package export map', () => {
    // Vitest's own module resolution can satisfy `import
    // '@kontourai/station-contracts/workspace-pane'` even when the package's
    // "exports" map omits the subpath, masking the failure this test
    // guards: an installed consumer resolving through Node's package-exports
    // algorithm would hit ERR_PACKAGE_PATH_NOT_EXPORTED. Assert the manifest
    // entry directly rather than relying on a successful dynamic import.
    const contractsPackageJson = JSON.parse(
      fs.readFileSync(CONTRACTS_PACKAGE_PATH, 'utf8'),
    );
    expect(contractsPackageJson.exports['./workspace-pane']).toBe(
      './src/workspace-pane.ts',
    );
    expect(contractsPackageJson.exports['./workspace-pane-availability']).toBe(
      './src/workspace-pane-availability.ts',
    );
    expect(
      contractsPackageJson.exports['./workspace-pane-layout-adapter'],
    ).toBe('./src/workspace-pane-layout-adapter.ts');
    expect(contractsPackageJson.exports['./workspace-file-preview']).toBe(
      './src/workspace-file-preview.ts',
    );
    expect(contractsPackageJson.exports['./workspace-browser-preview']).toBe(
      './src/workspace-browser-preview.ts',
    );
    expect(contractsPackageJson.exports['./workspace-chat-pane']).toBe(
      './src/workspace-chat-pane.ts',
    );
  });

  it('keeps the local browser-preview contract opt-in through its dedicated SDK subpath', async () => {
    const [sdk, previewSdk] = await Promise.all([
      import('../index'),
      import('../workspace-browser-preview'),
    ]);
    const packageJson = JSON.parse(fs.readFileSync(SDK_PACKAGE_PATH, 'utf8'));

    expect(packageJson.exports['./workspace-browser-preview']).toBe(
      './src/workspace-browser-preview.ts',
    );
    expect('normalizeLocalBrowserPreviewUrl' in sdk).toBe(false);
    expect(typeof previewSdk.normalizeLocalBrowserPreviewUrl).toBe('function');
    expect(typeof previewSdk.parseWorkspaceBrowserPreviewState).toBe(
      'function',
    );
  });

  it('keeps the file-preview transport and hook opt-in through its dedicated SDK subpath', async () => {
    const [sdk, previewSdk] = await Promise.all([
      import('../index'),
      import('../workspace-file-preview'),
    ]);
    const packageJson = JSON.parse(fs.readFileSync(SDK_PACKAGE_PATH, 'utf8'));

    expect(packageJson.exports['./workspace-file-preview']).toBe(
      './src/workspace-file-preview.ts',
    );
    expect('useProjectWorkspaceFilePreviewQuery' in sdk).toBe(false);
    expect(typeof previewSdk.useProjectWorkspaceFilePreviewQuery).toBe(
      'function',
    );
    expect(typeof previewSdk.previewProjectWorkspaceFile).toBe('function');
  });

  it('keeps Pane runtime helpers opt-in while exposing identical bindings from the dedicated SDK subpath', async () => {
    const [sdk, paneSdk, contracts] = await Promise.all([
      import('../index'),
      import('../workspace-pane'),
      import('@kontourai/station-contracts'),
    ]);

    // Derived from the contract modules themselves rather than a hand-kept
    // list: a value added to workspace-pane.ts or workspace-pane-layout-adapter.ts that never
    // reaches the SDK barrel is exactly the #591 bug class this file guards.
    const [workspacePaneModule, availabilityModule, adapterModule] =
      await Promise.all([
        import('@kontourai/station-contracts/workspace-pane'),
        import('@kontourai/station-contracts/workspace-pane-availability'),
        import('@kontourai/station-contracts/workspace-pane-layout-adapter'),
      ]);

    // A derived check is only as good as what it derives: an empty module list
    // would make every assertion below vacuous.
    expect(Object.keys(workspacePaneModule).length).toBeGreaterThan(5);
    expect(Object.keys(availabilityModule).length).toBeGreaterThan(1);
    expect(Object.keys(adapterModule).length).toBeGreaterThan(5);
    expect('useProjectWorkspacePanesQuery' in sdk).toBe(false);
    expect(typeof paneSdk.useProjectWorkspacePanesQuery).toBe('function');

    const problems: string[] = [];
    for (const [moduleName, module] of [
      ['workspace-pane', workspacePaneModule],
      ['workspace-pane-availability', availabilityModule],
      ['workspace-pane-layout-adapter', adapterModule],
    ] as const) {
      for (const name of Object.keys(module)) {
        const binding = (module as Record<string, unknown>)[name];
        if (name in sdk) {
          problems.push(
            `${moduleName}.${name}: leaked into the SDK root bundle`,
          );
          continue;
        }
        if ((paneSdk as Record<string, unknown>)[name] !== binding) {
          problems.push(
            `${moduleName}.${name}: the SDK Pane subpath re-exports a different binding`,
          );
        }
        if ((contracts as Record<string, unknown>)[name] !== binding) {
          problems.push(
            `${moduleName}.${name}: the contracts root re-exports a different binding`,
          );
        }
      }
    }
    expect(problems).toEqual([]);

    const layout = {
      tabs: [
        {
          id: 'builtin-tab',
          label: 'Builtin',
          component: { kind: 'builtin-component', name: 'HomePane' },
        },
        {
          id: 'plugin-tab',
          label: 'Plugin',
          component: 'legacy-plugin-component',
        },
        {
          id: 'mcp-tab',
          label: 'MCP App',
          component: { kind: 'mcp-tool-ui', ref: 'acme-server/render-widget' },
        },
      ],
    };

    const adaptations = paneSdk.enumerateLayoutDefinitionPanes(layout, {
      layoutSlug: 'wave2-test-layout',
      pluginId: 'acme-plugin',
    });
    expect(adaptations).not.toBeNull();
    expect(adaptations).toHaveLength(3);

    const catalog = paneSdk.createWorkspacePaneCatalogFromAdaptations(
      adaptations!,
    );
    expect(catalog.size).toBe(3);
    expect(catalog.instanceCount).toBe(3);
    for (const adaptation of adaptations!) {
      expect(catalog.get(adaptation.descriptor.id)).toEqual(
        adaptation.descriptor,
      );
      expect(paneSdk.layoutTabFromWorkspacePaneAdaptation(adaptation)).toEqual(
        adaptation.retainedLayoutTab,
      );
    }
  });

  it('spells every Workspace Pane contract and adapter type in the SDK barrel', () => {
    // Types are erased at runtime, so the value check above cannot see them;
    // they are parsed out of the contract modules' own source instead.
    const indexTypeNames = extractExportedTypeNames(
      'index',
      path.dirname(INDEX_PATH),
    );

    const problems: string[] = [];
    for (const moduleName of [
      'workspace-pane',
      'workspace-pane-availability',
      'workspace-pane-layout-adapter',
    ]) {
      const moduleTypeNames = extractExportedTypeNames(
        moduleName,
        CONTRACTS_SRC_DIR,
      );
      expect(
        moduleTypeNames.size,
        `parsed no exported type names out of ${moduleName}.ts`,
      ).toBeGreaterThan(5);
      for (const name of moduleTypeNames) {
        if (!indexTypeNames.has(name)) {
          problems.push(`${moduleName}.${name}: missing type re-export`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe('sdk testing subpath has the curated voice-session conformance surface', () => {
  it('publishes testing helpers outside the production root barrel', async () => {
    const packageJson = JSON.parse(fs.readFileSync(SDK_PACKAGE_PATH, 'utf8'));
    expect(packageJson.exports['./testing']).toBe('./src/voice/testing.ts');

    const testingModule = await import('../voice/testing');
    expect(typeof testingModule.createSyntheticVoiceSessionAdapter).toBe(
      'function',
    );
    expect(typeof testingModule.runVoiceSessionAdapterConformance).toBe(
      'function',
    );
  });

  it('exports every intended testing type from the testing module', () => {
    const testingTypeNames = extractExportedTypeNames('testing', VOICE_DIR);
    expect([...testingTypeNames]).toEqual(
      expect.arrayContaining([
        'SyntheticVoiceSessionAdapter',
        'SyntheticVoiceSessionAdapterOptions',
        'SyntheticVoiceSessionCall',
        'SyntheticVoiceSessionSnapshotInput',
        'VoiceSessionConformanceFixture',
        'VoiceSessionConformanceReport',
        'VoiceSessionConformanceViolation',
        'VoiceSessionConformanceViolationCode',
      ]),
    );
  });
});
