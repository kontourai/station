/**
 * archive#2646 — the sync-seam stores were cut over to `acquireFileMutationLockAsync`.
 *
 * `packages/shared/src/__tests__/lifecycle-events-async-lock.test.ts` already
 * proves the PRIMITIVE yields the event loop. This file proves the property
 * that actually shipped: that each converted STORE reaches the async primitive
 * through its own public mutation API, and awaits it — the seam, the `mutate`
 * helper, and every `await` on the way down.
 *
 * The harness is deliberately one parameterized body rather than one copy per
 * store. Each case supplies the `.mutation` lock path its write contends for
 * and one real durable mutation through the store's public API. The body then:
 *
 *   1. takes that store's lock SYNCHRONOUSLY, standing in for the other
 *      Station process the live defect was observed against (a CLI invocation,
 *      a sibling instance, `station-control`);
 *   2. starts the store mutation and schedules the holder's release on a TIMER;
 *   3. asserts the mutation could not finish before that timer fired, then
 *      succeeds.
 *
 * Assertion (2)/(3) is the load-bearing part, and it is why the release is a
 * timer rather than an inline call. A store that still takes the lock
 * synchronously blocks the event loop inside its own call, so it cannot return
 * for the release timer to be scheduled. That timer can NEVER fire; the store
 * instead exhausts the lock deadline and throws `lifecycle journal lock is
 * held by a live process`.
 * That is the red this file exists to produce under fault injection.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KIT_OBSERVABILITY_CONFORMANCE_VECTORS } from '@kontourai/flow-agents/kit-observability-conformance';
import { acquireFileMutationLock } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, describe, expect, it } from 'vitest';
import { saveIntegrationConfig } from '../../domain/config-loader-storage.js';
import { writeJsonFile } from '../../domain/file-storage-helpers.js';
import {
  UnattendedGrantStore,
  unattendedGrantStorePath,
} from '../agents/unattended-grant-store.js';
import { FileConnectionSmokeEvidenceStore } from '../connections/connection-smoke-evidence-store.js';
import { StationKitObservabilityHost } from '../kits/kit-observability-host.js';
import { StationKitObservabilityRegistry } from '../kits/kit-observability-registry.js';
import {
  mcpUiRenderGrantsPath,
  setMcpUiRenderAllowed,
} from '../plugins/mcp-ui-permissions.js';
import { grantPermissions } from '../plugins/plugin-permissions.js';
import {
  ToolServerCredentialStore,
  toolServerCredentialStoreMutationLockPath,
  toolServerIntegrationMutationLockPath,
} from '../plugins/tool-server-credential-store.js';
import { DiffCommentService } from '../projects/diff-comment-service.js';
import {
  ProjectBindingsStore,
  projectBindingStorePath,
} from '../projects/project-binding-store.js';
import { TaskGraphService } from '../projects/task-graph-service.js';
import { SshEnvironmentProfileStore } from '../ssh/ssh-environment-profile-store.js';

/**
 * How long the simulated other-process holder keeps the lock. Long enough that
 * a yielding acquirer demonstrably waits, short enough to stay well inside the
 * primitive's 10s default acquisition deadline.
 */
const HOLD_MS = 250;

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-store-async-lock-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { force: true, recursive: true });
  }
});

/** A SHA-256-shaped configuration fingerprint; the smoke store validates the shape. */
const FINGERPRINT = 'a'.repeat(64);

interface StoreSeamCase {
  /** Names the store whose seam this case exercises. */
  label: string;
  /** The `.mutation` lock path this store's write contends for. */
  lockPath: (root: string) => string;
  /**
   * Optional one-time provisioning that must complete BEFORE the simulated
   * other-process holder takes the lock — a store whose first write is a
   * separate `initialize()` would otherwise contend twice in one case and
   * measure the wrong acquisition.
   */
  prepare?: (root: string) => Promise<void>;
  /** One real durable mutation through the store's PUBLIC API. */
  mutate: (root: string) => Promise<unknown>;
}

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return productionTypeScriptFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

