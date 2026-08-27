import { describe, expect, test } from 'vitest';
import { WORKSPACE_HOME_PANE_DESCRIPTOR } from '../workspace-home-pane.js';
import {
  createWorkspaceHomeRoleGrant,
  describeWorkspaceHomeProjection,
  describeWorkspaceHomeProjectionField,
  isWorkspaceHomeRoleEligibleDescriptor,
  parseWorkspaceHomeRoleGrant,
  parseWorkspaceHomeRoleStatus,
  WORKSPACE_HOME_PROJECTION_FIELD_DESCRIPTIONS,
  WORKSPACE_HOME_PROJECTION_FIELDS,
  WORKSPACE_HOME_ROLE_INSTANCE_ID,
  workspaceHomeRoleGrantCoversProjection,
} from '../workspace-home-role.js';
import { parseWorkspacePaneDescriptor } from '../workspace-pane.js';

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
};

const PROJECTION_FIELDS = ['id', 'title', 'projectLabel', 'updatedAt'];

function validInput() {
  return {
    descriptor: contributedHome,
    contribution,
    grantedAt: '2026-08-20T12:00:00.000Z',
    projectionFields: PROJECTION_FIELDS,
  };
}

describe('Home role eligibility', () => {
  test('a trusted plugin React descriptor with standalone placement is eligible', () => {
    const descriptor = parseWorkspacePaneDescriptor(contributedHome);
    expect(descriptor).not.toBeNull();
    expect(isWorkspaceHomeRoleEligibleDescriptor(descriptor!)).toBe(true);
  });

  test('the builtin Home descriptor is not a grant candidate — it is the floor', () => {
    expect(
      isWorkspaceHomeRoleEligibleDescriptor(WORKSPACE_HOME_PANE_DESCRIPTOR),
    ).toBe(false);
  });

  test('sandboxed tiers are not eligible in the first cut (owner decision, station#3122)', () => {
    const mcpHome = parseWorkspacePaneDescriptor({
      ...contributedHome,
      renderer: { kind: 'mcp-tool-ui', ref: `${PLUGIN_ID}-mcp/home` },
      requiredRendererCapabilities: ['sandboxed-mcp-app'],
      provenance: {
        origin: 'plugin',
        pluginId: PLUGIN_ID,
        mcpServerId: `${PLUGIN_ID}-mcp`,
      },
    });
    expect(mcpHome).not.toBeNull();
    expect(isWorkspaceHomeRoleEligibleDescriptor(mcpHome!)).toBe(false);
  });

  test('a plugin descriptor naming a builtin renderer is not eligible', () => {
    // The impostor case: `builtin-component` under plugin provenance parses,
    // but it can never hold the Home role — the tier line refuses it before
    // the canonical-registry check would.
    const impostor = parseWorkspacePaneDescriptor({
      ...contributedHome,
      renderer: { kind: 'builtin-component', name: 'flow-run-console' },
      requiredRendererCapabilities: undefined,
    });
    expect(impostor).not.toBeNull();
    expect(isWorkspaceHomeRoleEligibleDescriptor(impostor!)).toBe(false);
  });

  test('a pane that never declared standalone placement is not eligible', () => {
    const secondaryOnly = parseWorkspacePaneDescriptor({
      ...contributedHome,
      placement: {
        supportedRegions: ['secondary'],
        preferredRegion: 'secondary',
      },
    });
    expect(secondaryOnly).not.toBeNull();
    expect(isWorkspaceHomeRoleEligibleDescriptor(secondaryOnly!)).toBe(false);
  });
});

