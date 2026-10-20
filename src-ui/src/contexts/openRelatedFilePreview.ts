import type { WorkspaceFilePreviewPaneState } from '@kontourai/station-contracts/workspace-file-preview';
import { useCallback, useLayoutEffect, useRef } from 'react';
import {
  readPaneFence,
  removePaneFence,
  writePaneFence,
} from '../regions/pane-fence';
import {
  BUILTIN_PANE_GENERATION,
  keptPaneForTarget,
  openerSelectionKey,
  type PaneOpener,
  type PaneRelationTarget,
  prunePaneRelations,
  sameRelationTarget,
  transientPaneForOpener,
  withPaneRelation,
} from '../regions/pane-relations';
import { isDockRegion, occupiedRegion } from '../regions/region-model';
import { forgetRegionPaneState } from '../regions/region-surface-panes';
import { createFilePreviewPaneInstance } from '../workspace-panes/filePreviewPaneInstance';
import {
  createFilePreviewPaneStatePreparation,
  readFilePreviewPaneState,
} from '../workspace-panes/filePreviewPaneStateStorage';
import { navigationStore } from './navigation-store';
import {
  type PaneRelationsRefusal,
  type PaneRelationsValue,
  usePaneRelations,
} from './PaneRelationsContext';
import {
  type OpenInRegionOptions,
  type OpenInRegionOutcome,
  type RegionModelValue,
  useRegionModelOptional,
} from './RegionModelContext';
import {
  describeOpenInRegionRefusal,
  type OpenFilePreviewRequest,
  type OpenPaneRefusal,
  openFilePreviewInRegion,
  openInRegion,
  revealFilePreview,
} from './useOpenInRegion';

/**
 * Opening a file preview as a RELATED pane (docs/design/pane-relationships.md):
 * one reusable preview per exact opener selection, Keep and unsaved work
 * protect it, an exact kept target is focused rather than duplicated, and the
 * preview is fenced to the Station it was opened on (`pane-fence.ts`).
 *
 * The order is what makes every refusal leave everything as it was:
 *
 * 1. Plan from the current record, with no write.
 * 2. Ask the unsaved-changes guard of every pane the open would take off
 *    screen — the preview it replaces, the pane it covers. Cancel ends here.
 * 3. Take the record's exclusive lock and re-read it. The verified Station,
 *    the opener's selection and the plan must all still hold; otherwise the
 *    open is `superseded` / `station-changed`. At the bound it is refused.
 * 4. Fence and store the new occurrence, write the record, then commit the
 *    arrangement. A refusal at any step removes what the earlier steps wrote.
 *
 * Without a verified Station there is nothing to fence a new occurrence to,
 * and the open keeps the pre-relationship behaviour: an unfenced preview,
 * matched by path. That is a stated migration limit: an occurrence that was
 * ever fenced is never matched or read that way.
 */

export type RelatedOpenRefusal =
  | OpenPaneRefusal
  | PaneRelationsRefusal
  | 'guard-cancelled';

export type RelatedOpenDisposition = 'opened' | 'focused' | 'replaced';

export type RelatedOpenOutcome =
  | (Extract<OpenInRegionOutcome, { ok: true }> & {
      disposition?: RelatedOpenDisposition;
    })
  | { ok: false; reason: RelatedOpenRefusal };

type RelatedOpenModel = Pick<
  RegionModelValue,
  'regions' | 'phoneLayer' | 'openSurfaceInRegion' | 'replacePane'
>;

const RELATION_REFUSAL_SENTENCES: Record<
  PaneRelationsRefusal | 'guard-cancelled',
  string
> = {
  'station-unverified':
    'Station has not confirmed which Station this is yet. Try again in a moment.',
  'station-changed':
    'The Station changed while the preview was opening, so it was not opened.',
  'lock-unavailable':
    'This browser cannot coordinate previews between windows, so the preview was not opened.',
  contended:
    'Another Station window is updating previews. Try again in a moment.',
  'unsupported-record':
    'A newer Station build saved these previews, so this build will not change them.',
  capacity:
    'Too many related panes are open. Close some, then open this one again.',
  superseded:
    'What opened the preview changed before it could open. Try again.',
  storage: 'This device could not store the preview to open it.',
  refused: 'That pane cannot be placed in that region.',
  'guard-cancelled': 'Nothing changed.',
};

