/** @vitest-environment jsdom */

import {
  WORKSPACE_HOME_PANE_DESCRIPTOR,
  WORKSPACE_HOME_PANE_INSTANCE,
  WORKSPACE_HOME_PANE_RENDERER_NAME,
} from '@kontourai/station-contracts/workspace-home-pane';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { describe, expect, test } from 'vitest';
import {
  builtinWorkspacePaneRendererPresence,
  isCanonicalBuiltinHomeDescriptor,
} from '../builtinWorkspacePaneCanonical';
import { getBuiltinWorkspacePaneRenderer } from '../builtinWorkspacePaneRegistry';
import { isWorkspacePaneInstanceOwnedByProject } from '../workspacePaneHostAdmission';
import { selectClientWorkspacePaneRenderer } from '../workspacePaneRendererSelection';

const PLUGIN_ID = 'third-party-home';

const contribution = {
  id: `plugin:${PLUGIN_ID}:home`,
  version: '3.1.0',
  sourceIdentity: {
    id: PLUGIN_ID,
    kind: 'local',
    source: `plugins/${PLUGIN_ID}`,
  },
  provenance: { origin: 'plugin', pluginId: PLUGIN_ID },
};

function parsed(value: unknown): WorkspacePaneDescriptor {
  const descriptor = parseWorkspacePaneDescriptor(value);
  if (!descriptor) throw new Error('fixture descriptor did not parse');
  return descriptor;
}

function parsedInstance(value: unknown): WorkspacePaneInstance {
  const instance = parseWorkspacePaneInstance(value);
  if (!instance) throw new Error('fixture instance did not parse');
  return instance;
}

/** A plugin's own Home: its own descriptor id, renderer and attribution. */
const contributedHome = parsed({
  version: '1.0',
  id: `pane:plugin%3A${PLUGIN_ID}:home`,
  name: 'Home',
  rendererId: `renderer:plugin:${PLUGIN_ID}:home`,
  renderer: { kind: 'plugin-component', name: 'third-party-home-surface' },
  requiredRendererCapabilities: ['trusted-plugin-react'],
  placement: {
    supportedRegions: ['standalone'],
    preferredRegion: 'standalone',
  },
  modes: [{ id: 'default' }],
  provenance: { origin: 'plugin', pluginId: PLUGIN_ID },
  lifecycle: { stage: 'stable' },
});

const contributedHomeInstance = parsedInstance({
  version: '1.0',
  descriptorId: contributedHome.id,
  instanceId: 'third-party-home-1',
  stateKey: 'third-party-home',
  boundContext: { contribution },
});

describe('Home is a Workspace Pane like any other', () => {
  test('the builtin registry resolves the canonical Home descriptor', () => {
    // HomeView mounts `HomeWorkspacePane` directly rather than through this
    // lookup, to keep the registry's ~800kB component table off the root
    // route. This only proves that the registry resolves Home's canonical
    // descriptor; route-to-component attribution is covered at the route.
    expect(
      getBuiltinWorkspacePaneRenderer(WORKSPACE_HOME_PANE_DESCRIPTOR),
    ).not.toBeNull();
    expect(WORKSPACE_HOME_PANE_DESCRIPTOR.renderer).toMatchObject({
      kind: 'builtin-component',
      name: WORKSPACE_HOME_PANE_RENDERER_NAME,
    });
  });

  test('the shared selector admits the builtin Home renderer', () => {
    expect(
      selectClientWorkspacePaneRenderer(WORKSPACE_HOME_PANE_DESCRIPTOR, {
        mcpAppsEnabled: true,
        instance: WORKSPACE_HOME_PANE_INSTANCE,
      }),
    ).toMatchObject({
      state: 'selected',
      candidate: {
        source: 'primary',
        renderer: { kind: 'builtin-component', name: 'workspace-home' },
        contributorProvenance: { origin: 'builtin' },
      },
    });
  });

  test('the builtin stays admitted when no MCP App host is available', () => {
    // Home's renderer declares no MCP capability, so a Station with MCP
    // Apps disabled must still render Home.
    expect(
      selectClientWorkspacePaneRenderer(WORKSPACE_HOME_PANE_DESCRIPTOR, {
        mcpAppsEnabled: false,
        instance: WORKSPACE_HOME_PANE_INSTANCE,
      }),
    ).toMatchObject({ state: 'selected', candidate: { source: 'primary' } });
  });
});

