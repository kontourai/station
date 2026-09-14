// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePullRequestPaneInstance,
  parseWorkspacePullRequestPaneId,
  pullRequestProviderForHost,
  workspacePullRequestPaneId,
} from '@kontourai/station-contracts/workspace-pull-request-pane';
import { beforeEach, describe, expect, test } from 'vitest';
import { createFilePreviewPaneInstance } from '../../workspace-panes/filePreviewPaneInstance';
import { writeFilePreviewPaneState } from '../../workspace-panes/filePreviewPaneStateStorage';
import {
  DOCK_REGION_IDS,
  INSTANCE_SURFACE_PREFIXES,
  REGION_IDS,
  resolveRegionSurface,
  surfaceMayOccupy,
} from '../region-model';
import {
  REGION_SURFACE_PANES,
  regionSurfaceOfPane,
  regionSurfacePane,
} from '../region-surface-panes';

const NONCE = 'a'.repeat(32);
const PREVIEW_ID = `file-preview:${NONCE}`;
const PR_ID = 'pr:github.com/kontourai/station#2049';
const PROJECT = { projectId: 'project-uuid', projectSlug: 'station' };

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

  test('the prefixes and the inventory describe the same two families', () => {
    for (const prefix of INSTANCE_SURFACE_PREFIXES) {
      // Not a registry surface and not a map entry: an instance pane has no
      // blank occurrence, so it never appears in either inventory by name.
      expect(REGION_SURFACE_PANES.has(prefix.prefix)).toBe(false);
      expect(resolveRegionSurface(prefix.prefix)).toBeUndefined();
    }
    writePreview('src/app.ts');
    expect(regionSurfacePane(PR_ID)?.descriptorId).toBe(
      INSTANCE_SURFACE_PREFIXES[0]?.descriptorId,
    );
    expect(regionSurfacePane(PREVIEW_ID)?.descriptorId).toBe(
      INSTANCE_SURFACE_PREFIXES[1]?.descriptorId,
    );
  });

  test('an instance id resolves to a dock-only surface, and never to main', () => {
    for (const id of [PR_ID, PREVIEW_ID]) {
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

  test('a bare prefix, an unknown prefix and a malformed id resolve to nothing', () => {
    // `pr:` and `file-preview:` alone name no pull request and no preview;
    // resolving them would put an unrenderable tab in a region.
    expect(resolveRegionSurface('pr:')).toBeUndefined();
    expect(resolveRegionSurface('file-preview:')).toBeUndefined();
    expect(resolveRegionSurface('browser-preview:abc')).toBeUndefined();
    expect(regionSurfacePane('pr:github.com/owner#12')).toBeUndefined();
    expect(regionSurfacePane('pr:github.com/o/r#nan')).toBeUndefined();
    expect(regionSurfacePane(`file-preview:${'z'.repeat(32)}`)).toBeUndefined();
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
    expect(PR_ID).not.toContain(',');
    expect(PREVIEW_ID).not.toContain(',');
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

  test('each prefix names a renderer source that reads no region state', () => {
    // The same rule `region-surface-boundary.test.ts` applies to every
    // registered surface: a pane renderer must not read the region model, or
    // placement and rendering become two authorities.
    for (const prefix of INSTANCE_SURFACE_PREFIXES) {
      const source = readFileSync(
        resolve(process.cwd(), prefix.sourceFile),
        'utf8',
      );
      expect(source, prefix.sourceFile).not.toMatch(
        /from ['"][^'"]*(?:RegionModelContext|regions\/region-model)['"]|useRegionModel(?:Optional)?\s*\(/,
      );
    }
  });
});
