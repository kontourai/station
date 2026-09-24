import {
  parseWorkspaceBrowserPaneState,
  WORKSPACE_BROWSER_PANE_STATE_VERSION,
} from '@kontourai/station-contracts/workspace-browser-pane';
import type {
  WorkspaceFilePreviewLineRange,
  WorkspaceFilePreviewPaneState,
} from '@kontourai/station-contracts/workspace-file-preview';
import {
  createWorkspaceLayoutPaneInstance,
  type WorkspaceLayoutPaneKey,
} from '@kontourai/station-contracts/workspace-layout-pane';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import {
  createWorkspacePullRequestPaneInstance,
  type WorkspacePullRequestPaneKey,
} from '@kontourai/station-contracts/workspace-pull-request-pane';
import { useCallback } from 'react';
import { REGION_IDS, type RegionArrangement } from '../regions/region-model';
import { regionSurfaceOfPane } from '../regions/region-surface-panes';
import { createBrowserPreviewPaneInstance } from '../workspace-panes/browserPreviewPaneInstance';
import {
  createBrowserPreviewPaneStatePreparation,
  readBrowserPreviewPaneState,
} from '../workspace-panes/browserPreviewPaneStateStorage';
import { createFilePreviewPaneInstance } from '../workspace-panes/filePreviewPaneInstance';
import {
  createFilePreviewPaneStatePreparation,
  readFilePreviewPaneState,
  writeFilePreviewPaneState,
} from '../workspace-panes/filePreviewPaneStateStorage';
import {
  type OpenInRegionOptions,
  type OpenInRegionOutcome,
  type OpenInRegionRefusal,
  useRegionModel,
  useRegionModelOptional,
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

/**
 * Open one Board or project Layout as a dock pane (#2157). The id the
 * occurrence carries IS the Layout's identity (its server id, plus its
 * project's for a project Layout), so a second open of the same one is the
 * model's own reveal. No Project binding to report as `unsupplied`: a Board
 * has none and a project Layout carries its own in the key, so the only
 * refusal beyond the model's is an id the grammar cannot mint (`no-surface`).
 */
export function openLayoutInRegion(
  model: OpenSurfaceInRegionModel,
  key: WorkspaceLayoutPaneKey,
  options?: OpenInRegionOptions,
): OpenInRegionOutcome {
  const instance = createWorkspaceLayoutPaneInstance(key);
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
 * state instead and a match is revealed — carrying a newly requested line
 * range onto it, since the dedupe deliberately ignores the range and a
 * reveal that dropped it would answer a different question than the one
 * clicked. Second, the STATE WRITE: the pane
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
  if (held !== undefined) {
    // The dedupe matches on project and path, so `src/app.ts#L400` finds the
    // tab already open at `#L5`. Revealing it without writing the new range
    // would show line 5 under a click that asked for line 400, with nothing
    // on screen saying the request was dropped. The range is written first,
    // so whatever render the reveal causes reads it (the pane derives its
    // state from storage on every render), and restored when the model
    // refuses — the same write-then-roll-back discipline the mint path below
    // uses, for the same reason: a refused click must leave no record.
    //
    // A request with NO range does not clear a stored one: an href without a
    // line anchor names the file, and says nothing about lines, so treating
    // it as "forget the line" would move the view on the user's behalf.
    //
    // Residual, disclosed: when the held pane is ALREADY the selected pane of
    // an already-visible region the reveal changes no arrangement, so nothing
    // forces a re-render and the new range shows on the pane's next one.
    // Closing that needs the preview's stored state to be an observable
    // store rather than a localStorage read at render time.
    const previous = readFilePreviewPaneState(storage, held);
    const heldRange = previous?.lineRange;
    const rangeChanged =
      lineRange !== undefined &&
      (heldRange?.start !== lineRange.start ||
        heldRange?.end !== lineRange.end);
    if (rangeChanged && previous)
      writeFilePreviewPaneState(storage, held, { ...previous, lineRange });
    const outcome = model.openSurfaceInRegion(held, {
      ...options,
      focusExisting: true,
    });
    if (!outcome.ok && rangeChanged && previous)
      writeFilePreviewPaneState(storage, held, previous);
    return outcome;
  }
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

/** What a Browser pane is opened for: one server-owned session of one Project. */
export interface OpenBrowserSessionRequest {
  projectId: string;
  browserSessionId: string;
}

/**
 * Open a Browser pane attached to one session as a dock pane (#90 D9) — the
 * float-over-chat's "Open in right panel".
 *
 * The same two duties `openFilePreviewInRegion` owns, for the same reasons.
 * DEDUPE: a Browser pane's identity is an opaque nonce, so a second open of
 * one session would mint a second tab streaming the same surface (two
 * streams against the ADR 0018 connection budget); the placed Browser panes
 * are scanned by their stored session instead and a match is revealed. The
 * STATE WRITE: the pane renders from its stored v2 record, which must exist
 * before the region derives the occurrence and must not survive a refusal.
 */
export function openBrowserSessionInRegion(
  model: OpenPaneInRegionModel,
  request: OpenBrowserSessionRequest,
  options?: OpenInRegionOptions,
): OpenInRegionOutcome | { ok: false; reason: OpenPaneRefusal } {
  const { projectId, browserSessionId } = request;
  const storage = window.localStorage;
  const held = placedPaneIds(model.regions).find((id) => {
    if (!id.startsWith('browser-preview:')) return false;
    const stored = readBrowserPreviewPaneState(storage, id);
    return (
      stored?.version === '2.0' &&
      stored.state.projectId === projectId &&
      stored.state.browserSessionId === browserSessionId
    );
  });
  if (held !== undefined)
    return model.openSurfaceInRegion(held, { ...options, focusExisting: true });
  const state = parseWorkspaceBrowserPaneState({
    version: WORKSPACE_BROWSER_PANE_STATE_VERSION,
    projectId,
    browserSessionId,
    updatedAt: new Date().toISOString(),
  });
  const instance = state
    ? createBrowserPreviewPaneInstance(state, projectId)
    : null;
  if (!state || !instance) return { ok: false, reason: 'no-surface' };
  const preparation = createBrowserPreviewPaneStatePreparation(
    storage,
    String(instance.stateKey),
    state,
  );
  if (!preparation.prepare()) return { ok: false, reason: 'not-stored' };
  const outcome = openInRegion(model, instance, options);
  if (!outcome.ok) preparation.rollback();
  return outcome;
}

/**
 * `openBrowserSessionInRegion` bound to the mounted region model, or null
 * where there is none (the float-over-chat then says the pane cannot open
 * here rather than offering a control that does nothing).
 */
export function useOpenBrowserSessionInRegion():
  | ((
      request: OpenBrowserSessionRequest,
      options?: OpenInRegionOptions,
    ) => OpenInRegionOutcome | { ok: false; reason: OpenPaneRefusal })
  | null {
  const model = useRegionModelOptional();
  const open = useCallback(
    (request: OpenBrowserSessionRequest, options?: OpenInRegionOptions) =>
      openBrowserSessionInRegion(
        model as NonNullable<typeof model>,
        request,
        options,
      ),
    [model],
  );
  return model ? open : null;
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

/**
 * `openFilePreviewInRegion` bound to the mounted region model, or null where
 * there is none (#2049). The optional form exists for a pane that may be
 * mounted either inside a region or inside a layout: a docked Files pane
 * opens a preview as a sibling tab, the same pane in a coding layout keeps
 * the layout's own host route, and neither needs to ask which it is.
 *
 * No `region` is passed: the preview takes the file-preview surface's own
 * placement rule (its default dock region, or the first free one), the same
 * rule a chat link's preview takes. A pane does not choose a region.
 */
export function useOpenFilePreviewInRegion():
  | ((
      request: OpenFilePreviewRequest,
      options?: OpenInRegionOptions,
    ) => OpenInRegionOutcome | { ok: false; reason: OpenPaneRefusal })
  | null {
  const model = useRegionModelOptional();
  const open = useCallback(
    (request: OpenFilePreviewRequest, options?: OpenInRegionOptions) =>
      // Non-null by the guard below: the callback is created unconditionally
      // because a hook must be, and handed out only when there is a model.
      openFilePreviewInRegion(
        model as NonNullable<typeof model>,
        request,
        options,
      ),
    [model],
  );
  return model ? open : null;
}

/**
 * `openPullRequestInRegion` bound to the mounted region model, or null where
 * there is none (#2049). The optional form, for the same reason the preview's
 * is: the Diff pane renders in a coding layout and in a dock region, and only
 * the second one has a sibling tab to put a review in.
 */
export function useOpenPullRequestInRegion():
  | ((
      key: WorkspacePullRequestPaneKey,
      projectId: string | null,
      options?: OpenInRegionOptions,
    ) => OpenInRegionOutcome | { ok: false; reason: OpenPaneRefusal })
  | null {
  const model = useRegionModelOptional();
  const open = useCallback(
    (
      key: WorkspacePullRequestPaneKey,
      projectId: string | null,
      options?: OpenInRegionOptions,
    ) =>
      openPullRequestInRegion(
        model as NonNullable<typeof model>,
        key,
        projectId,
        options,
      ),
    [model],
  );
  return model ? open : null;
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
