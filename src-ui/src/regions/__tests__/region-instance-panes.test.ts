// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createWorkspaceLayoutPaneInstance,
  workspaceLayoutPaneId,
} from '@kontourai/station-contracts/workspace-layout-pane';
import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePullRequestPaneInstance,
  parseWorkspacePullRequestPaneId,
  pullRequestProviderForHost,
  workspacePullRequestPaneId,
} from '@kontourai/station-contracts/workspace-pull-request-pane';
import { beforeEach, describe, expect, test } from 'vitest';
import { writeBrowserPreviewPaneState } from '../../workspace-panes/browserPreviewPaneStateStorage';
import { createFilePreviewPaneInstance } from '../../workspace-panes/filePreviewPaneInstance';
import { writeFilePreviewPaneState } from '../../workspace-panes/filePreviewPaneStateStorage';
import {
  DOCK_REGION_IDS,
  INSTANCE_SURFACE_PREFIXES,
  isInstanceSurface,
  REGION_IDS,
  REGION_SURFACE_REGISTRY,
  resolveRegionSurface,
  surfaceMayOccupy,
} from '../region-model';
import {
  INSTANCE_SURFACE_SOURCE_FILES,
  REGION_SURFACE_PANES,
  regionSurfaceOfPane,
  regionSurfacePane,
} from '../region-surface-panes';

const NONCE = 'a'.repeat(32);
const PREVIEW_ID = `file-preview:${NONCE}`;
const BROWSER_ID = `browser-preview:${NONCE}`;
const PR_ID = 'pr:github.com/kontourai/station#2049';
const PROJECT = { projectId: 'project-uuid', projectSlug: 'station' };
const LAYOUT_UUID = '1d61ce22-7f4b-4282-86f0-019ef1bc223c';
const PROJECT_UUID = 'f2e27d8e-dd81-4fe3-9d6e-9de369389b01';
const BOARD_ID = `board:${LAYOUT_UUID}`;
const LAYOUT_ID = `layout:${PROJECT_UUID}/${LAYOUT_UUID}`;

/**
 * One row per instance family: the prefix `INSTANCE_SURFACE_PREFIXES`
 * declares, the descriptor its occurrences carry, ids the family's minter
 * produces and ids that merely start the same way. Table-driven so a new
 * family is one row, and no assertion indexes the prefix table by position.
 */
const FAMILIES: readonly {
  prefix: string;
  descriptorId: string;
  admitted: readonly string[];
  refused: readonly string[];
}[] = [
  {
    prefix: 'pr:',
    descriptorId: 'pane:builtin:workspace-pull-request',
    admitted: [PR_ID, `${PR_ID.slice(0, -4)}1`],
    refused: [
      'pr:',
      'pr:not-a-real-id',
      'pr:github.com/owner#12',
      'pr:github.com/o/r#nan',
      'pr:github.com/o/r#',
      'pr:github.com/o/r/extra#1',
      'pr:GitHub.com/o/r#1',
      'pr:/o/r#1',
    ],
  },
  {
    prefix: 'file-preview:',
    descriptorId: 'pane:builtin:workspace-preview:file-preview',
    admitted: [PREVIEW_ID],
    refused: [
      'file-preview:',
      'file-preview:zzz',
      `file-preview:${'z'.repeat(32)}`,
      `file-preview:${'a'.repeat(31)}`,
      `file-preview:${'a'.repeat(33)}`,
    ],
  },
  // #90 D9: a Browser pane attached to one session.
  {
    prefix: 'browser-preview:',
    descriptorId: 'pane:builtin:workspace-preview:browser-preview',
    admitted: [BROWSER_ID],
    refused: [
      'browser-preview:',
      'browser-preview:abc',
      `browser-preview:${'z'.repeat(32)}`,
      `browser-preview:${'a'.repeat(31)}`,
      `browser-preview:${'a'.repeat(33)}`,
    ],
  },
  // #2157: a Board and a project Layout share one descriptor.
  {
    prefix: 'board:',
    descriptorId: 'pane:builtin:workspace-layout',
    admitted: [BOARD_ID],
    refused: [
      'board:',
      'board:coding',
      `board:${LAYOUT_UUID.toUpperCase()}`,
      `board:${LAYOUT_UUID},${LAYOUT_UUID}`,
      `board:${LAYOUT_UUID}/${LAYOUT_UUID}`,
    ],
  },
  {
    prefix: 'layout:',
    descriptorId: 'pane:builtin:workspace-layout',
    admitted: [LAYOUT_ID],
    refused: [
      'layout:',
      `layout:${LAYOUT_UUID}`,
      `layout:${PROJECT_UUID}/`,
      `layout:${PROJECT_UUID}/${LAYOUT_UUID}/extra`,
      `layout:${PROJECT_UUID}/coding`,
    ],
  },
];

