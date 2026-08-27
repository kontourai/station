import type { WorkspacePaneDescriptor } from '@kontourai/station-contracts';
import { describe, expect, test } from 'vitest';
import {
  createWorkspacePaneCatalog,
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  selectWorkspacePaneRenderer,
} from '../workspace-pane';

describe('Workspace Pane SDK conformance fixture', () => {
  test('declares builtin, trusted-plugin, and sandboxed MCP panes without contributor-specific core branching', () => {
    const parsedDescriptors = [
      {
        version: '1.0',
        id: 'builtin-files',
        name: 'Files',
        rendererId: 'builtin-files-renderer',
        renderer: { kind: 'builtin-component', name: 'file-tree' },
        placement: { supportedRegions: ['primary'] },
        modes: [{ id: 'default' }],
        provenance: { origin: 'builtin' },
        lifecycle: { stage: 'stable' },
      },
      {
        version: '1.0',
        id: 'third-party-issues',
        name: 'Third-party Issues',
        rendererId: 'third-party-mcp-renderer',
        renderer: { kind: 'mcp-tool-ui', ref: 'third-party-mcp/issues' },
        requiredRendererCapabilities: ['sandboxed-mcp-app'],
        alternativeRenderer: {
          rendererId: 'third-party-read-only-renderer',
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
      },
      {
        version: '1.0',
        id: 'plugin-review',
        name: 'Review',
        rendererId: 'plugin-review-renderer',
        renderer: { kind: 'plugin-component', name: 'review-queue' },
        placement: { supportedRegions: ['primary', 'secondary'] },
        modes: [{ id: 'default' }],
        provenance: { origin: 'plugin', pluginId: 'fixture-plugin' },
        lifecycle: { stage: 'stable' },
      },
      {
        version: '1.0',
        id: 'mcp-issues',
        name: 'Issues',
        rendererId: 'mcp-issues-renderer',
        renderer: { kind: 'mcp-tool-ui', ref: 'fixture-mcp/issues' },
        placement: { supportedRegions: ['standalone'] },
        modes: [{ id: 'default' }],
        provenance: { origin: 'mcp', mcpServerId: 'fixture-mcp' },
        lifecycle: { stage: 'stable' },
      },
    ].map(parseWorkspacePaneDescriptor);

    const descriptors = parsedDescriptors.filter(
      (descriptor): descriptor is WorkspacePaneDescriptor =>
        descriptor !== null,
    );
    expect(descriptors).toHaveLength(parsedDescriptors.length);
    const catalog = createWorkspacePaneCatalog({
      descriptors,
      instances: descriptors.map((descriptor) => {
        const instance = parseWorkspacePaneInstance({
          version: '1.0',
          descriptorId: descriptor.id,
          instanceId: `instance:${descriptor.id}`,
          stateKey: `state:${descriptor.id}`,
          boundContext: { sourceId: descriptor.id },
        });
        if (!instance) throw new Error('fixture instance must be valid');
        return instance;
      }),
    });

    expect(
      catalog.listDescriptors().map((entry) => entry.provenance.origin),
    ).toEqual(['builtin', 'mcp', 'plugin', 'plugin']);
    expect(catalog.instanceCount).toBe(4);

    const thirdParty = descriptors.find(
      (descriptor) => descriptor.id === 'third-party-issues',
    )!;
    expect(
      selectWorkspacePaneRenderer(thirdParty, {
        capabilities: ['trusted-plugin-react'],
        isRendererPresent: (candidate) =>
          candidate.renderer.kind === 'plugin-component',
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
  });
});