/** One sentence per refusal, for the caller that surfaces it. */
export function describeRelatedOpenRefusal(reason: RelatedOpenRefusal): string {
  return reason in RELATION_REFUSAL_SENTENCES
    ? RELATION_REFUSAL_SENTENCES[
        reason as PaneRelationsRefusal | 'guard-cancelled'
      ]
    : describeOpenInRegionRefusal(reason as OpenPaneRefusal);
}

/**
 * Whether a related occurrence still exists in durable, origin-wide storage:
 * its fence, and for a file preview its own state too. Other occurrence kinds
 * (a plugin pane) are owned elsewhere; their fence is what this path can see,
 * so it never prunes them for lacking a preview state.
 */
function relatedOccurrenceExists(instanceId: string): boolean {
  const storage = window.localStorage;
  if (readPaneFence(storage, instanceId).status === 'none') return false;
  return instanceId.startsWith('file-preview:')
    ? readFilePreviewPaneState(storage, instanceId) !== null
    : true;
}

/**
 * The pane on screen this open would take off screen, if any: the phone
 * layer's pane, else the selected pane of the region the new preview lands in
 * (the replaced preview's region, or Related).
 */
function paneHiddenBy(
  model: RelatedOpenModel,
  landingBeside: string | undefined,
): string | null {
  if (model.phoneLayer) return model.phoneLayer.surfaceId;
  const region = landingBeside
    ? occupiedRegion(model.regions, landingBeside)
    : 'right';
  if (!region || !isDockRegion(region)) return null;
  const state = model.regions[region];
  return state.visible ? state.occupant : null;
}

/**
 * Ask each guarded owner's own unsaved-changes guard, one after another.
 * False as soon as one answers Cancel; nothing else is asked then.
 */
async function guardsAllow(owners: readonly (string | null | undefined)[]) {
  for (const owner of new Set(owners)) {
    if (!owner || !navigationStore.hasNavigationGuard(owner)) continue;
    const allowed = await new Promise<boolean>((resolve) =>
      navigationStore.runNavigationGuards(
        () => resolve(true),
        () => resolve(false),
        { owner },
      ),
    );
    if (!allowed) return false;
  }
  return true;
}

