/** @vitest-environment jsdom */

import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { describe, expect, test } from 'vitest';
import {
  rendererGateFromPluginRegistryLoadStatus,
  resolveWorkspacePaneCatalogPresentation,
} from '../resolvedWorkspacePaneCatalog';
import { selectClientWorkspacePaneRenderer } from '../workspacePaneRendererSelection';

const profile = {
  target: 'web',
  isMobile: false,
  isDesktop: false,
} as any;

function descriptor(name: string): WorkspacePaneDescriptor {
  return {
    id: `builtin:${name}`,
    name,
    renderer: { kind: 'builtin-component', name },
    placement: { supportedRegions: ['main'] },
    modes: [{ id: 'default' }],
    provenance: { origin: 'builtin' },
    lifecycle: { stage: 'stable' },
  } as unknown as WorkspacePaneDescriptor;
}

describe('resolveWorkspacePaneCatalogPresentation', () => {
  test('projects the real degraded remote-isolation registry status as a UI-only renderer gate', () => {
    const registryStatus = {
      state: 'degraded',
      failedPluginNames: [],
      failure: 'remote-isolation',
    };

    expect(rendererGateFromPluginRegistryLoadStatus(registryStatus)).toBe(
      'remote-isolation',
    );
  });
  test('limits a remote-isolation renderer gate to descriptors outside the builtin registry', () => {
    const builtin = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'coding',
        instanceScope: 'project:demo:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'demo', sourceId: 'builtin:coding' },
      },
    )!.descriptor;
    const plugin = {
      id: 'plugin:review:remote',
      name: 'Remote review',
      renderer: { kind: 'plugin-component', name: 'remote-review' },
      placement: { supportedRegions: ['main'] },
      modes: [{ id: 'default' }],
      provenance: { origin: 'plugin', pluginId: 'review' },
      lifecycle: { stage: 'stable' },
    } as unknown as WorkspacePaneDescriptor;
    const result = resolveWorkspacePaneCatalogPresentation(
      {
        descriptors: [builtin, plugin],
        instances: [],
        availability: [
          {
            descriptorId: builtin.id,
            input: { rollout: 'available', distribution: 'enabled' },
            availability: {
              state: 'temporarily-unavailable',
              reason: { code: 'renderer-missing', source: 'renderer' },
            },
          },
          {
            descriptorId: plugin.id,
            input: { rollout: 'available', distribution: 'enabled' },
            availability: {
              state: 'temporarily-unavailable',
              reason: { code: 'renderer-missing', source: 'renderer' },
            },
          },
        ],
      } as any,
      profile,
      undefined,
      true,
      false,
      'remote-isolation',
    );

    expect(
      result.entries.find((entry) => entry.descriptor.id === builtin.id),
    ).not.toHaveProperty('rendererGate');
    expect(
      result.entries.find((entry) => entry.descriptor.id === plugin.id),
    ).toMatchObject({
      rendererGate: 'remote-isolation',
    });
  });
  test('a remote-isolation gate never reaches mcp-tool-ui or standard-data renderers', () => {
    // "Not in the builtin registry" is not "plugin-provided": these two kinds
    // are also absent from it, and enabling remote extensions repairs neither
    // (sol of archive#2640). Only kind 'plugin-component' may carry the
    // gate.
    const mcp = {
      id: 'plugin:third-party:mcp-issues',
      name: 'MCP issues',
      renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
      placement: { supportedRegions: ['main'] },
      modes: [{ id: 'default' }],
      provenance: { origin: 'plugin', pluginId: 'third-party' },
      lifecycle: { stage: 'stable' },
    } as unknown as WorkspacePaneDescriptor;
    const standardData = {
      id: 'plugin:third-party:report',
      name: 'Report',
      renderer: { kind: 'standard-data', dataShape: 'report' },
      placement: { supportedRegions: ['main'] },
      modes: [{ id: 'default' }],
      provenance: { origin: 'plugin', pluginId: 'third-party' },
      lifecycle: { stage: 'stable' },
    } as unknown as WorkspacePaneDescriptor;
    const unavailable = (descriptorId: string) => ({
      descriptorId,
      input: { rollout: 'available', distribution: 'enabled' },
      availability: {
        state: 'temporarily-unavailable',
        reason: { code: 'renderer-missing', source: 'renderer' },
      },
    });
    const result = resolveWorkspacePaneCatalogPresentation(
      {
        descriptors: [mcp, standardData],
        instances: [],
        availability: [unavailable(mcp.id), unavailable(standardData.id)],
      } as any,
      profile,
      undefined,
      true,
      false,
      'remote-isolation',
    );

    for (const descriptor of [mcp, standardData]) {
      expect(
        result.entries.find((entry) => entry.descriptor.id === descriptor.id),
      ).not.toHaveProperty('rendererGate');
    }
  });
  test('selects the declared trusted React alternative when the sandboxed MCP App host is unavailable', () => {
    const thirdParty = {
      version: '1.0',
      id: 'pane:plugin%3Athird-party:review:issues',
      name: 'Third-party issues',
      rendererId: 'renderer:third-party:mcp',
      renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
      requiredRendererCapabilities: ['sandboxed-mcp-app'],
      alternativeRenderer: {
        rendererId: 'renderer:third-party:read-only',
        renderer: { kind: 'plugin-component', name: 'issues-read-only' },
        requiredCapabilities: ['trusted-plugin-react'],
        reason: 'Use the read-only pane when MCP Apps are unavailable.',
      },
      placement: { supportedRegions: ['standalone'] },
      modes: [{ id: 'default' }],
      provenance: {
        origin: 'plugin',
        pluginId: 'third-party-review',
        mcpServerId: 'third-party-mcp',
      },
      lifecycle: { stage: 'stable' },
    } as unknown as WorkspacePaneDescriptor;
    const instance = {
      version: '1.0',
      descriptorId: thirdParty.id,
      instanceId: 'third-party-issues-1',
      stateKey: 'third-party-issues',
      boundContext: {
        contribution: {
          id: 'plugin:third-party-review:review',
          version: '2.4.0',
          sourceIdentity: {
            id: 'third-party-review',
            kind: 'local',
            source: 'plugins/third-party-review',
          },
          provenance: { origin: 'plugin', pluginId: 'third-party-review' },
        },
      },
    } as any;

    expect(
      selectClientWorkspacePaneRenderer(thirdParty, {
        mcpAppsEnabled: false,
        instance,
        hasTrustedPluginLayout: (name, candidateInstance) =>
          name === 'issues-read-only' && candidateInstance === instance,
      }),
    ).toMatchObject({
      state: 'selected',
      candidate: {
        source: 'alternative',
        renderer: { kind: 'plugin-component', name: 'issues-read-only' },
        contributorProvenance: {
          origin: 'plugin',
          pluginId: 'third-party-review',
          mcpServerId: 'third-party-mcp',
        },
      },
    });
    expect(
      selectClientWorkspacePaneRenderer(thirdParty, {
        mcpAppsEnabled: true,
        hasTrustedPluginLayout: () => false,
      }),
    ).toMatchObject({
      state: 'selected',
      candidate: {
        source: 'primary',
        renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
      },
    });
  });

  test('reports the real builtin coding renderer as present while previews stay disabled', () => {
    const coding = paneAdaptationFromLayoutTab(
      {
        id: 'coding',
        label: 'Coding',
        component: { kind: 'builtin-component', name: 'coding' },
      },
      {
        layoutSlug: 'coding',
        instanceScope: 'project:demo:source:builtin:coding',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'demo', sourceId: 'builtin:coding' },
      },
    )!;
    const preview = descriptor('workspace-browser-preview');
    const result = resolveWorkspacePaneCatalogPresentation(
      {
        descriptors: [coding.descriptor, preview],
        instances: [coding.instance],
        availability: [
          {
            descriptorId: coding.descriptor.id,
            instanceId: coding.instance.instanceId,
            input: {
              rollout: 'available',
              distribution: 'enabled',
              context: { project: 'present' },
            },
            availability: {
              state: 'available',
              reason: { code: 'ready', source: 'resolver' },
            },
          },
          {
            descriptorId: preview.id,
            input: { rollout: 'coming-soon' },
            availability: {
              state: 'coming-soon',
              reason: { code: 'coming-soon', source: 'product-rollout' },
            },
          },
        ],
      } as any,
      profile,
    );
    expect(
      result.entries.find(
        (entry) => entry.descriptor.id === coding.descriptor.id,
      )?.clientRendererPresence,
    ).toBe('present');
    expect(
      result.entries.find(
        (entry) => entry.descriptor.id === coding.descriptor.id,
      )?.availability.state,
    ).toBe('available');
    expect(
      result.entries.find((entry) => entry.descriptor.id === preview.id)
        ?.availability.state,
    ).toBe('coming-soon');
  });
  test('retains a descriptor-level coming-soon entry without an instance', () => {
    const preview = descriptor('workspace-browser-preview');
    const result = resolveWorkspacePaneCatalogPresentation(
      {
        projectId: 'project-demo',
        descriptors: [preview],
        instances: [],
        availability: [
          {
            descriptorId: preview.id,
            input: { rollout: 'coming-soon' },
            availability: {
              state: 'coming-soon',
              reason: { code: 'coming-soon', source: 'product-rollout' },
              action: { type: 'learn-more', code: 'view-rollout' },
            },
          },
        ],
      },
      profile,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).not.toHaveProperty('instance');
    expect(result.entries[0]?.availability).toEqual({
      state: 'coming-soon',
      reason: { code: 'coming-soon', source: 'product-rollout' },
      action: { type: 'learn-more', code: 'view-rollout' },
    });
  });

  test('keeps every known instance and preserves the server reason/action', () => {
    const result = resolveWorkspacePaneCatalogPresentation(
      {
        descriptors: [descriptor('flow-run-console')],
        instances: [
          {
            descriptorId: 'builtin:flow-run-console',
            instanceId: 'console-1',
          },
        ] as any,
        availability: [
          {
            descriptorId: 'builtin:flow-run-console',
            instanceId: 'console-1',
            input: {
              rollout: 'available',
              distribution: 'enabled',
              requirements: { configuration: true },
              configuration: 'unknown',
            },
            availability: {
              state: 'not-configured',
              reason: {
                code: 'configuration-unknown',
                source: 'configuration',
              },
              action: {
                type: 'learn-more',
                code: 'view-configuration-requirements',
              },
            },
          },
        ],
      } as any,
      profile,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].availability).toEqual({
      state: 'not-configured',
      reason: { code: 'configuration-unknown', source: 'configuration' },
      action: {
        type: 'learn-more',
        code: 'view-configuration-requirements',
      },
    });
    expect(result.platform.target).toBe('web');
  });

  test('fails closed only when an otherwise-available entry lacks a registered client renderer', () => {
    const result = resolveWorkspacePaneCatalogPresentation(
      {
        descriptors: [descriptor('not-registered')],
        instances: [
          { descriptorId: 'builtin:not-registered', instanceId: 'unknown-1' },
        ] as any,
        availability: [
          {
            descriptorId: 'builtin:not-registered',
            instanceId: 'unknown-1',
            input: { rollout: 'available', distribution: 'enabled' },
            availability: {
              state: 'available',
              reason: { code: 'ready', source: 'resolver' },
            },
          },
        ],
      } as any,
      profile,
    );

    expect(result.entries[0].availability).toEqual({
      state: 'temporarily-unavailable',
      reason: { code: 'renderer-missing', source: 'renderer' },
      action: { type: 'learn-more', code: 'view-renderer-requirements' },
    });
  });

  test('keeps a layout-present but pane-host-absent renderer unavailable', () => {
    const result = resolveWorkspacePaneCatalogPresentation(
      {
        descriptors: [descriptor('default')],
        instances: [
          { descriptorId: 'builtin:default', instanceId: 'default-1' },
        ],
        availability: [
          {
            descriptorId: 'builtin:default',
            instanceId: 'default-1',
            input: { rollout: 'available', distribution: 'enabled' },
            availability: {
              state: 'available',
              reason: { code: 'ready', source: 'resolver' },
            },
          },
        ],
      } as any,
      profile,
    );

    expect(result.entries[0].availability.reason.code).toBe('renderer-missing');
  });

  test('joins availability by descriptor and instance without colon collisions', () => {
    const result = resolveWorkspacePaneCatalogPresentation(
      {
        descriptors: [descriptor('a:b'), descriptor('a')],
        instances: [
          { descriptorId: 'builtin:a:b', instanceId: 'c' },
          { descriptorId: 'builtin:a', instanceId: 'b:c' },
        ],
        availability: [
          {
            descriptorId: 'builtin:a:b',
            instanceId: 'c',
            input: {
              rollout: 'available',
              distribution: 'enabled',
              requirements: { configuration: true },
              configuration: 'missing',
            },
            availability: {
              state: 'not-configured',
              reason: {
                code: 'configuration-missing',
                source: 'configuration',
              },
              action: { type: 'setup', code: 'complete-configuration' },
            },
          },
          {
            descriptorId: 'builtin:a',
            instanceId: 'b:c',
            input: {
              rollout: 'available',
              distribution: 'enabled',
              requirements: { permission: true },
              permission: 'required',
            },
            availability: {
              state: 'permission-required',
              reason: { code: 'permission-required', source: 'permission' },
              action: { type: 'setup', code: 'request-permission' },
            },
          },
        ],
      } as any,
      profile,
    );

    expect(
      result.entries.map((entry) => entry.availability.reason.code),
    ).toEqual(['renderer-missing', 'renderer-missing']);
  });

  test('preserves an authoritative unknown host fact while adding renderer presence', () => {
    const result = resolveWorkspacePaneCatalogPresentation(
      {
        descriptors: [descriptor('flow-run-console')],
        instances: [
          {
            descriptorId: 'builtin:flow-run-console',
            instanceId: 'console-1',
          },
        ],
        availability: [
          {
            descriptorId: 'builtin:flow-run-console',
            instanceId: 'console-1',
            input: {
              rollout: 'available',
              distribution: 'enabled',
              requirements: { hostCapabilities: ['local-preview'] },
              host: { state: 'unknown' },
            },
            availability: {
              state: 'unsupported',
              reason: { code: 'unsupported-host', source: 'native-host' },
            },
          },
        ],
      } as any,
      profile,
    );

    expect(result.entries[0].availability.reason.code).toBe(
      'host-capability-unknown',
    );
  });
});