const CASES: StoreSeamCase[] = [
  {
    label: 'Kit observability lifecycle registry',
    lockPath: (root) => join(root, 'kit-lifecycle.json.mutation'),
    mutate: (root) =>
      new StationKitObservabilityRegistry(
        new StationKitObservabilityHost({
          supported_contract_versions: ['1.0'],
          capabilities: [
            'standard_views',
            'mcp_apps_resource_bridge',
            'resource.open',
          ],
        }),
        { statePath: join(root, 'kit-lifecycle.json') },
      ).install({
        contribution: {
          status: 'supported',
          contribution: structuredClone(
            KIT_OBSERVABILITY_CONFORMANCE_VECTORS[0].contribution,
          ),
          diagnostics: [],
        },
      }),
  },
  {
    label: 'shared JSON file mutation authority',
    lockPath: (root) => join(root, 'state.json.mutation'),
    mutate: (root) => writeJsonFile(join(root, 'state.json'), { ready: true }),
  },
  {
    label: 'integration configuration store',
    lockPath: (root) => toolServerIntegrationMutationLockPath(root, 'server-a'),
    mutate: (root) =>
      saveIntegrationConfig(root, 'server-a', {
        id: 'server-a',
        kind: 'mcp',
        endpoint: 'https://example.invalid/mcp',
      }),
  },
  {
    label: 'tool-server credential store',
    lockPath: toolServerCredentialStoreMutationLockPath,
    prepare: async (root) => {
      mkdirSync(join(root, 'security'), { recursive: true, mode: 0o700 });
      chmodSync(join(root, 'security'), 0o700);
    },
    mutate: (root) =>
      new ToolServerCredentialStore(root).upsert('server-a', 'TOKEN', 'secret'),
  },
  {
    label: 'plugin grants (GrantsFileStore seam)',
    lockPath: (root) => join(root, 'plugin-grants.json.mutation'),
    // archive#4288: a grant is bound to the plugin's installed bytes, so the
    // fixture needs a real tree to digest — as production always has.
    prepare: async (root) => {
      const pluginRoot = join(root, 'plugins', 'my-plugin');
      mkdirSync(pluginRoot, { recursive: true });
      writeFileSync(
        join(pluginRoot, 'plugin.json'),
        JSON.stringify({ name: 'my-plugin', version: '1.0.0' }),
      );
    },
    mutate: (root) => grantPermissions(root, 'my-plugin', ['navigation.dock']),
  },
  {
    label: 'mcp-ui render grants (GrantsFileStore seam)',
    lockPath: (root) => `${mcpUiRenderGrantsPath(root)}.mutation`,
    mutate: (root) => setMcpUiRenderAllowed(root, 'server-a', false),
  },
  {
    label: 'unattended tool grants (GrantsFileStore seam)',
    lockPath: (root) => `${unattendedGrantStorePath(root)}.mutation`,
    mutate: (root) =>
      new UnattendedGrantStore(root).grantTool(
        'voice:planner',
        'calendar.create',
        'brian',
      ),
  },
  {
    label: 'connection smoke evidence store',
    lockPath: (root) => join(root, 'connection-smoke.json.mutation'),
    mutate: (root) =>
      new FileConnectionSmokeEvidenceStore(root).record({
        evidenceVersion: 2,
        connectionId: 'codex-runtime',
        configurationFingerprint: FINGERPRINT,
        status: 'passed',
        testedAt: '2026-08-14T20:00:00.000Z',
        freshUntil: '2026-08-15T20:00:00.000Z',
        provider: 'codex',
        durationMs: 1200,
        turnLimit: 1,
      }),
  },
  {
    label: 'project binding store',
    lockPath: (root) => `${projectBindingStorePath(root)}.mutation`,
    mutate: (root) =>
      new ProjectBindingsStore(root).upsertProjectBinding({
        projectId: 'prj_1',
        resourceId: 'local:acme',
        kind: 'local-directory',
        path: '/tmp/acme',
        remotes: [],
        verifiedAt: 1,
        state: 'bound',
      }),
  },
  {
    label: 'ssh environment profile store',
    lockPath: (root) => join(root, 'environments', 'ssh.json.mutation'),
    prepare: (root) => new SshEnvironmentProfileStore(root).initialize(),
    mutate: (root) =>
      new SshEnvironmentProfileStore(root).add({
        hostAlias: 'test-host',
        remoteProjectPath: '/srv/app',
      }),
  },
  {
    label: 'task graph service',
    lockPath: (root) => join(root, 'task-graph.json.mutation'),
    mutate: (root) =>
      // A project with no workingDirectory resolves the workspace binding to
      // 'unavailable' without a real checkout — the durable graph write, and
      // the lock it contends for, are unaffected.
      new TaskGraphService(root, {
        projectService: {
          getProject: (slug: string) => ({
            id: slug,
            slug,
            name: 'Project alpha',
            createdAt: '2026-08-14T00:00:00.000Z',
            updatedAt: '2026-08-14T00:00:00.000Z',
          }),
        },
      }).createTask({
        projectId: 'project-alpha',
        title: 'contended task',
      }),
  },
  {
    label: 'diff comment service',
    lockPath: (root) => join(root, 'diff-comments.json.mutation'),
    mutate: (root) =>
      new DiffCommentService().create(join(root, 'diff-comments.json'), {
        projectId: 'prj_1',
        filePath: 'src/index.ts',
        side: 'additions',
        lineNumber: 12,
        body: 'contended write',
      }),
  },
];

