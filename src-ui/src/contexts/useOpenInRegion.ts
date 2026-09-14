import type {
  WorkspaceFilePreviewLineRange,
  WorkspaceFilePreviewPaneState,
} from '@kontourai/station-contracts/workspace-file-preview';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePullRequestPaneInstance,
  type WorkspacePullRequestPaneKey,
} from '@kontourai/station-contracts/workspace-pull-request-pane';
import { useCallback } from 'react';
import { REGION_IDS, type RegionArrangement } from '../regions/region-model';
import { regionSurfaceOfPane } from '../regions/region-surface-panes';
import { createFilePreviewPaneInstance } from '../workspace-panes/filePreviewPaneInstance';
import {
  createFilePreviewPaneStatePreparation,
  readFilePreviewPaneState,
} from '../workspace-panes/filePreviewPaneStateStorage';
import {
  type OpenInRegionOptions,
  type OpenInRegionOutcome,
  type OpenInRegionRefusal,
  useRegionModel,
} from './RegionModelContext';

/**
 * Why an instance-keyed open did not happen, beyond the model's own reasons
 * (#2049). `unsupplied` — the caller has no Project to bind the occurrence
 * to, and a pull request or a file preview needs one to fetch anything;
 * `not-stored` — a file preview's state could not be written, so there is
 * nothing for the pane to render. Both are decided BEFORE the model is
 * asked, so like every model refusal they leave the arrangement untouched.
 */
export type OpenPaneRefusal = OpenInRegionRefusal | 'unsupplied' | 'not-stored';

/**
 * One sentence per refusal, as a total record: a new reason is a type error
 * here, so a refusal can never reach a user as copy that happens to be wrong
 * (the shape `describeWorkspacePaneOpenRefusal` set).
 */
const REFUSAL_SENTENCES: Record<OpenPaneRefusal, string> = {
  'no-surface': 'A dock region cannot hold that pane.',
  'unsupported-placement':
    'A dock region holds its panes as tabs, so it cannot be split.',
  'region-unavailable': 'That region is not available on this device.',
  refused: 'That pane cannot be placed in that region.',
  unsupplied: 'Choose a project for this dock before opening that pane.',
  'not-stored': 'This device could not store the preview to open it.',
};

/** The sentence a surface shows for a refusal it just received. */
export function describeOpenInRegionRefusal(reason: OpenPaneRefusal): string {
  return REFUSAL_SENTENCES[reason];
}

/** The model half `openInRegion` composes: `RegionModelContext.openSurfaceInRegion`. */
export interface OpenSurfaceInRegionModel {
  openSurfaceInRegion(
    surfaceId: string,
    options?: OpenInRegionOptions,
  ): OpenInRegionOutcome;
}

/**
 * The model half the file-preview opener needs on top of that: the
 * arrangement, so a second click on a file already previewed somewhere
 * focuses that tab rather than minting a second nonce for the same path.
 */
export interface OpenPaneInRegionModel extends OpenSurfaceInRegionModel {
  regions: RegionArrangement;
}

/** Every pane id any region holds, in region order. */
function placedPaneIds(regions: RegionArrangement): string[] {
  return REGION_IDS.flatMap((id) => [...regions[id].panes]);
}

/**
 * Open a pane instance in a dock region (#2048): the one producer callers
 * use for a cross-region open, generalising `showSurface(id, intent)` to an
 * instance. Resolves the instance to its surface through the pane inventory
 * (`regionSurfaceOfPane` — the canonical-occurrence fold, so an impostor
 * under a surface's descriptor is `no-surface`, not the surface) and hands
 * the surface to the model, which resolves the region, reveals it and
 * places or selects. Everything the model refuses comes back typed; nothing
 * navigates, nothing is written for a refusal.
 *
 * Since #2049 the fold reaches instance-keyed panes too: a pull request and
 * a file preview are their own surface ids in `RegionState.panes`, resolved
 * by prefix (`INSTANCE_SURFACE_PREFIXES`). Their callers go through
 * `openPullRequestInRegion` / `openFilePreviewInRegion` below, which own the
 * two things a bare instance cannot carry — the Project binding a refusal
 * must report, and a preview's stored state.
 *
 * A sibling of `useShowSurface`, not a method of the provider, on purpose:
 * the provider is in the entry chunk and the inventory's contracts are not
 * (measured +1,820 B gzip against a 527 B headroom, #2047). Every caller of
 * this hook — the region catalog, a pane's own link handler — already lives
 * behind a lazy boundary, so importing it costs the entry nothing.
 */