describe('createWorkspaceHomeRoleGrant', () => {
  test('mints a grant with the constant occurrence identity and no Project binding', () => {
    const grant = createWorkspaceHomeRoleGrant(validInput());
    expect(grant).not.toBeNull();
    expect(grant!.descriptor.id).toBe(contributedHome.id);
    expect(grant!.instance.instanceId).toBe(WORKSPACE_HOME_ROLE_INSTANCE_ID);
    expect(grant!.instance.stateKey).toBe(WORKSPACE_HOME_ROLE_INSTANCE_ID);
    expect(grant!.instance.descriptorId).toBe(contributedHome.id);
    expect(grant!.instance.boundContext).toEqual({ contribution });
    expect(grant!.instance.boundContext?.projectId).toBeUndefined();
    expect(grant!.projectionFields).toEqual(PROJECTION_FIELDS);
  });

  test('refuses an ineligible descriptor', () => {
    expect(
      createWorkspaceHomeRoleGrant({
        ...validInput(),
        descriptor: {
          ...contributedHome,
          renderer: { kind: 'builtin-component', name: 'workspace-home' },
          requiredRendererCapabilities: undefined,
        },
      }),
    ).toBeNull();
  });

  test('refuses a descriptor that does not parse', () => {
    expect(
      createWorkspaceHomeRoleGrant({
        ...validInput(),
        descriptor: { ...contributedHome, provenance: { origin: 'builtin' } },
      }),
    ).toBeNull();
  });

  test('refuses a contribution bound to a different plugin than the descriptor claims', () => {
    expect(
      createWorkspaceHomeRoleGrant({
        ...validInput(),
        contribution: {
          ...contribution,
          sourceIdentity: {
            ...contribution.sourceIdentity,
            id: 'someone-else',
          },
          provenance: { origin: 'plugin', pluginId: 'someone-else' },
        },
      }),
    ).toBeNull();
  });

  test('refuses a malformed or missing contribution', () => {
    expect(
      createWorkspaceHomeRoleGrant({
        ...validInput(),
        contribution: undefined,
      }),
    ).toBeNull();
    expect(
      createWorkspaceHomeRoleGrant({
        ...validInput(),
        contribution: { id: 'x' },
      }),
    ).toBeNull();
  });

  test('refuses empty, duplicated, or non-string projection fields and an unparseable grant time', () => {
    expect(
      createWorkspaceHomeRoleGrant({ ...validInput(), projectionFields: [] }),
    ).toBeNull();
    expect(
      createWorkspaceHomeRoleGrant({
        ...validInput(),
        projectionFields: ['id', 'id'],
      }),
    ).toBeNull();
    expect(
      createWorkspaceHomeRoleGrant({
        ...validInput(),
        projectionFields: ['id', 42] as unknown as string[],
      }),
    ).toBeNull();
    expect(
      createWorkspaceHomeRoleGrant({
        ...validInput(),
        grantedAt: 'not a time',
      }),
    ).toBeNull();
  });
});

describe('parseWorkspaceHomeRoleGrant', () => {
  test('round-trips a serialized grant', () => {
    const grant = createWorkspaceHomeRoleGrant(validInput());
    const parsed = parseWorkspaceHomeRoleGrant(
      JSON.parse(JSON.stringify(grant)),
    );
    expect(parsed).toEqual(grant);
  });

  test('re-derives instead of trusting stored structure', () => {
    const grant = createWorkspaceHomeRoleGrant(validInput());
    const stored = JSON.parse(JSON.stringify(grant));
    // A stored record whose descriptor was swapped for an ineligible one
    // must not survive parse, no matter how well-formed the rest looks.
    stored.descriptor = {
      ...contributedHome,
      renderer: { kind: 'builtin-component', name: 'workspace-home' },
      requiredRendererCapabilities: undefined,
    };
    expect(parseWorkspaceHomeRoleGrant(stored)).toBeNull();
  });

  test('refuses a record claiming a different occurrence identity', () => {
    const grant = createWorkspaceHomeRoleGrant(validInput());
    const stored = JSON.parse(JSON.stringify(grant));
    stored.instance.instanceId = 'someone-elses-occurrence';
    expect(parseWorkspaceHomeRoleGrant(stored)).toBeNull();
  });

  test('refuses garbage', () => {
    expect(parseWorkspaceHomeRoleGrant(null)).toBeNull();
    expect(parseWorkspaceHomeRoleGrant('grant')).toBeNull();
    expect(parseWorkspaceHomeRoleGrant([])).toBeNull();
    expect(parseWorkspaceHomeRoleGrant({ version: '2.0' })).toBeNull();
    expect(parseWorkspaceHomeRoleGrant({ version: '1.0' })).toBeNull();
  });
});

