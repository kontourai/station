import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST,
  KIT_OBSERVABILITY_CONFORMANCE_VECTORS,
} from '@kontourai/flow-agents/kit-observability-conformance';
import type {
  KitObservabilityContribution,
  KitObservabilityContributionLoadResult,
} from '@kontourai/flow-agents/kit-observability-contract';
import { describe, expect, test, vi } from 'vitest';
import { StationKitObservabilityHost } from '../kit-observability-host.js';
import { StationKitObservabilityRegistry } from '../kit-observability-registry.js';

const host = () =>
  new StationKitObservabilityHost({
    supported_contract_versions: ['1.0'],
    capabilities: [
      'standard_views',
      'mcp_apps_resource_bridge',
      'resource.open',
    ],
  });

function contribution(
  name: string,
  packageName = '@example/kit',
): KitObservabilityContribution {
  return {
    apiVersion: 'flowagents.kontourai.io/v1alpha1',
    kind: 'KitObservabilityContribution',
    metadata: { name },
    spec: {
      contract_version: '1.0',
      package_ref: `npm:${packageName}@1.0.0`,
      projections: {
        run_summary: { schema_ref: 'https://example.test/run-summary.json' },
      },
      authority_refs: {
        flow: 'flowagents.kontourai.io/v1alpha1/WorkflowRun',
        surface: 'surface.kontourai.io/v1alpha1/TrustBundle',
        runtime: 'flowagents.kontourai.io/v1alpha1/RunCorrelationEnvelope',
      },
      host: {
        required_capabilities: ['standard_views'],
        optional_capabilities: ['mcp_apps_resource_bridge'],
        presentation: {
          preferred: {
            kind: 'mcp_apps_resource_bridge',
            resource: {
              uri: `ui://example.test/kits/${name}/observability`,
              mime_type: 'text/html;profile=mcp-app',
            },
            bridge: {
              tool_name: `${name}-observability`,
              visibility: ['model', 'app'],
            },
          },
          fallback: { kind: 'standard_views', source: 'declared_projections' },
        },
      },
      data_policy: {
        redaction: 'declared',
        retention: 'kit_owned',
        raw_source: 'available',
      },
      operator_intents: [
        {
          intent: 'open_resource',
          label: 'Open run',
          required_capability: 'resource.open',
          target: { authority: 'flow', kind: 'workflow_run' },
        },
      ],
      compatibility: { unsupported_version: 'diagnostic' },
    },
  };
}

function supported(
  value: KitObservabilityContribution,
): KitObservabilityContributionLoadResult {
  return { status: 'supported', contribution: value, diagnostics: [] };
}

function sharedConformanceContribution(): KitObservabilityContribution {
  return structuredClone(KIT_OBSERVABILITY_CONFORMANCE_VECTORS[0].contribution);
}

function ingestContext(
  runId = 'station-run',
  evidenceMode: 'observational' | 'controlled' = 'observational',
) {
  return {
    evidenceMode,
    runId,
    sourceRefs: [
      { authority: 'flow' as const, ref: `flow://runs/${runId}` },
      { authority: 'surface' as const, ref: `surface://bundles/${runId}` },
      { authority: 'runtime' as const, ref: `runtime://runs/${runId}` },
    ],
    lifecycleAtIngest: 'installed' as const,
  };
}

