import assert from 'node:assert/strict';
import {
  createWorkspacePaneCatalog,
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  selectWorkspacePaneRenderer,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from '@kontourai/station-sdk/workspace-pane';

function sameContribution(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * A portable authoring fixture exercised through the SDK's published Pane
 * surface. It deliberately uses data-only alternatives: no plugin module,
 * tool call, resource read, or host permission is involved in this command.
 */
export function runWorkspacePaneConformance(): void {
  const contribution = {
    id: 'plugin:review-kit:issues',
    version: '1.4.0',
    sourceIdentity: {
      id: 'review-kit',
      kind: 'local' as const,
      source: 'fixtures/review-kit',
    },
    provenance: { origin: 'plugin' as const, pluginId: 'review-kit' },
  };
  const descriptor = parseWorkspacePaneDescriptor({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    id: 'review-kit-issues',
    name: 'Review issues',
    rendererId: 'review-kit-issues-mcp',
    renderer: { kind: 'mcp-tool-ui', ref: 'review-kit/issues' },
    requiredRendererCapabilities: ['sandboxed-mcp-app'],
    alternativeRenderer: {
      rendererId: 'review-kit-issues-data',
      renderer: {
        kind: 'standard-data',
        view: {
          id: 'review-kit-issues-read-only',
          projection: 'Review issues',
          schemaRef: 'review-kit://issues/v1',
          readOnly: true,
          contribution,
          incarnation: 1,
        },
      },
      requiredCapabilities: [],
      reason:
        'Use the declared read-only projection when this host cannot render the MCP App.',
    },
    placement: { supportedRegions: ['standalone', 'secondary'] },
    modes: [{ id: 'default' }],
    actions: [
      {
        type: 'prompt',
        label: 'Summarize issues',
        data: 'Summarize the current review issues.',
      },
    ],
    provenance: {
      origin: 'plugin',
      pluginId: 'review-kit',
      mcpServerId: 'review-kit',
    },
    lifecycle: { stage: 'stable', since: '2026-08-09' },
  });
  assert.ok(descriptor, 'descriptor must satisfy the SDK contract');

  const instance = parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: descriptor.id,
    instanceId: 'review-kit-issues:project-demo',
    stateKey: 'review-kit-issues:project-demo',
    boundContext: { sourceId: 'review-kit:issues', contribution },
  });
  assert.ok(
    instance,
    'placement must carry a valid exact contribution snapshot',
  );

  const catalog = createWorkspacePaneCatalog({
    descriptors: [descriptor],
    instances: [instance],
  });
  assert.equal(
    catalog.instanceCount,
    1,
    'placement must retain one occurrence',
  );
  assert.deepEqual(catalog.listDescriptors()[0]?.provenance, {
    origin: 'plugin',
    pluginId: 'review-kit',
    mcpServerId: 'review-kit',
  });
  assert.equal(
    catalog.listDescriptors()[0]?.lifecycle.stage,
    'stable',
    'lifecycle remains descriptor data',
  );
  assert.equal(
    instance.boundContext?.contribution?.version,
    '1.4.0',
    'the placed contribution keeps its declared version',
  );
  const normalizedDescriptor = catalog.listDescriptors()[0];
  const normalizedInstance = catalog.listInstances()[0];
  assert.ok(normalizedDescriptor, 'catalog must retain the descriptor');
  assert.ok(normalizedInstance, 'catalog must retain the placed occurrence');
  if (
    normalizedDescriptor.alternativeRenderer?.renderer.kind !== 'standard-data'
  ) {
    throw new Error('fixture must retain a standard-data alternative');
  }
  const declaredStandardDataRenderer =
    normalizedDescriptor.alternativeRenderer.renderer;
  assert.deepEqual(normalizedDescriptor.placement, {
    supportedRegions: ['standalone', 'secondary'],
  });
  assert.deepEqual(normalizedDescriptor.actions, [
    {
      type: 'prompt',
      label: 'Summarize issues',
      data: 'Summarize the current review issues.',
    },
  ]);
  assert.deepEqual(normalizedDescriptor.requiredRendererCapabilities, [
    'sandboxed-mcp-app',
  ]);
  assert.deepEqual(normalizedDescriptor.renderer, {
    kind: 'mcp-tool-ui',
    ref: 'review-kit/issues',
  });
  assert.ok(
    sameContribution(
      normalizedInstance.boundContext?.contribution,
      contribution,
    ),
    'the normalized placement must preserve the complete contribution snapshot',
  );
  assert.equal(declaredStandardDataRenderer.view.incarnation, 1);
  assert.ok(
    sameContribution(
      declaredStandardDataRenderer.view.contribution,
      normalizedInstance.boundContext?.contribution,
    ),
    'the standard-data renderer must preserve the placed contribution exactly',
  );

  const selectDeclaredDataRenderer = (
    candidateDescriptor: NonNullable<typeof normalizedDescriptor>,
  ) =>
    selectWorkspacePaneRenderer(candidateDescriptor, {
      capabilities: [],
      isRendererPresent: (candidate) =>
        candidate.renderer.kind === 'standard-data' &&
        sameContribution(
          candidate.renderer.view.contribution,
          normalizedInstance.boundContext?.contribution,
        ),
    });

  const selection = selectDeclaredDataRenderer(normalizedDescriptor);
  assert.deepEqual(selection, {
    state: 'selected',
    candidate: {
      source: 'alternative',
      rendererId: 'review-kit-issues-data',
      renderer: descriptor.alternativeRenderer?.renderer,
      contributorProvenance: descriptor.provenance,
      requiredCapabilities: [],
    },
  });

  for (const [name, mismatchedContribution] of [
    ['version', { ...contribution, version: '1.4.1' }],
    [
      'provenance',
      {
        ...contribution,
        provenance: { origin: 'plugin' as const, pluginId: 'other-review-kit' },
      },
    ],
  ] as const) {
    const mismatch = parseWorkspacePaneDescriptor({
      ...normalizedDescriptor,
      alternativeRenderer: {
        ...normalizedDescriptor.alternativeRenderer,
        renderer: {
          ...declaredStandardDataRenderer,
          view: {
            ...declaredStandardDataRenderer.view,
            contribution: mismatchedContribution,
          },
        },
      },
    });
    assert.ok(mismatch, `${name}-mismatched fixture must parse`);
    assert.deepEqual(selectDeclaredDataRenderer(mismatch), {
      state: 'unavailable',
    });
  }
}

runWorkspacePaneConformance();
console.log('Workspace Pane conformance passed.');
