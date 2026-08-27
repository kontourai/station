# Author Workspace Pane Contributions

Use the opt-in `@kontourai/station-sdk/workspace-pane` surface to declare a
portable Workspace Pane. A declaration is data only: it does not load a module,
resolve an MCP resource, request an approval, or claim current availability.

Run the repository fixture before submitting a contribution:

```sh
npm run workspace-pane:conformance
```

The command proves a representative declaration through the public SDK parser,
catalog, placement, and renderer selector. It covers the following authored
data:

- descriptor, renderer, and placed-occurrence identity;
- required host capabilities;
- supported placement regions and declared actions;
- a declared renderer alternative;
- contributor provenance, contributor version, and lifecycle stage.

## Declare the descriptor

Keep the contributor, renderer, and occurrence identities separate. The
descriptor owns the portable identity and lifecycle. The instance owns the
particular placement and its contribution snapshot.

```ts
import {
  type WorkspacePaneDescriptor,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from '@kontourai/station-sdk/workspace-pane';

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

export const reviewIssuesPane: WorkspacePaneDescriptor = {
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
    reason: 'Use the declared read-only projection when the MCP App cannot render.',
  },
  placement: { supportedRegions: ['standalone', 'secondary'] },
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
};
```

`standard-data` is the portable read-only alternative. It renders only its
declared projection and exact contribution snapshot; it never mounts plugin
code, an iframe, or a tool bridge. It is selected only when its contribution
matches the placed occurrence exactly.

## Place the occurrence

Use opaque `instanceId` and `stateKey` values. Bind the exact contribution
snapshot at placement time so later rendering cannot be retargeted by a name or
descriptor-string match.

```ts
import {
  type WorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from '@kontourai/station-sdk/workspace-pane';

export const reviewIssuesPlacement: WorkspacePaneInstance = {
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  descriptorId: reviewIssuesPane.id,
  instanceId: 'review-kit-issues:project-demo',
  stateKey: 'review-kit-issues:project-demo',
  boundContext: {
    sourceId: 'review-kit:issues',
    contribution,
  },
};
```

## Renderer and policy boundaries

Renderer kind determines the host boundary:

- `plugin-component` is trusted plugin React and must be bound to the exact
  placed contribution.
- `mcp-tool-ui` goes only through the MCP UI host. Resource resolution, CSP,
  iframe sandboxing, and per-tool approval remain owned there.
- `standard-data` is inert, read-only presentation.

Do not infer provenance from a renderer name or branch Station core by a
contributor identifier. Declare provenance and version in the contribution
snapshot, and declare every useful renderer alternative up front. Disabling or
uninstalling a contribution changes truthful availability; it does not delete
the descriptor, placement, or canonical product data.

First-party Pane renderers follow the same isolation boundary. A first-party
Pane can receive Home only through the explicit role/grant machinery; it must
not select itself during install and must preserve built-in Home as the
recovery floor. A personal board reads only its persisted references through a
bounded owner seam, rather than becoming a discovery or cross-product query
authority. See [Work Board security](work-board-security.md).