describe('StationKitObservabilityHost', () => {
  test('discovers an installed Kit through the public Flow Agents loader', () => {
    const directory = mkdtempSync(join(tmpdir(), 'station-kit-observability-'));
    const descriptor = contribution('partner-review');
    try {
      writeFileSync(
        join(directory, 'kit.json'),
        JSON.stringify({
          observability_contribution: {
            path: 'kit-observability.contribution.json',
          },
        }),
      );
      writeFileSync(
        join(directory, 'kit-observability.contribution.json'),
        JSON.stringify(descriptor),
      );

      expect(host().discover(directory)).toEqual({
        status: 'supported',
        contribution: descriptor,
        diagnostics: [],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ['builder', '@kontourai/flow-agents#kits/builder'],
    ['knowledge', '@kontourai/flow-agents#kits/knowledge'],
    ['partner-review', '@partner/review-kit'],
  ])('uses one portable path for %s', (name, packageName) => {
    const experience = host().present({
      contribution: supported(contribution(name, packageName)),
      lifecycle: 'installed',
      project: { projectSlug: 'project-a', incarnation: 2 },
    });

    expect(experience.status).toBe('enabled');
    expect(experience.standardViews).toEqual([
      expect.objectContaining({ projection: 'run_summary', readOnly: true }),
    ]);
    expect(experience.mcpComponent).toBeUndefined();
    expect(experience.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'station_mcp_apps_binding_unavailable' }),
    );
    expect(experience.provenance).toEqual(
      expect.objectContaining({
        contribution_ref: name,
        lifecycle: 'installed',
        project_binding: { projectSlug: 'project-a', incarnation: 2 },
      }),
    );
  });

  test('uses the hardened MCP layout only for a matching Station-owned binding', () => {
    const descriptor = contribution('partner-review');
    const experience = host().present({
      contribution: supported(descriptor),
      lifecycle: 'installed',
      mcpApps: {
        serverId: 'partner-server',
        toolName: 'partner-review-observability',
        resourceUri: 'ui://example.test/kits/partner-review/observability',
        mimeType: 'text/html;profile=mcp-app',
        visibility: ['model', 'app'],
      },
    });

    expect(experience.mcpComponent).toEqual({
      kind: 'mcp-tool-ui',
      ref: 'partner-server/partner-review-observability',
      resourceUri: 'ui://example.test/kits/partner-review/observability',
      approvalPolicy: 'read-only',
    });
  });

  test('falls back when a hostile resource binding changes the URI or visibility', () => {
    const descriptor = contribution('partner-review');
    const experience = host().present({
      contribution: supported(descriptor),
      lifecycle: 'installed',
      mcpApps: {
        serverId: 'partner-server',
        toolName: 'partner-review-observability',
        resourceUri: 'ui://hostile.test/stolen',
        mimeType: 'text/html;profile=mcp-app',
        visibility: ['app'],
      },
    });

    expect(experience.mcpComponent).toBeUndefined();
    expect(experience.standardViews).toHaveLength(1);
    expect(experience.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'station_mcp_apps_binding_unavailable' }),
    );
  });

  test('preserves canonical records across disable and uninstall while denying mutation', () => {
    const adapter = host();
    const descriptor = contribution('partner-review');
    const present = adapter.present({
      contribution: supported(descriptor),
      lifecycle: 'installed',
    });
    const record = adapter.retainRecord(
      {
        apiVersion: 'flowagents.kontourai.io/v1alpha1',
        kind: 'KitObservabilityRecord',
        metadata: { name: 'partner-run' },
        spec: {
          binding: {
            contribution_ref: 'partner-review',
            descriptor_digest: present.provenance!.descriptor_digest,
            package_ref: descriptor.spec.package_ref,
          },
          projection: { kind: 'run_summary' },
          authority_refs: {
            flow: 'flow://runs/partner-run',
            surface: 'surface://bundles/partner-run',
            runtime: 'runtime://runs/partner-run',
          },
          data: { observed: true },
        },
      },
      descriptor,
      ingestContext('partner-run'),
    );

    expect(record.metadata.name).toBe('partner-run');
    expect(
      adapter.present({
        contribution: supported(descriptor),
        lifecycle: 'disabled',
      }).status,
    ).toBe('disabled');
    expect(
      adapter.present({
        contribution: supported(descriptor),
        lifecycle: 'uninstalled',
      }).status,
    ).toBe('disabled');
    expect(adapter.canonicalRecords('partner-review')).toHaveLength(1);
    expect(adapter.requestMutation(descriptor, 'installed')).toEqual(
      expect.objectContaining({ allowed: false, code: 'mutation_denied' }),
    );
  });

  test('executes Flow Agents public conformance unchanged', () => {
    expect(host().runPublicConformance()).toEqual(
      expect.objectContaining({ passed: true }),
    );
  });

  test('consumes the exact public Flow conformance descriptor without a Station copy', () => {
    const descriptor = sharedConformanceContribution();
    const experience = host().present({
      contribution: supported(descriptor),
      lifecycle: 'installed',
    });

    expect(experience.provenance?.descriptor_digest).toBe(
      KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST,
    );
    expect(experience.standardViews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projection: 'run_summary', readOnly: true }),
      ]),
    );
  });

  test('keeps retained records and public snapshots isolated from caller mutation', () => {
    const adapter = host();
    const descriptor = sharedConformanceContribution();
    const record = adapter.retainRecord(
      {
        apiVersion: 'flowagents.kontourai.io/v1alpha1',
        kind: 'KitObservabilityRecord',
        metadata: { name: 'immutable-run' },
        spec: {
          binding: {
            contribution_ref: descriptor.metadata.name,
            descriptor_digest: KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST,
            package_ref: descriptor.spec.package_ref,
          },
          projection: { kind: 'run_summary' },
          authority_refs: {
            flow: 'flow://runs/immutable-run',
            surface: 'surface://bundles/immutable-run',
            runtime: 'runtime://runs/immutable-run',
          },
          data: { nested: { value: 'original' } },
        },
      },
      descriptor,
      ingestContext('immutable-run'),
    );
    (record.spec.data.nested as { value: string }).value = 'mutated';
    const snapshot = adapter.canonicalRecords(descriptor.metadata.name);
    (snapshot[0].spec.data.nested as { value: string }).value = 'also-mutated';

    expect(
      adapter.canonicalRecords(descriptor.metadata.name)[0].spec.data,
    ).toEqual({
      nested: { value: 'original' },
    });
  });

  test('deduplicates an identical record replay and quarantines a conflicting one', () => {
    const adapter = host();
    const descriptor = sharedConformanceContribution();
    const value = {
      apiVersion: 'flowagents.kontourai.io/v1alpha1',
      kind: 'KitObservabilityRecord',
      metadata: { name: 'idempotent-run' },
      spec: {
        binding: {
          contribution_ref: descriptor.metadata.name,
          descriptor_digest: KIT_OBSERVABILITY_CONFORMANCE_DESCRIPTOR_DIGEST,
          package_ref: descriptor.spec.package_ref,
        },
        projection: { kind: 'run_summary' },
        authority_refs: {
          flow: 'flow://runs/idempotent-run',
          surface: 'surface://bundles/idempotent-run',
          runtime: 'runtime://runs/idempotent-run',
        },
        data: { accepted: true },
      },
    };

    expect(
      adapter.ingestRecord(value, descriptor, ingestContext('run-a')),
    ).toMatchObject({
      status: 'accepted',
      identity: { recordId: 'idempotent-run' },
    });
    expect(
      adapter.ingestRecord(structuredClone(value), descriptor, {
        ...ingestContext('run-a'),
        lifecycleAtIngest: 'disabled',
        sourceRefs: [
          ...ingestContext('run-a').sourceRefs,
          { authority: 'runtime', ref: 'runtime://receipts/replayed' },
        ],
      }),
    ).toMatchObject({
      status: 'quarantined',
      identity: { recordId: 'idempotent-run' },
    });
    const conflicting = structuredClone(value);
    conflicting.spec.data = { accepted: false };
    expect(
      adapter.ingestRecord(conflicting, descriptor, ingestContext('run-a')),
    ).toMatchObject({
      status: 'quarantined',
      identity: { recordId: 'idempotent-run' },
    });
    expect(adapter.canonicalRecords(descriptor.metadata.name)).toHaveLength(1);
    expect(adapter.recordReceipts(descriptor.metadata.name)).toEqual([
      expect.objectContaining({
        identity: expect.objectContaining({ recordId: 'idempotent-run' }),
        context: expect.objectContaining({ lifecycleAtIngest: 'installed' }),
      }),
    ]);
    expect(adapter.quarantinedRecords(descriptor.metadata.name)).toHaveLength(
      2,
    );
  });

  test('applies real install, disable, update, and approved action transitions without a fake uninstall', async () => {
    const registry = new StationKitObservabilityRegistry(host());
    const first = sharedConformanceContribution();
    const installed = await registry.install({
      contribution: supported(first),
    });
    expect(installed).toMatchObject({ lifecycle: 'installed', incarnation: 1 });
    expect(
      (await registry.disable(first.metadata.name)).experience.status,
    ).toBe('disabled');
    expect((await registry.enable(first.metadata.name)).experience.status).toBe(
      'enabled',
    );

    const revised = structuredClone(first);
    revised.spec.package_ref = 'npm:@example/observability-kit@2.0.0';
    expect(
      await registry.update(first.metadata.name, {
        contribution: supported(revised),
      }),
    ).toMatchObject({ lifecycle: 'installed', incarnation: 2 });
    await expect(registry.uninstall(first.metadata.name)).rejects.toThrow(
      'derived from committed plugin removal',
    );
    expect(
      registry.requestMutation(first.metadata.name, {
        intent: 'open_resource',
        approved: false,
      }),
    ).toMatchObject({ allowed: false, code: 'mutation_denied' });
    await registry.enable(first.metadata.name);
    expect(
      registry.requestMutation(first.metadata.name, {
        intent: 'open_resource',
        approved: true,
      }),
    ).toMatchObject({ allowed: true, code: 'mutation_approved' });
  });

  test('does not leave a ghost lifecycle transition when persistence rejects it', async () => {
    let failWrites = false;
    let persisted: unknown;
    const registry = new StationKitObservabilityRegistry(host(), {
      store: {
        read: () => persisted,
        write: (value) => {
          if (failWrites) throw new Error('simulated persistence failure');
          persisted = structuredClone(value);
        },
      },
    });
    const descriptor = sharedConformanceContribution();
    await registry.install({ contribution: supported(descriptor) });
    const before = structuredClone(persisted);
    failWrites = true;

    await expect(registry.disable(descriptor.metadata.name)).rejects.toThrow(
      'simulated persistence failure',
    );
    expect(registry.get(descriptor.metadata.name)).toMatchObject({
      lifecycle: 'installed',
    });
    expect(persisted).toEqual(before);
  });

  test('rejects a stale process transition, refreshes, and succeeds on explicit retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-kit-conflict-'));
    const kitDirectory = join(root, 'kit');
    const statePath = join(root, 'config', 'kit-observability-lifecycle.json');
    const descriptor = sharedConformanceContribution();
    try {
      mkdirSync(kitDirectory);
      writeFileSync(
        join(kitDirectory, 'kit.json'),
        JSON.stringify({
          observability_contribution: {
            path: 'kit-observability.contribution.json',
          },
        }),
      );
      writeFileSync(
        join(kitDirectory, 'kit-observability.contribution.json'),
        JSON.stringify(descriptor),
      );
      const first = new StationKitObservabilityRegistry(host(), { statePath });
      const stale = new StationKitObservabilityRegistry(host(), { statePath });
      await first.discoverInstalled([root]);
      await stale.discoverInstalled([root]);

      await first.disable(descriptor.metadata.name);
      await expect(stale.enable(descriptor.metadata.name)).rejects.toThrow(
        /changed in another Station process/,
      );
      expect(stale.get(descriptor.metadata.name)).toMatchObject({
        lifecycle: 'disabled',
      });
      await expect(
        stale.enable(descriptor.metadata.name),
      ).resolves.toMatchObject({
        lifecycle: 'installed',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires descriptor materialization before retrying a stale transition', async () => {
    const root = mkdtempSync(
      join(tmpdir(), 'station-kit-descriptor-conflict-'),
    );
    const statePath = join(root, 'config', 'kit-observability-lifecycle.json');
    const original = contribution('partner-review');
    const updated = contribution('partner-review', '@example/updated-kit');
    try {
      const first = new StationKitObservabilityRegistry(host(), { statePath });
      const stale = new StationKitObservabilityRegistry(host(), { statePath });
      await first.install({ contribution: supported(original) });
      await stale.install({ contribution: supported(original) });

      await first.update(original.metadata.name, {
        contribution: supported(updated),
      });
      await expect(stale.disable(original.metadata.name)).rejects.toThrow(
        /changed in another Station process/,
      );
      await expect(stale.disable(original.metadata.name)).rejects.toThrow(
        /changed in another Station process/,
      );

      await expect(
        stale.update(original.metadata.name, {
          contribution: supported(updated),
        }),
      ).resolves.toMatchObject({ incarnation: 2 });
      await expect(
        stale.disable(original.metadata.name),
      ).resolves.toMatchObject({
        lifecycle: 'disabled',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not preserve a stale disabled state across a concurrent update', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-kit-update-conflict-'));
    const statePath = join(root, 'config', 'kit-observability-lifecycle.json');
    const descriptor = contribution('partner-review');
    const updated = contribution('partner-review', '@example/updated-kit');
    try {
      const first = new StationKitObservabilityRegistry(host(), { statePath });
      const stale = new StationKitObservabilityRegistry(host(), { statePath });
      await first.install({ contribution: supported(descriptor) });
      await stale.install({ contribution: supported(descriptor) });
      await first.disable(descriptor.metadata.name);
      await expect(stale.enable(descriptor.metadata.name)).rejects.toThrow(
        /changed in another Station process/,
      );
      await first.enable(descriptor.metadata.name);

      await expect(
        stale.update(descriptor.metadata.name, {
          contribution: supported(updated),
        }),
      ).rejects.toThrow(/changed in another Station process/);
      expect(stale.get(descriptor.metadata.name)).toMatchObject({
        lifecycle: 'installed',
      });
      await expect(
        stale.update(descriptor.metadata.name, {
          contribution: supported(updated),
        }),
      ).resolves.toMatchObject({ lifecycle: 'installed' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('releases the mutation lock and restores memory after a durable write fault', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-kit-write-fault-'));
    const statePath = join(root, 'config', 'kit-lifecycle.json');
    let persisted: unknown;
    let failWrites = false;
    const release = vi.fn(async () => undefined);
    const acquireMutationLock = vi.fn(async () => release);
    const registry = new StationKitObservabilityRegistry(host(), {
      statePath,
      acquireMutationLock,
      store: {
        read: () => persisted,
        write: (value) => {
          if (failWrites) throw new Error('durable rename failed');
          persisted = structuredClone(value);
        },
      },
    });
    try {
      const descriptor = sharedConformanceContribution();
      await registry.install({ contribution: supported(descriptor) });
      failWrites = true;

      await expect(registry.disable(descriptor.metadata.name)).rejects.toThrow(
        'durable rename failed',
      );
      expect(registry.get(descriptor.metadata.name)).toMatchObject({
        lifecycle: 'installed',
      });
      expect(acquireMutationLock).toHaveBeenCalledWith(`${statePath}.mutation`);
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not settle a lifecycle mutation before async lock release settles', async () => {
    let finishRelease!: () => void;
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRelease = resolve;
        }),
    );
    const registry = new StationKitObservabilityRegistry(host(), {
      statePath: join(tmpdir(), 'station-kit-release-settlement.json'),
      acquireMutationLock: vi.fn(async () => release),
      store: { read: () => undefined, write: vi.fn() },
    });

    let settled = false;
    const installation = registry
      .install({ contribution: supported(sharedConformanceContribution()) })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(release).toHaveBeenCalled());
    expect(settled).toBe(false);
    finishRelease();
    await expect(installation).resolves.toMatchObject({
      lifecycle: 'installed',
    });
  });

  test('does not persist a partial discovery when a later Kit presentation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-kit-partial-discovery-'));
    const first = contribution('first-kit');
    const second = contribution('second-kit');
    let persisted: unknown;
    const adapter = host();
    const originalPresent = adapter.present.bind(adapter);
    (adapter as any).present = (input: any) => {
      if (
        input.contribution.status === 'supported' &&
        input.contribution.contribution.metadata.name === second.metadata.name
      ) {
        throw new Error('second Kit presentation failed');
      }
      return originalPresent(input);
    };
    try {
      for (const descriptor of [first, second]) {
        const directory = join(root, descriptor.metadata.name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'kit.json'),
          JSON.stringify({
            observability_contribution: {
              path: 'kit-observability.contribution.json',
            },
          }),
        );
        writeFileSync(
          join(directory, 'kit-observability.contribution.json'),
          JSON.stringify(descriptor),
        );
      }
      const registry = new StationKitObservabilityRegistry(adapter, {
        store: {
          read: () => persisted,
          write: (value) => {
            persisted = structuredClone(value);
          },
        },
      });

      await expect(registry.discoverInstalled([root])).rejects.toThrow(
        'second Kit presentation failed',
      );
      expect(registry.list()).toEqual([]);
      expect(persisted).toBeUndefined();
      const restarted = new StationKitObservabilityRegistry(host(), {
        store: { read: () => persisted, write: () => {} },
      });
      expect(restarted.list()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an operator action if its descriptor changes during approval', async () => {
    const registry = new StationKitObservabilityRegistry(host());
    const descriptor = sharedConformanceContribution();
    await registry.install({ contribution: supported(descriptor) });
    const candidate = registry.prepareMutation(
      descriptor.metadata.name,
      'open_resource',
    );
    expect('allowed' in candidate).toBe(false);
    if ('allowed' in candidate) return;

    const revised = structuredClone(descriptor);
    revised.spec.package_ref = 'npm:@example/revised@2.0.0';
    await registry.update(descriptor.metadata.name, {
      contribution: supported(revised),
    });

    expect(registry.confirmMutation(candidate, true)).toMatchObject({
      allowed: false,
      code: 'mutation_denied',
      reason: expect.stringContaining('changed while approval was pending'),
    });
  });

  test('discovers installed Kit roots through the registry without re-enabling a disabled Kit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-kit-registry-'));
    const kitDirectory = join(root, 'external-kit');
    const descriptor = sharedConformanceContribution();
    try {
      mkdirSync(kitDirectory);
      writeFileSync(
        join(kitDirectory, 'kit.json'),
        JSON.stringify({
          observability_contribution: {
            path: 'kit-observability.contribution.json',
          },
        }),
      );
      writeFileSync(
        join(kitDirectory, 'kit-observability.contribution.json'),
        JSON.stringify(descriptor),
      );

      const registry = new StationKitObservabilityRegistry(host());
      expect((await registry.discoverInstalled([root]))[0]).toMatchObject({
        contributionRef: descriptor.metadata.name,
        lifecycle: 'installed',
      });
      await registry.disable(descriptor.metadata.name);
      expect((await registry.discoverInstalled([root]))[0].lifecycle).toBe(
        'disabled',
      );
      rmSync(kitDirectory, { recursive: true, force: true });
      expect((await registry.discoverInstalled([root]))[0].lifecycle).toBe(
        'uninstalled',
      );
      mkdirSync(kitDirectory);
      writeFileSync(
        join(kitDirectory, 'kit.json'),
        JSON.stringify({
          observability_contribution: {
            path: 'kit-observability.contribution.json',
          },
        }),
      );
      writeFileSync(
        join(kitDirectory, 'kit-observability.contribution.json'),
        JSON.stringify(descriptor),
      );
      expect((await registry.discoverInstalled([root]))[0]).toMatchObject({
        lifecycle: 'disabled',
        incarnation: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('quarantines duplicate contribution identities across roots regardless of descriptor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-kit-collision-'));
    const kitsRoot = join(root, 'kits');
    const pluginsRoot = join(root, 'plugins');
    const descriptor = sharedConformanceContribution();
    const conflicting = structuredClone(descriptor);
    conflicting.spec.package_ref = 'npm:@example/conflicting-kit@9.9.9';
    try {
      for (const [directory, value] of [
        [join(kitsRoot, 'first'), descriptor],
        [join(pluginsRoot, 'second'), conflicting],
      ] as const) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'kit.json'),
          JSON.stringify({
            observability_contribution: {
              path: 'kit-observability.contribution.json',
            },
          }),
        );
        writeFileSync(
          join(directory, 'kit-observability.contribution.json'),
          JSON.stringify(value),
        );
      }

      const registry = new StationKitObservabilityRegistry(host());
      expect(await registry.discoverInstalled([kitsRoot, pluginsRoot])).toEqual(
        [],
      );
      expect(registry.get(descriptor.metadata.name)).toBeUndefined();
      expect(registry.quarantinedDiscoveries()).toEqual([
        expect.objectContaining({
          contributionRef: descriptor.metadata.name,
          reason: 'duplicate_contribution_ref',
          directories: [join(kitsRoot, 'first'), join(pluginsRoot, 'second')],
        }),
      ]);

      // Identical descriptors cannot establish a unique physical owner either.
      writeFileSync(
        join(pluginsRoot, 'second', 'kit-observability.contribution.json'),
        JSON.stringify(descriptor),
      );
      const identical = new StationKitObservabilityRegistry(host());
      expect(
        await identical.discoverInstalled([kitsRoot, pluginsRoot]),
      ).toEqual([]);
      expect(identical.quarantinedDiscoveries()).toEqual([
        expect.objectContaining({
          contributionRef: descriptor.metadata.name,
          reason: 'duplicate_contribution_ref',
          directories: [join(kitsRoot, 'first'), join(pluginsRoot, 'second')],
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('restores explicit disable and incarnation after a Station restart while deriving availability from the plugin root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-kit-restart-'));
    const kitDirectory = join(root, 'external-kit');
    const statePath = join(root, 'config', 'kit-observability-lifecycle.json');
    const descriptor = sharedConformanceContribution();
    try {
      mkdirSync(kitDirectory);
      writeFileSync(
        join(kitDirectory, 'kit.json'),
        JSON.stringify({
          observability_contribution: {
            path: 'kit-observability.contribution.json',
          },
        }),
      );
      writeFileSync(
        join(kitDirectory, 'kit-observability.contribution.json'),
        JSON.stringify(descriptor),
      );

      const first = new StationKitObservabilityRegistry(host(), { statePath });
      expect((await first.discoverInstalled([root]))[0]).toMatchObject({
        lifecycle: 'installed',
        incarnation: 1,
      });
      await first.disable(descriptor.metadata.name);

      const restarted = new StationKitObservabilityRegistry(host(), {
        statePath,
      });
      expect((await restarted.discoverInstalled([root]))[0]).toMatchObject({
        lifecycle: 'disabled',
        incarnation: 1,
      });

      rmSync(kitDirectory, { recursive: true, force: true });
      expect((await restarted.discoverInstalled([root]))[0].lifecycle).toBe(
        'uninstalled',
      );
      const afterRemoval = new StationKitObservabilityRegistry(host(), {
        statePath,
      });
      expect(await afterRemoval.discoverInstalled([root])).toEqual([]);

      // A cold start must not trust the stale persisted availability. When a
      // real plugin directory returns, discovery derives the re-install and
      // increments the host-owned incarnation exactly once.
      mkdirSync(kitDirectory);
      writeFileSync(
        join(kitDirectory, 'kit.json'),
        JSON.stringify({
          observability_contribution: {
            path: 'kit-observability.contribution.json',
          },
        }),
      );
      writeFileSync(
        join(kitDirectory, 'kit-observability.contribution.json'),
        JSON.stringify(descriptor),
      );
      const reinstalled = new StationKitObservabilityRegistry(host(), {
        statePath,
      });
      expect((await reinstalled.discoverInstalled([root]))[0]).toMatchObject({
        lifecycle: 'disabled',
        incarnation: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