function writePreview(path: string, projectSlug = 'station', id = PREVIEW_ID) {
  writeFilePreviewPaneState(window.localStorage, id, {
    version: '1.0',
    projectSlug,
    path,
    wrap: true,
  });
}

/**
 * #2049: a pull request and a file preview are one pane per THING, so their
 * ids are data rather than registry keys. Two tables carry them — the entry
 * chunk's `INSTANCE_SURFACE_PREFIXES` (placement, titles, the descriptor id)
 * and the host chunk's occurrence minting in `region-surface-panes` — and
 * these are the pins that keep the two describing one family each.
 */
describe('instance-keyed dock panes (#2049)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('the prefixes and the inventory describe the same families, one row each', () => {
    // The table above IS the prefix table, by prefix and descriptor id: a
    // family added to one and not the other reds here.
    expect(
      INSTANCE_SURFACE_PREFIXES.map(({ prefix, descriptorId }) => ({
        prefix,
        descriptorId,
      })),
    ).toEqual(
      FAMILIES.map(({ prefix, descriptorId }) => ({ prefix, descriptorId })),
    );
    writePreview('src/app.ts');
    for (const family of FAMILIES) {
      // Not a registry surface and not a map entry: an instance pane has no
      // blank occurrence, so it never appears in either inventory by name.
      expect(REGION_SURFACE_PANES.has(family.prefix)).toBe(false);
      expect(resolveRegionSurface(family.prefix)).toBeUndefined();
      for (const id of family.admitted)
        expect(regionSurfacePane(id)?.descriptorId, id).toBe(
          family.descriptorId,
        );
    }
  });

  test('an instance id resolves to a dock-only surface, and never to main', () => {
    for (const id of FAMILIES.flatMap((family) => family.admitted)) {
      const surface = resolveRegionSurface(id);
      expect(surface?.id, id).toBe(id);
      // Catalog exposure, so the toolbar's picker, the chords and the
      // unplaced Show rows never offer a pane a link click created.
      expect(surface?.exposure, id).toBe('catalog');
      expect(surface?.shortcut, id).toBeUndefined();
      expect(surface?.regions, id).toEqual(DOCK_REGION_IDS);
      for (const region of REGION_IDS)
        expect(surfaceMayOccupy(id, region), `${id} in ${region}`).toBe(
          region !== 'main',
        );
    }
  });

  /**
   * The pin `RegionShells`' mount rule names: it mounts a host for an
   * occupant `resolveRegionSurface` answers for, and `RegionPaneHost` renders
   * a pane for one `regionSurfacePane` mints. An id only the first admits is a
   * dock region with chrome, no pane, no tab strip — and so no close control.
   *
   * Both halves must be exercised, because both are ways to be wrong:
   * resolving what cannot be minted is the empty region, and minting what
   * cannot be resolved is a pane no region will ever mount.
   */
  test('the id-keyed resolver and the occurrence minter admit exactly the same ids', () => {
    writePreview('src/app.ts');
    const admitted = FAMILIES.flatMap((family) => family.admitted);
    const refused = [
      // A prefix no family declares.
      'web-preview:abc',
      // Per family: bare prefixes and same-prefix shapes the minter could
      // never produce.
      ...FAMILIES.flatMap((family) => family.refused),
    ];
    expect(admitted.length).toBeGreaterThanOrEqual(FAMILIES.length);
    for (const id of admitted) {
      expect(resolveRegionSurface(id), id).toBeDefined();
      expect(regionSurfacePane(id), id).toBeDefined();
    }
    for (const id of refused) {
      expect(resolveRegionSurface(id), id).toBeUndefined();
      expect(regionSurfacePane(id), id).toBeUndefined();
    }
  });

  /**
   * #2159 slice A: `isInstanceSurface` is the one predicate every site that
   * treats the two kinds differently asks — today the record parser's
   * cross-region de-dup, which exempts exactly the ids this admits.
   *
   * The WHOLE registry is driven rather than a sample, because the property
   * that matters is a total partition: a shell surface must never be read as
   * instance-keyed by a caller deciding whether a pane may live in two
   * regions at once. Chat is the one the product cares about (it stays
   * single-placement until it is per-conversation) and is named below as
   * well as covered by the loop.
   *
   * Making the function `return false` reds the admitted rows here and the
   * two-region parser tests in `region-arrangement-record.test.ts`; making it
   * admit by `startsWith` reds the refused rows.
   */
  test('`isInstanceSurface` admits the families and refuses every registry key', () => {
    expect(isInstanceSurface('chat')).toBe(false);
    for (const id of REGION_SURFACE_REGISTRY.keys())
      expect(isInstanceSurface(id), id).toBe(false);
    // Registry-first has no discriminating case TODAY — no registry key is a
    // shape any family mints, pinned here — so the clause is a guard against
    // a future collision rather than live behaviour. This is what keeps it
    // inert: a registry id a family also matched would red here, and the
    // answer would be to rename one, not to reorder the predicate.
    for (const id of REGION_SURFACE_REGISTRY.keys())
      expect(
        INSTANCE_SURFACE_PREFIXES.some((entry) => entry.matches(id)),
        id,
      ).toBe(false);
    for (const family of FAMILIES) {
      for (const id of family.admitted)
        expect(isInstanceSurface(id), id).toBe(true);
      // A malformed id of the family is NOT an instance surface: the parser
      // drops it entirely, so admitting it here would exempt an id from a
      // de-dup it never reaches — a rule about a pane that cannot exist.
      for (const id of family.refused)
        expect(isInstanceSurface(id), id).toBe(false);
    }
    for (const id of ['', 'browser-preview:abc', 'home'])
      expect(isInstanceSurface(id), id).toBe(false);
  });

  test('no id an opener can mint carries a comma', () => {
    // `regionStatesEqual` compares `RegionState.panes` by joining it, so a
    // comma in an id would make two different pane lists compare equal.
    expect(
      workspacePullRequestPaneId({
        host: 'gh,evil.com',
        owner: 'o',
        repository: 'r',
        ref: '1',
      }),
    ).toBeNull();
    expect(
      workspacePullRequestPaneId({
        host: 'github.com',
        owner: 'a,b',
        repository: 'r',
        ref: '1',
      }),
    ).toBeNull();
    expect(
      workspaceLayoutPaneId({ kind: 'board', layoutId: `${LAYOUT_UUID},x` }),
    ).toBeNull();
    for (const id of FAMILIES.flatMap((family) => family.admitted))
      expect(id).not.toContain(',');
  });

  test('one pull request has one id whatever case or suffix the URL used', () => {
    const canonical = workspacePullRequestPaneId({
      host: 'GitHub.com',
      owner: 'Kontourai',
      repository: 'Station',
      ref: '2049',
    });
    expect(canonical).toBe(PR_ID);
    expect(parseWorkspacePullRequestPaneId(PR_ID)).toEqual({
      host: 'github.com',
      owner: 'kontourai',
      repository: 'station',
      ref: '2049',
    });
    expect(parseWorkspacePullRequestPaneId('pr:github.com/o/r')).toBeNull();
    // The round trip is the parse: an id spelled any other way is not this id.
    expect(parseWorkspacePullRequestPaneId('pr:GitHub.com/o/r#1')).toBeNull();
    expect(pullRequestProviderForHost('GitLab.com')).toBe('gitlab');
    expect(pullRequestProviderForHost('gitlab.com:443')).toBe('gitlab');
    expect(pullRequestProviderForHost('github.com')).toBe('github');
    expect(pullRequestProviderForHost('git.example.org')).toBe('github');
  });

  /**
   * The server resolves a review by `provider.getHost(context) === <host>`
   * (`pull-request-routes.ts`), and `getHost` lowercases the remote's host and
   * KEEPS its port. An id that dropped the port would name an endpoint no
   * route can match, and would fold a forge's two endpoints into one tab.
   * `canServeHost` — which is port-blind — decides only which PROVIDER claims
   * a host, and `pullRequestProviderForHost` above still mirrors that.
   */
  test('a self-hosted forge on a port keeps it in the id, and is a different pane from the bare host', () => {
    const ported = workspacePullRequestPaneId({
      host: 'GHE.corp.example:8443',
      owner: 'o',
      repository: 'r',
      ref: '7',
    });
    expect(ported).toBe('pr:ghe.corp.example:8443/o/r#7');
    expect(parseWorkspacePullRequestPaneId(ported as string)?.host).toBe(
      'ghe.corp.example:8443',
    );
    expect(
      workspacePullRequestPaneId({
        host: 'ghe.corp.example',
        owner: 'o',
        repository: 'r',
        ref: '7',
      }),
    ).not.toBe(ported);
    // A trailing dot still folds — a remote is written without one, so
    // dropping it makes the server's equality MORE likely to hold.
    expect(
      workspacePullRequestPaneId({
        host: 'github.com.',
        owner: 'o',
        repository: 'r',
        ref: '7',
      }),
    ).toBe('pr:github.com/o/r#7');
    // And the entry chunk's shape rule admits the ported id too, or the pane
    // would resolve in one half of the split and not the other.
    expect(resolveRegionSurface(ported as string)?.id).toBe(ported);
    expect(regionSurfacePane(ported as string)?.title).toBe('#7');
  });

  test("a pull-request pane binds the dock's project and folds back to its own id", () => {
    const pane = regionSurfacePane(PR_ID);
    expect(pane?.title).toBe('#2049');
    expect(pane?.instance({ projectId: null, projectSlug: null })).toBeNull();
    const instance = pane?.instance(PROJECT);
    expect(instance?.boundContext).toEqual({
      projectId: 'project-uuid',
      sourceId: 'builtin:workspace-pull-request',
    });
    expect(String(instance?.instanceId)).toBe(PR_ID);
    if (!instance) throw new Error('the occurrence must mint');
    expect(regionSurfaceOfPane(instance)).toBe(PR_ID);
    // Another pull request's occurrence is not this pane's.
    const other = createWorkspacePullRequestPaneInstance(
      {
        host: 'github.com',
        owner: 'kontourai',
        repository: 'station',
        ref: '7',
      },
      'project-uuid',
    );
    if (!other) throw new Error('the sibling occurrence must mint');
    expect(pane?.isCanonical(other)).toBe(false);
    expect(regionSurfaceOfPane(other)).toBe(
      'pr:github.com/kontourai/station#7',
    );
  });

  test('an impostor under the pull-request descriptor is no surface', () => {
    const impostor = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'pane:builtin:workspace-pull-request',
      instanceId: PR_ID,
      stateKey: 'something-else',
      boundContext: {
        projectId: 'project-uuid',
        sourceId: 'builtin:workspace-pull-request',
      },
    });
    if (!impostor) throw new Error('fixture must parse');
    expect(regionSurfaceOfPane(impostor)).toBeNull();
  });

  test("a file preview names its file, binds the dock's project and refuses another project's", () => {
    writePreview('src/components/Deep/File.tsx');
    const pane = regionSurfacePane(PREVIEW_ID);
    expect(pane?.title).toBe('File.tsx');
    const instance = pane?.instance(PROJECT);
    expect(String(instance?.instanceId)).toBe(PREVIEW_ID);
    expect(instance?.boundContext?.projectId).toBe('project-uuid');
    if (!instance) throw new Error('the occurrence must mint');
    expect(regionSurfaceOfPane(instance)).toBe(PREVIEW_ID);
    // The dock binds another project: the state names a path in a checkout
    // this dock is not showing, so there is no occurrence to derive rather
    // than one silently rebound to the wrong project.
    expect(
      regionSurfacePane(PREVIEW_ID)?.instance({
        projectId: 'other-uuid',
        projectSlug: 'other',
      }),
    ).toBeNull();
  });

  test("a Browser pane binds its session's Project, refuses another's, and has no occurrence without state", () => {
    const pane = () => regionSurfacePane(BROWSER_ID);
    // No stored session: the tab survives (the id stays in the record) but
    // there is nothing to render.
    expect(pane()?.surfaceId).toBe(BROWSER_ID);
    expect(pane()?.instance(PROJECT)).toBeNull();
    writeBrowserPreviewPaneState(window.localStorage, BROWSER_ID, {
      version: '2.0',
      projectId: 'project-uuid',
      browserSessionId: 'bs_00000000-0000-4000-8000-000000000001',
      updatedAt: '2026-09-22T00:00:00.000Z',
    });
    expect(pane()?.title).toBe('Browser');
    const instance = pane()?.instance(PROJECT);
    expect(String(instance?.instanceId)).toBe(BROWSER_ID);
    expect(instance?.boundContext?.projectId).toBe('project-uuid');
    if (!instance) throw new Error('the occurrence must mint');
    expect(regionSurfaceOfPane(instance)).toBe(BROWSER_ID);
    // A dock bound to another Project does not rebind this session to it.
    expect(
      pane()?.instance({ projectId: 'other-uuid', projectSlug: 'other' }),
    ).toBeNull();
  });

  test('a file preview whose state is gone keeps its tab and has no occurrence', () => {
    window.localStorage.clear();
    const pane = regionSurfacePane(PREVIEW_ID);
    // The tab survives, so the id in the arrangement record is not silently
    // dropped by a storage read; only the rendering waits.
    expect(pane?.surfaceId).toBe(PREVIEW_ID);
    expect(pane?.title).toBeUndefined();
    expect(pane?.instance(PROJECT)).toBeNull();
    const orphan = createFilePreviewPaneInstance(
      { version: '1.0', projectSlug: 'station', path: 'a.ts', wrap: true },
      'project-uuid',
      NONCE,
    );
    if (!orphan) throw new Error('fixture must mint');
    expect(pane?.isCanonical(orphan)).toBe(false);
    expect(regionSurfaceOfPane(orphan)).toBeNull();
  });

  /**
   * #2157: a Layout pane's occurrence is a function of its id ALONE — a
   * project Layout binds the project its id names, a Board binds none — so
   * the dock's own project is irrelevant: another project's Layout, or a
   * dock with no project at all, mints the same occurrence. Reverting the
   * minter to bind the dock's `projectId` reds the "other project" row.
   */
  test("a Layout pane mints from its id alone, whatever the dock's project", () => {
    const board = regionSurfacePane(BOARD_ID);
    const layout = regionSurfacePane(LAYOUT_ID);
    // No title in the host chunk: the Layout's name is the SDK's to list.
    expect(board?.title).toBeUndefined();
    expect(layout?.title).toBeUndefined();
    for (const context of [
      { projectId: null, projectSlug: null },
      PROJECT,
      { projectId: 'other-uuid', projectSlug: 'other' },
    ]) {
      const boardInstance = board?.instance(context);
      expect(String(boardInstance?.instanceId), 'board').toBe(BOARD_ID);
      expect(boardInstance?.boundContext, 'board').toEqual({
        sourceId: 'builtin:workspace-layout',
      });
      const layoutInstance = layout?.instance(context);
      expect(String(layoutInstance?.instanceId), 'layout').toBe(LAYOUT_ID);
      expect(layoutInstance?.boundContext, 'layout').toEqual({
        projectId: PROJECT_UUID,
        sourceId: 'builtin:workspace-layout',
      });
      if (!boardInstance || !layoutInstance)
        throw new Error('the occurrences must mint');
      expect(regionSurfaceOfPane(boardInstance)).toBe(BOARD_ID);
      expect(regionSurfaceOfPane(layoutInstance)).toBe(LAYOUT_ID);
    }
    // Another Layout's occurrence is not this pane's.
    const other = createWorkspaceLayoutPaneInstance({
      kind: 'board',
      layoutId: PROJECT_UUID,
    });
    if (!other) throw new Error('the sibling occurrence must mint');
    expect(board?.isCanonical(other)).toBe(false);
    expect(regionSurfaceOfPane(other)).toBe(`board:${PROJECT_UUID}`);
    // An impostor under the Layout descriptor is no surface.
    const impostor = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'pane:builtin:workspace-layout',
      instanceId: LAYOUT_ID,
      stateKey: LAYOUT_ID,
      boundContext: {
        projectId: 'other-uuid',
        sourceId: 'builtin:workspace-layout',
      },
    });
    if (!impostor) throw new Error('fixture must parse');
    expect(regionSurfaceOfPane(impostor)).toBeNull();
  });

  test('each prefix names a renderer source that reads no region state', () => {
    // The same rule `region-surface-boundary.test.ts` applies to every
    // registered surface: a pane renderer must not read the region model, or
    // placement and rendering become two authorities. The sources are kept
    // out of the entry chunk's table (#90 D9), so first: exactly one per
    // family, no family without one and no source for a family that is gone.
    expect(Object.keys(INSTANCE_SURFACE_SOURCE_FILES)).toEqual(
      INSTANCE_SURFACE_PREFIXES.map((prefix) => prefix.prefix),
    );
    for (const prefix of INSTANCE_SURFACE_PREFIXES) {
      const sourceFile = INSTANCE_SURFACE_SOURCE_FILES[prefix.prefix];
      if (!sourceFile) throw new Error(`${prefix.prefix} names no renderer`);
      const source = readFileSync(resolve(process.cwd(), sourceFile), 'utf8');
      expect(source, sourceFile).not.toMatch(
        /from ['"][^'"]*(?:RegionModelContext|regions\/region-model)['"]|useRegionModel(?:Optional)?\s*\(/,
      );
    }
  });
});
