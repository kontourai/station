/** @vitest-environment jsdom */

import { createWorkspaceHomeRoleGrant } from '@kontourai/station-contracts/workspace-home-role';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  loadStatus: {
    state: 'ready' as 'loading' | 'ready' | 'degraded',
    failedPluginNames: [] as string[],
    failure: undefined as string | undefined,
  },
  trustedLayout: null as
    | ((props: unknown) => React.ReactElement)
    | (() => never)
    | null,
  /** Live inventory manifest by plugin name; null = not installed. */
  manifest: null as { version: string } | null,
  /** When set, replaces the default getTrustedLayout behavior per call. */
  getTrustedLayoutImpl: null as (() => unknown) | null,
  getTrustedLayoutCalls: [] as unknown[][],
}));

vi.mock('../../../core/PluginRegistry', () => ({
  pluginRegistry: {
    subscribe: () => () => undefined,
    getLoadStatus: () => registry.loadStatus,
    getLayoutManifest: () => registry.manifest,
    getTrustedLayout: (...args: unknown[]) => {
      registry.getTrustedLayoutCalls.push(args);
      if (registry.getTrustedLayoutImpl) return registry.getTrustedLayoutImpl();
      return registry.trustedLayout;
    },
  },
}));

const selectionFault = vi.hoisted(() => ({ throwOnSelect: false }));

vi.mock(
  '../../../workspace-panes/workspacePaneRendererSelection',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../workspace-panes/workspacePaneRendererSelection')
      >();
    return {
      ...actual,
      selectClientWorkspacePaneRenderer: (
        ...args: Parameters<typeof actual.selectClientWorkspacePaneRenderer>
      ) => {
        if (selectionFault.throwOnSelect) {
          throw new Error('selection exploded on a bad catalog record');
        }
        return actual.selectClientWorkspacePaneRenderer(...args);
      },
    };
  },
);

import { HomeRolePane } from '../HomeRolePane';
import { WORKSPACE_HOME_PROJECTION_FIELDS } from '../home-role-projection';

const PLUGIN_ID = 'third-party-home';

const contribution = {
  id: `plugin:${PLUGIN_ID}:pane-abc123def456`,
  version: '3.1.0',
  sourceIdentity: {
    id: PLUGIN_ID,
    kind: 'local',
    source: `plugins/${PLUGIN_ID}`,
  },
  provenance: { origin: 'plugin', pluginId: PLUGIN_ID },
};

const contributedHome = {
  version: '1.0',
  id: `pane:plugin%3A${PLUGIN_ID}:home`,
  name: 'Third-party Home',
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
};

function grantFor(
  descriptor: unknown = contributedHome,
  projectionFields: readonly string[] = WORKSPACE_HOME_PROJECTION_FIELDS,
) {
  const grant = createWorkspaceHomeRoleGrant({
    descriptor,
    contribution,
    grantedAt: '2026-08-20T12:00:00.000Z',
    projectionFields,
  });
  if (!grant) throw new Error('fixture grant did not create');
  return grant;
}

const builtinHome = <div data-testid="builtin-home">Built-in Home</div>;

beforeEach(() => {
  registry.loadStatus = {
    state: 'ready',
    failedPluginNames: [],
    failure: undefined,
  };
  registry.trustedLayout = null;
  registry.manifest = { version: contribution.version };
  registry.getTrustedLayoutImpl = null;
  registry.getTrustedLayoutCalls = [];
  selectionFault.throwOnSelect = false;
});

