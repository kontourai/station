import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  KitObservabilityContribution,
  KitObservabilityContributionLoadResult,
} from '@kontourai/flow-agents/kit-observability-contract';
import { describe, expect, test } from 'vitest';
import { StationKitObservabilityHost } from '../../kits/kit-observability-host.js';
import { StationKitObservabilityRegistry } from '../../kits/kit-observability-registry.js';
import { portableKitWorkspacePanes } from '../portable-kit-workspace-panes.js';

const host = () =>
  new StationKitObservabilityHost({
    supported_contract_versions: ['1.0'],
    capabilities: ['standard_views'],
  });

function contribution(): KitObservabilityContribution {
  return {
    apiVersion: 'flowagents.kontourai.io/v1alpha1',
    kind: 'KitObservabilityContribution',
    metadata: { name: 'partner-review' },
    spec: {
      contract_version: '1.0',
      package_ref: 'npm:@example/partner-review@2.4.0',
      projections: {
        run_summary: {
          schema_ref: 'https://example.test/run-summary.json',
        },
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
              uri: 'ui://example.test/kits/partner-review/observability',
              mime_type: 'text/html;profile=mcp-app',
            },
            bridge: {
              tool_name: 'partner-review-observability',
              visibility: ['model', 'app'],
            },
          },
          fallback: {
            kind: 'standard_views',
            source: 'declared_projections',
          },
        },
      },
      data_policy: {
        redaction: 'declared',
        retention: 'kit_owned',
        raw_source: 'available',
      },
      operator_intents: [],
      compatibility: { unsupported_version: 'diagnostic' },
    },
  };
}

function supported(
  value: KitObservabilityContribution,
): KitObservabilityContributionLoadResult {
  return { status: 'supported', contribution: value, diagnostics: [] };
}

function writeKit(directory: string, descriptor: KitObservabilityContribution) {
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

function expectPortablePane(
  entry: ReturnType<StationKitObservabilityRegistry['get']>,
  enabled: boolean,
  incarnation: number,
) {
  expect(entry).toBeDefined();
  if (!entry) return;
  const [pane] = portableKitWorkspacePanes([entry], 'project-a');
  expect(pane).toMatchObject({
    enabled,
    descriptor: {
      renderer: {
        kind: 'standard-data',
        view: {
          projection: 'run_summary',
          incarnation,
          contribution: {
            id: 'kit:partner-review',
            version: '2.4.0',
            sourceIdentity: {
              id: 'partner-review',
              kind: 'local',
              source: 'npm:@example/partner-review@2.4.0',
            },
            provenance: { origin: 'plugin', pluginId: 'partner-review' },
          },
        },
      },
    },
    instance: {
      boundContext: {
        projectId: 'project-a',
        contribution: {
          id: 'kit:partner-review',
          version: '2.4.0',
        },
      },
    },
  });
  expect(pane.descriptor.renderer).toMatchObject({
    view: { contribution: pane.instance.boundContext?.contribution },
  });
}

describe('portableKitWorkspacePanes', () => {
  test('preserves inert declarations and exact identity through installed, disabled, removal, and restart lifecycle transitions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-portable-kit-pane-'));
    const kitDirectory = join(root, 'partner-review');
    const statePath = join(root, 'config', 'kit-observability-lifecycle.json');
    const descriptor = contribution();
    try {
      writeKit(kitDirectory, descriptor);

      const first = new StationKitObservabilityRegistry(host(), { statePath });
      await first.discoverInstalled([root]);
      expectPortablePane(first.get(descriptor.metadata.name), true, 1);

      await first.disable(descriptor.metadata.name);
      expectPortablePane(first.get(descriptor.metadata.name), false, 1);

      const restarted = new StationKitObservabilityRegistry(host(), {
        statePath,
      });
      await restarted.discoverInstalled([root]);
      expectPortablePane(restarted.get(descriptor.metadata.name), false, 1);

      rmSync(kitDirectory, { recursive: true, force: true });
      await restarted.discoverInstalled([root]);
      expectPortablePane(restarted.get(descriptor.metadata.name), false, 1);

      // The persisted lifecycle remains authoritative over enabled state after
      // a physical Kit returns; a new presence gets a new incarnation without
      // deleting the declared contribution identity.
      writeKit(kitDirectory, descriptor);
      const reinstalled = new StationKitObservabilityRegistry(host(), {
        statePath,
      });
      await reinstalled.discoverInstalled([root]);
      expectPortablePane(reinstalled.get(descriptor.metadata.name), false, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses a real registry contribution without an exact package version', async () => {
    const descriptor = contribution();
    descriptor.spec.package_ref = 'npm:@example/partner-review';
    const registry = new StationKitObservabilityRegistry(host());
    const entry = await registry.install({
      contribution: supported(descriptor),
    });

    expect(portableKitWorkspacePanes([entry], 'project-a')).toEqual([]);
  });
});