describe('a Project host and the global Home occurrence', () => {
  test('no Project ever owns Home’s occurrence', () => {
    // `isWorkspacePaneInstanceOwnedByProject` is the admission every Project
    // host runs before mounting an occurrence. Home binds no projectId, so
    // the predicate is false for every Project. That refusal is the
    // contract — Home declares standalone-only placement precisely so a
    // Project-scoped host never embeds the global aggregate — not a gap to
    // special-case past. Home's own host (the root route) admits it through
    // the shared renderer selection plus the canonical occurrence check.
    expect(
      isWorkspacePaneInstanceOwnedByProject(
        WORKSPACE_HOME_PANE_INSTANCE,
        'any-project',
      ),
    ).toBe(false);
    expect(
      isWorkspacePaneInstanceOwnedByProject(
        WORKSPACE_HOME_PANE_INSTANCE,
        undefined,
      ),
    ).toBe(false);
  });
});

describe('a plugin substituting Home', () => {
  test("a plugin's own Home descriptor selects the plugin renderer instead of the builtin", () => {
    const selection = selectClientWorkspacePaneRenderer(contributedHome, {
      mcpAppsEnabled: true,
      instance: contributedHomeInstance,
      hasTrustedPluginLayout: (name, candidateInstance) =>
        name === 'third-party-home-surface' &&
        candidateInstance === contributedHomeInstance,
    });
    expect(selection).toMatchObject({
      state: 'selected',
      candidate: {
        source: 'primary',
        renderer: {
          kind: 'plugin-component',
          name: 'third-party-home-surface',
        },
        contributorProvenance: { origin: 'plugin', pluginId: PLUGIN_ID },
      },
    });
    // Displacement is descriptor-level. The builtin is not a fallback the
    // plugin renderer sits in front of: nothing in this selection reaches
    // the builtin Home renderer at all.
    expect(getBuiltinWorkspacePaneRenderer(contributedHome)).toBeNull();
  });

  test('a plugin cannot reach the builtin Home renderer by reusing its renderer name', () => {
    const impostor = parsed({
      ...WORKSPACE_HOME_PANE_DESCRIPTOR,
      id: `pane:plugin%3A${PLUGIN_ID}:home`,
      rendererId: `renderer:plugin:${PLUGIN_ID}:home`,
      provenance: { origin: 'plugin', pluginId: PLUGIN_ID },
    });
    // The contract permits `plugin` provenance on a `builtin-component`
    // renderer, so this descriptor parses. What refuses it is the canonical
    // check: the builtin renderer is registered for exactly one declaration.
    expect(impostor.renderer).toMatchObject({ kind: 'builtin-component' });
    expect(isCanonicalBuiltinHomeDescriptor(impostor)).toBe(false);
    expect(builtinWorkspacePaneRendererPresence(impostor)).toBe('missing');
    expect(getBuiltinWorkspacePaneRenderer(impostor)).toBeNull();
    expect(
      selectClientWorkspacePaneRenderer(impostor, {
        mcpAppsEnabled: true,
        instance: contributedHomeInstance,
      }),
    ).toEqual({ state: 'unavailable' });
  });

  test('a plugin renderer declared without its own provenance is never selected under builtin attribution', () => {
    // `WorkspacePaneAlternativeRenderer.provenance` is optional, so an
    // alternative that omits it falls back to the DESCRIPTOR's contributor
    // provenance — which on a builtin descriptor is `origin: 'builtin'`.
    // Admitting that would run plugin React code attributed to Station.
    const builtinHomeWithUnattributedPluginAlternative = parsed({
      ...WORKSPACE_HOME_PANE_DESCRIPTOR,
      alternativeRenderer: {
        rendererId: `renderer:plugin:${PLUGIN_ID}:home-alt`,
        renderer: { kind: 'plugin-component', name: 'third-party-home-alt' },
        requiredCapabilities: ['trusted-plugin-react'],
      },
    });
    const homeInstanceBoundToPlugin = parsedInstance({
      ...WORKSPACE_HOME_PANE_INSTANCE,
      boundContext: { contribution },
    });

    // The plugin's component IS registered and IS bound to this occurrence.
    // Only the missing renderer attribution stands between it and mounting.
    const support = {
      mcpAppsEnabled: true,
      instance: homeInstanceBoundToPlugin,
      hasTrustedPluginLayout: () => true,
    };
    expect(
      selectClientWorkspacePaneRenderer(
        builtinHomeWithUnattributedPluginAlternative,
        support,
      ),
    ).toEqual({ state: 'unavailable' });

    // That refusal is about attribution, not about the alternative being
    // rejected wholesale: the SAME unattributed alternative is admitted when
    // the contributor it inherits from is the plugin that owns the bound
    // contribution. Builtin attribution is the only thing that changed.
    const contributedHomeWithSameAlternative = parsed({
      ...contributedHome,
      alternativeRenderer: {
        rendererId: `renderer:plugin:${PLUGIN_ID}:home-alt`,
        renderer: { kind: 'plugin-component', name: 'third-party-home-alt' },
        requiredCapabilities: ['trusted-plugin-react'],
      },
    });
    expect(
      selectClientWorkspacePaneRenderer(contributedHomeWithSameAlternative, {
        ...support,
        instance: contributedHomeInstance,
      }),
    ).toMatchObject({
      state: 'selected',
      candidate: { contributorProvenance: { origin: 'plugin' } },
    });
  });

  test('the contract refuses builtin attribution for a plugin renderer outright', () => {
    // The strongest form of the same rule, and the reason the primary
    // renderer never needs the check above: a descriptor claiming
    // `origin: 'builtin'` with a plugin renderer does not parse at all.
    expect(
      parseWorkspacePaneDescriptor({
        ...WORKSPACE_HOME_PANE_DESCRIPTOR,
        renderer: {
          kind: 'plugin-component',
          name: 'third-party-home-surface',
        },
      }),
    ).toBeNull();
  });

  test('a plugin alternative that declares its own provenance is selected with that attribution, never the builtin contributor', () => {
    const contributedAlternative = parsed({
      ...contributedHome,
      renderer: { kind: 'mcp-tool-ui', ref: `${PLUGIN_ID}-mcp/home` },
      requiredRendererCapabilities: ['sandboxed-mcp-app'],
      provenance: {
        origin: 'plugin',
        pluginId: PLUGIN_ID,
        mcpServerId: `${PLUGIN_ID}-mcp`,
      },
      alternativeRenderer: {
        rendererId: `renderer:plugin:${PLUGIN_ID}:home-alt`,
        renderer: { kind: 'plugin-component', name: 'third-party-home-alt' },
        requiredCapabilities: ['trusted-plugin-react'],
        provenance: { origin: 'plugin', pluginId: PLUGIN_ID },
        reason: 'Rendered locally when the MCP App host is unavailable.',
      },
    });

    expect(
      selectClientWorkspacePaneRenderer(contributedAlternative, {
        mcpAppsEnabled: false,
        instance: contributedHomeInstance,
        hasTrustedPluginLayout: () => true,
      }),
    ).toMatchObject({
      state: 'selected',
      candidate: {
        source: 'alternative',
        renderer: { kind: 'plugin-component', name: 'third-party-home-alt' },
        rendererProvenance: { origin: 'plugin', pluginId: PLUGIN_ID },
      },
    });
  });
});