describe('a granted Home that renders', () => {
  test('mounts the trusted plugin layout with the provenance bar and a way back', () => {
    registry.trustedLayout = () => (
      <div data-testid="plugin-home">Plugin Home</div>
    );
    const onRevoke = vi.fn();
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={onRevoke}
      />,
    );
    expect(screen.getByTestId('plugin-home')).toBeTruthy();
    expect(screen.queryByTestId('builtin-home')).toBeNull();
    expect(
      screen.getByText(/Home is provided by “Third-party Home” from plugin/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use built-in Home' }));
    expect(onRevoke).toHaveBeenCalledTimes(1);
  });

  test('authorization consults the registry with the granted occurrence binding', () => {
    registry.trustedLayout = () => <div data-testid="plugin-home" />;
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    // Both the selection presence check and the dispatch-time recheck must
    // pass the granted contribution, never just the renderer name.
    expect(registry.getTrustedLayoutCalls.length).toBeGreaterThan(0);
    for (const call of registry.getTrustedLayoutCalls) {
      expect(call[0]).toBe('third-party-home-surface');
      expect(call[1]).toEqual(contribution);
    }
  });
});

describe('recovery: a granted Home that throws (station#3122 constraint 3)', () => {
  test('a renderer that throws on mount lands on the built-in Home with the actual failure text', () => {
    registry.trustedLayout = () => {
      throw new Error('exploded during mount');
    };
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    consoleError.mockRestore();
    // Never a blank root: the floor renders...
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    //.with a truthful reason derived from the actual error...
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('Third-party Home');
    expect(notice.textContent).toContain('exploded during mount');
    //.and a way to retry or step off the grant, instead of a reload that
    // re-enters the same failure.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Keep the built-in Home' }),
    ).toBeTruthy();
  });

  test('a renderer that throws on a LATER render lands the same way, and can retry back', () => {
    let throwNow = false;
    registry.trustedLayout = () => {
      if (throwNow) throw new Error('exploded on update');
      return <div data-testid="plugin-home">Plugin Home</div>;
    };
    const view = render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.getByTestId('plugin-home')).toBeTruthy();

    throwNow = true;
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    view.rerender(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    consoleError.mockRestore();
    expect(screen.queryByTestId('plugin-home')).toBeNull();
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'exploded on update',
    );

    // The failure was transient: retry re-mounts the granted Pane.
    throwNow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByTestId('plugin-home')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('retry into a still-broken renderer lands back on the built-in, not a loop or a blank', () => {
    registry.trustedLayout = () => {
      throw new Error('still broken');
    };
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    consoleError.mockRestore();
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('still broken');
  });
});

describe('a granted Home whose renderer is unavailable', () => {
  test('an unregistered plugin renderer lands on the built-in with a derived reason', () => {
    registry.trustedLayout = null;
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'is not installed, or its installed version no longer matches',
    );
  });

  test('a declared sandboxed MCP alternative is never mounted at Home (owner decision, station#3122)', () => {
    // The host offers no sandboxed capabilities, so a granted descriptor's
    // mcp-tool-ui alternative must resolve exactly as if it were not there:
    // the unavailability reason, not a sandboxed mount and not the
    // renderer-not-admitted arm.
    registry.trustedLayout = null;
    const withMcpAlternative = {
      ...contributedHome,
      alternativeRenderer: {
        rendererId: `renderer:plugin:${PLUGIN_ID}:home-mcp`,
        renderer: { kind: 'mcp-tool-ui', ref: `${PLUGIN_ID}-mcp/home` },
        requiredCapabilities: ['sandboxed-mcp-app'],
        provenance: {
          origin: 'plugin',
          pluginId: PLUGIN_ID,
          mcpServerId: `${PLUGIN_ID}-mcp`,
        },
      },
    };
    render(
      <HomeRolePane
        grant={grantFor(withMcpAlternative)}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'is not installed, or its installed version no longer matches',
    );
  });

  test('a plugin whose bundle failed to load is named as that, not as uninstalled', () => {
    registry.loadStatus = {
      state: 'degraded',
      failedPluginNames: [PLUGIN_ID],
      failure: 'bundle-load-failure',
    };
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain(
      'code failed to load',
    );
  });

  test('while the plugin inventory is still loading, the floor renders with no claim at all', () => {
    registry.loadStatus = {
      state: 'loading',
      failedPluginNames: [],
      failure: undefined,
    };
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    // "Missing" is a claim nothing has derived yet — no notice.
    expect(screen.queryByRole('status')).toBeNull();
  });

  const withStandardData = {
    ...contributedHome,
    alternativeRenderer: {
      rendererId: `renderer:plugin:${PLUGIN_ID}:home-data`,
      renderer: {
        kind: 'standard-data',
        view: {
          id: `${PLUGIN_ID}-home-data`,
          projection: 'Recent work summary',
          schemaRef: `plugins/${PLUGIN_ID}/schemas/home.json`,
          readOnly: true,
          contribution,
          incarnation: 1,
        },
      },
      reason: 'Inert summary when the plugin renderer is unavailable.',
    },
  };

  test('falls to the declared standard-data rung when the installed plugin’s CODE failed to load', () => {
    // The case the rung exists for: the plugin is still installed (this
    // registry generation listed it and tried to load it), only its bundle
    // failed. Inert declared data renders, with the same provenance bar and
    // way back.
    registry.trustedLayout = null;
    registry.manifest = null; // a failed bundle registers no manifest
    registry.loadStatus = {
      state: 'degraded',
      failedPluginNames: [PLUGIN_ID],
      failure: 'bundle-load-failure',
    };
    render(
      <HomeRolePane
        grant={grantFor(withStandardData)}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.queryByTestId('builtin-home')).toBeNull();
    expect(screen.getByText('Recent work summary')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Use built-in Home' }),
    ).toBeTruthy();
  });

  test('the standard-data rung does NOT outlive the grant: an uninstalled plugin lands on the floor', () => {
    // The rung's own selection check compares two STORED snapshots, so
    // without this gate it would keep rendering after an uninstall — the
    // exact contradiction the independent review proved from this file's
    // earlier revision. Now: no live inventory evidence, no rung.
    registry.trustedLayout = null;
    registry.manifest = null;
    render(
      <HomeRolePane
        grant={grantFor(withStandardData)}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.queryByText('Recent work summary')).toBeNull();
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'is not installed, or its installed version no longer matches',
    );
  });

  test('the standard-data rung does not survive a version change either', () => {
    registry.trustedLayout = null;
    registry.manifest = { version: '4.0.0' };
    render(
      <HomeRolePane
        grant={grantFor(withStandardData)}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.queryByText('Recent work summary')).toBeNull();
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
  });
});