describe('direct plugin Pane occurrences (station#3543)', () => {
  // The exact shapes the server now issues: the descriptor comes from the
  // plugin manifest, the instance from readCurrentWorkspacePaneCatalog with
  // the distribution service's on-disk contribution snapshot bound to it.
  const directDescriptor = {
    version: '1.0',
    id: 'review-plugin-pane',
    name: 'Review Plugin Pane',
    rendererId: 'review-plugin.review',
    renderer: { kind: 'plugin-component', name: 'review' },
    placement: { supportedRegions: ['primary'] },
    modes: [{ id: 'default', contextRequirement: { project: true } }],
    provenance: { origin: 'plugin', pluginId: 'review-plugin' },
    lifecycle: { stage: 'stable' },
  } as unknown as WorkspacePaneDescriptor;

  function issuedInstance(pluginId: string) {
    return {
      version: '1.0',
      descriptorId: directDescriptor.id,
      instanceId: `instance:plugin:project-a:plugin:${pluginId}:pane-0123456789ab`,
      stateKey: `state:plugin:project-a:plugin:${pluginId}:pane-0123456789ab`,
      boundContext: {
        projectId: 'project-a',
        contribution: {
          id: `plugin:${pluginId}:pane-0123456789ab`,
          version: '1.2.3',
          sourceIdentity: {
            id: pluginId,
            kind: 'local',
            source: `plugins/${pluginId}`,
          },
          provenance: { origin: 'plugin', pluginId },
        },
      },
    } as any;
  }

  test('a server-issued occurrence lets the declared trusted plugin renderer bind', () => {
    const instance = issuedInstance('review-plugin');
    expect(
      selectClientWorkspacePaneRenderer(directDescriptor, {
        mcpAppsEnabled: true,
        instance,
        hasTrustedPluginLayout: (name, candidateInstance) =>
          name === 'review' && candidateInstance === instance,
      }),
    ).toMatchObject({
      state: 'selected',
      candidate: {
        source: 'primary',
        renderer: { kind: 'plugin-component', name: 'review' },
      },
    });
  });

  test('without an issued occurrence the plugin renderer stays refused', () => {
    expect(
      selectClientWorkspacePaneRenderer(directDescriptor, {
        mcpAppsEnabled: true,
        hasTrustedPluginLayout: () => true,
      }),
    ).toMatchObject({ state: 'unavailable' });
  });

  test('a foreign occurrence bound to a different plugin is refused even when a component is registered', () => {
    // The server derives the bound contribution from the installed directory;
    // when the descriptor's self-declared provenance names someone else, the
    // two independent identities disagree and the renderer must not mount.
    expect(
      selectClientWorkspacePaneRenderer(directDescriptor, {
        mcpAppsEnabled: true,
        instance: issuedInstance('other-plugin'),
        hasTrustedPluginLayout: () => true,
      }),
    ).toMatchObject({ state: 'unavailable' });
  });

  test('a plugin descriptor can never mount the builtin flow-run-console renderer, occurrence or not', () => {
    const impersonator = {
      ...directDescriptor,
      id: 'review-plugin-console',
      rendererId: 'review-plugin.console',
      renderer: { kind: 'builtin-component', name: 'flow-run-console' },
    } as unknown as WorkspacePaneDescriptor;
    const instance = {
      ...issuedInstance('review-plugin'),
      descriptorId: impersonator.id,
    };
    expect(
      selectClientWorkspacePaneRenderer(impersonator, {
        mcpAppsEnabled: true,
        instance,
        hasTrustedPluginLayout: () => true,
      }),
    ).toMatchObject({ state: 'unavailable' });
  });
});