it('keeps synchronous file-mutation lock acquisition out of server production', () => {
  // The two lock-owning storage primitives that moved to packages/shared
  // (json-file-storage, tool-server-credential-store) stay in scope by name —
  // a sync-lock regression in them would otherwise be invisible. The rest of
  // packages/shared is deliberately NOT swept: lifecycle-events.ts defines
  // the sync lock, and shared has pre-existing non-server sync consumers.
  const movedStoragePrimitives = [
    join(process.cwd(), 'packages/shared/src/json-file-storage.ts'),
    join(process.cwd(), 'packages/shared/src/tool-server-credential-store.ts'),
  ];
  const offenders = [
    ...productionTypeScriptFiles(join(process.cwd(), 'src-server')),
    ...movedStoragePrimitives,
  ].filter((path) =>
    /\bacquireFileMutationLock\b/.test(readFileSync(path, 'utf8')),
  );
  expect(offenders).toEqual([]);
});

it('keeps synchronous Station-home maintenance out of server production', () => {
  // Server boot may use the shared sync lifecycle APIs only through
  // non-server CLI/archive callers. A direct import here would recreate the
  // event-loop-blocking quarantine path even if no raw mutation lock appears.
  const offenders = productionTypeScriptFiles(
    join(process.cwd(), 'src-server'),
  ).filter((path) =>
    /\bacquireStationHomeMaintenanceLease\b/.test(readFileSync(path, 'utf8')),
  );
  expect(offenders).toEqual([]);
});

describe.each(CASES)('$label — archive#2646 async lock cutover', (seam) => {
  it('waits for a cross-process holder WITHOUT blocking the event loop', async () => {
    const root = makeRoot();
    const lock = seam.lockPath(root);
    mkdirSync(dirname(lock), { recursive: true });
    await seam.prepare?.(root);

    // Stand in for the other Station process holding this store's lock.
    const releaseHolder = acquireFileMutationLock(lock);
    let releasedAt: number | null = null;
    const started = Date.now();

    try {
      const mutation = seam.mutate(root);
      // Scheduled on the event loop ON PURPOSE: a store that still acquires
      // synchronously never returns from mutate, so this timer cannot even be
      // scheduled. An async store returns its promise, lets this fire, and can
      // then complete only after the holder is released.
      const handoff = setTimeout(() => {
        releasedAt = Date.now();
        releaseHolder();
      }, HOLD_MS);

      await mutation;
      clearTimeout(handoff);

      // The mutation genuinely blocked on the holder rather than racing past
      // it: it cannot have completed before the timer released the lock.
      expect(releasedAt).not.toBeNull();
      expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS - 50);
    } finally {
      if (releasedAt === null) releaseHolder();
    }
  });
});