describe('a plugin reusing a legacy builtin renderer name', () => {
  test('cannot reach the Flow run console', () => {
    const impostor = parsed({
      version: '1.0',
      id: `pane:plugin%3A${PLUGIN_ID}:flow-run-console`,
      name: 'Plugin Flow run console',
      rendererId: `renderer:plugin:${PLUGIN_ID}:flow-run-console`,
      renderer: { kind: 'builtin-component', name: 'flow-run-console' },
      placement: { supportedRegions: ['standalone'] },
      modes: [{ id: 'default', contextRequirement: { project: true } }],
      provenance: { origin: 'plugin', pluginId: PLUGIN_ID },
      lifecycle: { stage: 'stable' },
    });
    const instance = parsedInstance({
      version: '1.0',
      descriptorId: impostor.id,
      instanceId: 'plugin-flow-run-console-1',
      stateKey: 'plugin-flow-run-console',
      boundContext: { projectId: 'project-1', contribution },
    });

    expect(builtinWorkspacePaneRendererPresence(impostor)).toBe('missing');
    expect(getBuiltinWorkspacePaneRenderer(impostor)).toBeNull();
    expect(
      selectClientWorkspacePaneRenderer(impostor, {
        mcpAppsEnabled: true,
        instance,
      }),
    ).toEqual({ state: 'unavailable' });
  });
});