describe('workspaceHomeRoleGrantCoversProjection', () => {
  test('covers the same and a narrowed projection, never a widened one', () => {
    const grant = createWorkspaceHomeRoleGrant(validInput());
    expect(
      workspaceHomeRoleGrantCoversProjection(grant!, PROJECTION_FIELDS),
    ).toBe(true);
    expect(
      workspaceHomeRoleGrantCoversProjection(grant!, ['id', 'title']),
    ).toBe(true);
    expect(
      workspaceHomeRoleGrantCoversProjection(grant!, [
        ...PROJECTION_FIELDS,
        'unanswerableNotice',
      ]),
    ).toBe(false);
  });
});

describe('the canonical Home projection record', () => {
  test('the stored field list is the sorted key set of the description record', () => {
    expect(WORKSPACE_HOME_PROJECTION_FIELDS).toEqual(
      Object.keys(WORKSPACE_HOME_PROJECTION_FIELD_DESCRIPTIONS).sort(),
    );
    expect(Object.isFrozen(WORKSPACE_HOME_PROJECTION_FIELDS)).toBe(true);
  });

  test('every field describes itself to a person; an unknown field falls back to its raw name, never silence', () => {
    expect(describeWorkspaceHomeProjection()).toHaveLength(
      WORKSPACE_HOME_PROJECTION_FIELDS.length,
    );
    expect(describeWorkspaceHomeProjectionField('title')).toBe(
      'Session, chat, and task titles',
    );
    expect(describeWorkspaceHomeProjectionField('futureField')).toBe(
      'futureField',
    );
  });
});

describe('parseWorkspaceHomeRoleStatus (the client’s fail-closed reparse of the server payload)', () => {
  test('a granted status round-trips through serialization', () => {
    const grant = createWorkspaceHomeRoleGrant(validInput());
    const parsed = parseWorkspaceHomeRoleStatus(
      JSON.parse(JSON.stringify({ state: 'granted', grant })),
    );
    expect(parsed.state).toBe('granted');
    if (parsed.state === 'granted') {
      expect(parsed.grant).toEqual(grant);
    }
  });

  test('a granted status whose grant does not re-derive lands on none — a server cannot hand the client a grant the contract refuses', () => {
    const grant = createWorkspaceHomeRoleGrant(validInput());
    const stored = JSON.parse(JSON.stringify({ state: 'granted', grant }));
    stored.grant.descriptor.renderer = {
      kind: 'builtin-component',
      name: 'workspace-home',
    };
    stored.grant.descriptor.requiredRendererCapabilities = undefined;
    expect(parseWorkspaceHomeRoleStatus(stored)).toEqual({ state: 'none' });
  });

  test('a lapsed status keeps its derived reason and identity', () => {
    expect(
      parseWorkspaceHomeRoleStatus({
        state: 'lapsed',
        reason: 'code-changed',
        paneName: 'Third-party Home',
        pluginId: PLUGIN_ID,
      }),
    ).toEqual({
      state: 'lapsed',
      reason: 'code-changed',
      paneName: 'Third-party Home',
      pluginId: PLUGIN_ID,
    });
  });

  test('an unknown reason, a missing identity, or garbage all land on none', () => {
    expect(
      parseWorkspaceHomeRoleStatus({
        state: 'lapsed',
        reason: 'because',
        paneName: 'X',
        pluginId: 'y',
      }),
    ).toEqual({ state: 'none' });
    expect(
      parseWorkspaceHomeRoleStatus({ state: 'lapsed', reason: 'code-changed' }),
    ).toEqual({ state: 'none' });
    expect(parseWorkspaceHomeRoleStatus(undefined)).toEqual({ state: 'none' });
    expect(parseWorkspaceHomeRoleStatus('granted')).toEqual({ state: 'none' });
    expect(parseWorkspaceHomeRoleStatus({ state: 'granted' })).toEqual({
      state: 'none',
    });
  });
});