describe('recovery covers selection and resolution, not just the granted render (review finding 5)', () => {
  test('a throw DURING renderer selection lands on the built-in with the failure text, not RouteViewBoundary’s reload loop', () => {
    selectionFault.throwOnSelect = true;
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    consoleError.mockRestore();
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'selection exploded on a bad catalog record',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  test('a throw during trusted-layout RESOLUTION lands the same way', () => {
    // First call (selection's presence check) succeeds; the dispatch-time
    // recheck throws — the boundary must still catch it, because both run
    // inside `GrantedHomeSelection` under the boundary.
    let calls = 0;
    registry.getTrustedLayoutImpl = () => {
      calls += 1;
      if (calls > 1) throw new Error('registration store corrupted');
      return () => <div data-testid="plugin-home" />;
    };
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    consoleError.mockRestore();
    expect(calls).toBeGreaterThan(1);
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'registration store corrupted',
    );
  });

  test('an adversarial thrown VALUE cannot break recovery inside the recovery path', () => {
    registry.trustedLayout = () => {
      // A throw value whose String itself throws — `describeThrow` must
      // still produce a bounded description rather than throwing out of
      // `getDerivedStateFromError`.
      throw {
        toString() {
          throw new Error('describe me and I throw again');
        },
      };
    };
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    render(
      <HomeRolePane
        grant={grantFor()}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    consoleError.mockRestore();
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain(
      'cannot be described',
    );
  });
});

describe('a widened projection is a new grant', () => {
  test('a grant predating a projection field lands on the built-in and names what it never covered', () => {
    registry.trustedLayout = () => <div data-testid="plugin-home" />;
    const narrowed = WORKSPACE_HOME_PROJECTION_FIELDS.filter(
      (field) => field !== 'title',
    );
    render(
      <HomeRolePane
        grant={grantFor(contributedHome, narrowed)}
        builtinHome={builtinHome}
        onRevoke={() => undefined}
      />,
    );
    expect(screen.queryByTestId('plugin-home')).toBeNull();
    expect(screen.getByTestId('builtin-home')).toBeTruthy();
    const notice = screen.getByRole('status');
    expect(notice.textContent).toContain('the approval did not cover');
    // Derived from the projection type's own description of the field.
    expect(notice.textContent).toContain('Session, chat, and task titles');
  });
});