export function openInRegion(
  model: OpenSurfaceInRegionModel,
  instance: WorkspacePaneInstance,
  options?: OpenInRegionOptions,
): OpenInRegionOutcome {
  const surfaceId = regionSurfaceOfPane(instance);
  if (surfaceId === null) return { ok: false, reason: 'no-surface' };
  return model.openSurfaceInRegion(surfaceId, options);
}

/**
 * Open one pull request as a dock pane (#2049). The id the occurrence carries
 * IS the pull request's identity, so a second open of the same one is the
 * model's own reveal (`openSurfaceInRegion`'s held branch) with no work here.
 */
export function openPullRequestInRegion(
  model: OpenSurfaceInRegionModel,
  key: WorkspacePullRequestPaneKey,
  projectId: string | null,
  options?: OpenInRegionOptions,
): OpenInRegionOutcome | { ok: false; reason: OpenPaneRefusal } {
  if (projectId === null) return { ok: false, reason: 'unsupplied' };
  const instance = createWorkspacePullRequestPaneInstance(key, projectId);
  if (!instance) return { ok: false, reason: 'no-surface' };
  return openInRegion(model, instance, options);
}

/** What a file preview pane is opened for: one file of one Project. */
export interface OpenFilePreviewRequest {
  projectId: string | null;
  projectSlug: string | null;
  path: string;
  lineRange?: WorkspaceFilePreviewLineRange;
}

/**
 * Open one file preview as a dock pane (#2049).
 *
 * Two things this owns that a plain `openInRegion` cannot. First, DEDUPE:
 * a preview's identity is an opaque nonce, so two clicks on one path would
 * mint two tabs; the already-placed previews are scanned by their stored
 * state instead and a match is revealed. Second, the STATE WRITE: the pane
 * renders from `station:file-preview-pane-state:v1:<id>`, which must exist
 * before the region derives the occurrence — and must not survive a refusal,
 * or a click the model turned down would leave a record behind. Written
 * first, rolled back when the model says no.
 */
export function openFilePreviewInRegion(
  model: OpenPaneInRegionModel,
  request: OpenFilePreviewRequest,
  options?: OpenInRegionOptions,
): OpenInRegionOutcome | { ok: false; reason: OpenPaneRefusal } {
  const { projectId, projectSlug, path, lineRange } = request;
  if (projectId === null || projectSlug === null)
    return { ok: false, reason: 'unsupplied' };
  const state: WorkspaceFilePreviewPaneState = {
    version: '1.0',
    projectSlug,
    path,
    ...(lineRange ? { lineRange } : {}),
    wrap: true,
  };
  const storage = window.localStorage;
  const held = placedPaneIds(model.regions).find((id) => {
    if (!id.startsWith('file-preview:')) return false;
    const stored = readFilePreviewPaneState(storage, id);
    return stored?.projectSlug === projectSlug && stored.path === path;
  });
  if (held !== undefined)
    return model.openSurfaceInRegion(held, {
      ...options,
      focusExisting: true,
    });
  const instance = createFilePreviewPaneInstance(state, projectId);
  if (!instance) return { ok: false, reason: 'no-surface' };
  const preparation = createFilePreviewPaneStatePreparation(
    storage,
    String(instance.stateKey),
    state,
  );
  if (!preparation.prepare()) return { ok: false, reason: 'not-stored' };
  const outcome = openInRegion(model, instance, options);
  if (!outcome.ok) preparation.rollback();
  return outcome;
}

/** `openInRegion` bound to the mounted region model. */
export function useOpenInRegion(): (
  instance: WorkspacePaneInstance,
  options?: OpenInRegionOptions,
) => OpenInRegionOutcome {
  const model = useRegionModel();
  return useCallback(
    (instance: WorkspacePaneInstance, options?: OpenInRegionOptions) =>
      openInRegion(model, instance, options),
    [model],
  );
}

/** The two instance-keyed openers, bound to the mounted region model (#2049). */
export function useOpenPaneInRegion(): {
  openPullRequest: (
    key: WorkspacePullRequestPaneKey,
    projectId: string | null,
    options?: OpenInRegionOptions,
  ) => OpenInRegionOutcome | { ok: false; reason: OpenPaneRefusal };
  openFilePreview: (
    request: OpenFilePreviewRequest,
    options?: OpenInRegionOptions,
  ) => OpenInRegionOutcome | { ok: false; reason: OpenPaneRefusal };
} {
  const model = useRegionModel();
  return {
    openPullRequest: useCallback(
      (
        key: WorkspacePullRequestPaneKey,
        projectId: string | null,
        options?: OpenInRegionOptions,
      ) => openPullRequestInRegion(model, key, projectId, options),
      [model],
    ),
    openFilePreview: useCallback(
      (request: OpenFilePreviewRequest, options?: OpenInRegionOptions) =>
        openFilePreviewInRegion(model, request, options),
      [model],
    ),
  };
}
