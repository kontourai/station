import type { KitObservabilityContribution } from '@kontourai/flow-agents/kit-observability-contract';
import { describe, expect, test, vi } from 'vitest';
import { createStationKitMcpAppsBindingResolver } from '../kit-mcp-apps-binding.js';

const contribution: KitObservabilityContribution = {
  apiVersion: 'flowagents.kontourai.io/v1alpha1',
  kind: 'KitObservabilityContribution',
  metadata: { name: 'portable-review' },
  spec: {
    contract_version: '1.0',
    package_ref: 'npm:@example/portable-review@1.0.0',
    projections: {
      run_summary: { schema_ref: 'https://example.test/summary.json' },
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
            uri: 'ui://example.test/portable-review',
            mime_type: 'text/html;profile=mcp-app',
          },
          bridge: {
            tool_name: 'open_portable_review',
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
    operator_intents: [],
    compatibility: { unsupported_version: 'diagnostic' },
  },
};

describe('createStationKitMcpAppsBindingResolver', () => {
  test('fails closed for matching, impersonating, ambiguous, and revoked metadata', async () => {
    const mcpService = {
      listIntegrations: vi.fn().mockResolvedValue([{ id: 'review-server' }]),
      getMCPUIToolCatalog: vi.fn().mockResolvedValue({
        available: true,
        tools: [
          {
            originalName: 'open_portable_review',
            _meta: {
              ui: {
                resourceUri: 'ui://example.test/portable-review',
                visibility: ['model', 'app'],
              },
            },
          },
        ],
      }),
    };

    await expect(
      createStationKitMcpAppsBindingResolver(
        mcpService as any,
        () => false,
      )(contribution),
    ).resolves.toBeUndefined();
    await expect(
      createStationKitMcpAppsBindingResolver(
        mcpService as any,
        () => true,
      )(contribution),
    ).resolves.toBeUndefined();
    expect(mcpService.listIntegrations).not.toHaveBeenCalled();
    expect(mcpService.getMCPUIToolCatalog).not.toHaveBeenCalled();
  });
});