export async function openRelatedFilePreview(
  getModel: () => RelatedOpenModel,
  relations: PaneRelationsValue,
  opener: PaneOpener,
  request: OpenFilePreviewRequest,
  options?: OpenInRegionOptions,
): Promise<RelatedOpenOutcome> {
  const { projectId, projectSlug, path, lineRange, thread } = request;
  if (projectId === null || projectSlug === null)
    return { ok: false, reason: 'unsupplied' };
  const station = relations.stationId;
  if (station === null)
    return openFilePreviewInRegion(getModel(), request, options);

  const target: PaneRelationTarget = {
    kind: 'file',
    projectId,
    projectSlug,
    path,
    thread: thread ?? null,
  };
  const before = getModel();
  const kept = relations.keptFor(target);
  const transient = relations.transientFor(opener);
  const focus =
    kept && relatedOccurrenceExists(kept.instanceId)
      ? kept
      : transient &&
          sameRelationTarget(station, transient.target, target) &&
          relatedOccurrenceExists(transient.instanceId)
        ? transient
        : undefined;
  if (focus) {
    const hidden = paneHiddenBy(before, focus.instanceId);
    if (!(await guardsAllow([hidden === focus.instanceId ? null : hidden])))
      return { ok: false, reason: 'guard-cancelled' };
    const outcome = revealFilePreview(
      getModel(),
      focus.instanceId,
      lineRange,
      options,
    );
    return outcome.ok ? { ...outcome, disposition: 'focused' } : outcome;
  }

  const replacing =
    transient && relatedOccurrenceExists(transient.instanceId)
      ? transient.instanceId
      : undefined;
  if (!(await guardsAllow([replacing, paneHiddenBy(before, replacing)])))
    return { ok: false, reason: 'guard-cancelled' };

  const state: WorkspaceFilePreviewPaneState = {
    version: '1.0',
    projectSlug,
    path,
    ...(lineRange ? { lineRange } : {}),
    wrap: true,
    ...(thread ? { thread } : {}),
  };
  const instance = createFilePreviewPaneInstance(state, projectId);
  if (!instance) return { ok: false, reason: 'no-surface' };
  const nextId = String(instance.instanceId);
  const storage = window.localStorage;
  const selection = openerSelectionKey(opener);
  let arrangementRefusal: OpenPaneRefusal | undefined;

  const result = await relations.transact<RelatedOpenOutcome>(
    (tx) => {
      // The open is for what the opener showed when it was clicked.
      const current = relations.currentSelection(opener.occurrenceId);
      if (current !== undefined && current !== selection)
        return { ok: false, reason: 'superseded' };
      const fresh = prunePaneRelations(tx.record, relatedOccurrenceExists);
      if (
        transientPaneForOpener(fresh, station, opener)?.instanceId !==
          replacing ||
        keptPaneForTarget(fresh, station, target) !== undefined
      )
        return { ok: false, reason: 'superseded' };
      const written = withPaneRelation(
        fresh,
        {
          instanceId: nextId,
          stateKey: String(instance.stateKey),
          stationId: station,
          generation: BUILTIN_PANE_GENERATION,
          opener,
          target,
          kept: false,
          openedAt: Date.now(),
        },
        replacing,
      );
      if (!written.ok) return written;
      if (!writePaneFence(storage, nextId, station))
        return { ok: false, reason: 'storage' };
      const preparation = createFilePreviewPaneStatePreparation(
        storage,
        String(instance.stateKey),
        state,
      );
      if (!preparation.prepare()) {
        removePaneFence(storage, nextId);
        return { ok: false, reason: 'storage' };
      }
      // Rollback removes the new state and, with it, the new fence.
      if (!tx.write(written.record)) {
        preparation.rollback();
        return { ok: false, reason: 'storage' };
      }
      const model = getModel();
      // In place: the new preview takes the replaced one's tab slot. A phone
      // layer replaces its own pane; a preview this tab does not place is
      // left to whichever tab places it, beside a new one.
      const inPlace =
        replacing !== undefined &&
        model.phoneLayer?.surfaceId !== replacing &&
        isDockRegion(occupiedRegion(model.regions, replacing) ?? 'main');
      const outcome: OpenInRegionOutcome = inPlace
        ? model.replacePane(replacing, nextId)
        : openInRegion(model, instance, { region: 'right', ...options });
      if (!outcome.ok) {
        preparation.rollback();
        arrangementRefusal = outcome.reason;
        return { ok: false, reason: 'refused' };
      }
      // The replaced preview left the arrangement with its relation; its
      // state and fence go too.
      if (inPlace && replacing !== undefined) forgetRegionPaneState(replacing);
      return {
        ok: true,
        value: {
          ...outcome,
          disposition: replacing === undefined ? 'opened' : 'replaced',
        },
      };
    },
    { station },
  );
  if (!result.ok)
    return { ok: false, reason: arrangementRefusal ?? result.reason };
  return result.value;
}

/**
 * `openRelatedFilePreview` bound to the mounted region model and relations,
 * for one opener; null where there is no region model. With no opener the
 * open is the unrelated one.
 */
export function useOpenRelatedFilePreview(
  opener: PaneOpener | null,
):
  | ((
      request: OpenFilePreviewRequest,
      options?: OpenInRegionOptions,
    ) => Promise<RelatedOpenOutcome>)
  | null {
  const model = useRegionModelOptional();
  const relations = usePaneRelations();
  const modelRef = useRef(model);
  useLayoutEffect(() => {
    modelRef.current = model;
  });
  const open = useCallback(
    async (request: OpenFilePreviewRequest, options?: OpenInRegionOptions) => {
      const current = modelRef.current as NonNullable<typeof model>;
      if (!opener) return openFilePreviewInRegion(current, request, options);
      return openRelatedFilePreview(
        () => modelRef.current as NonNullable<typeof model>,
        relations,
        opener,
        request,
        options,
      );
    },
    [opener, relations],
  );
  return model ? open : null;
}
