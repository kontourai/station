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
  type PaneRelation,
  type PaneRelationTarget,
  prunePaneRelations,
  sameRelationTarget,
  transientPaneForOpener,
  withPaneRelation,
} from '../regions/pane-relations';
import {
  isDockRegion,
  occupiedRegion,
  type RegionArrangement,
  type RegionId,
} from '../regions/region-model';
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
  type OpenSurfacePreview,
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
 *    the opener's selection, the plan (the occurrence to focus or replace)
 *    and the panes the open takes off screen must all still be the ones step
 *    2 asked about; otherwise the open is `superseded` / `station-changed`.
 *    What the open takes off screen is the region model's own plan for it
 *    (`previewOpenSurfaceInRegion`, `previewReplacePane`) against its
 *    committed arrangement — on a phone, the pane a first preview folds over
 *    in Chat's region — so a guard's own callback that moved a pane before
 *    answering is seen. A guard registered for one of those panes from step
 *    2 until now is unsaved work nobody was asked about: `superseded` too.
 *    At the bound it is refused.
 * 4. Focus the occurrence the plan named, or fence and store a new one, write
 *    the record, then commit the arrangement. A refusal at any step removes
 *    what the earlier steps wrote.
 *
 * Without a verified Station there is nothing to fence a new occurrence to,
 * so a related open is refused (`station-unverified`) before anything is
 * written. Previews made before relationships keep their unfenced reads; no
 * new unfenced one is minted.
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
  | 'readRegions'
  | 'readPhoneLayer'
  | 'openSurfaceInRegion'
  | 'previewOpenSurfaceInRegion'
  | 'replacePane'
  | 'previewReplacePane'
>;

const RELATION_REFUSAL_SENTENCES: Record<
  PaneRelationsRefusal | 'guard-cancelled',
  string
> = {
  'station-unverified':
    'Station cannot confirm which Station it is connected to, so the preview was not opened. It opens once Station confirms it.',
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
 * The occurrence an open of `target` focuses rather than mints: the kept
 * preview of that exact target, else the opener's transient preview when it
 * already shows that exact target — either only while it still exists.
 */
function occurrenceToFocus(
  kept: PaneRelation | undefined,
  transient: PaneRelation | undefined,
  station: string,
  target: PaneRelationTarget,
): PaneRelation | undefined {
  if (kept && relatedOccurrenceExists(kept.instanceId)) return kept;
  if (
    transient &&
    sameRelationTarget(station, transient.target, target) &&
    relatedOccurrenceExists(transient.instanceId)
  )
    return transient;
  return undefined;
}

/** The panes an arrangement shows: every visible region's selected pane. */
function panesOnScreen(arrangement: RegionArrangement): Set<string> {
  const shown = new Set<string>();
  for (const id of Object.keys(arrangement) as RegionId[]) {
    const state = arrangement[id];
    if (state.visible && state.occupant !== null) shown.add(state.occupant);
  }
  return shown;
}

/**
 * The panes on screen now that the model's own plan for a request takes off
 * screen — other than `subject`, the preview being opened or revealed —
 * sorted; or the plan's refusal. Read from the plan rather than from the
 * region the request asked for: on a phone the fold puts a first preview
 * over Chat, in whichever region Chat holds, not in Related.
 */
function hiddenByPlan(
  model: RelatedOpenModel,
  preview: OpenSurfacePreview,
  subject: string,
): { ok: true; hidden: string[] } | { ok: false; reason: OpenPaneRefusal } {
  if (!preview.ok) return { ok: false, reason: preview.reason };
  const after = panesOnScreen(preview.arrangement);
  const hidden = [...panesOnScreen(model.readRegions())]
    .filter((id) => id !== subject && !after.has(id))
    .sort();
  return { ok: true, hidden };
}

function samePanes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** What revealing an existing preview takes off screen (`revealFilePreview`). */
function hiddenByReveal(
  model: RelatedOpenModel,
  instanceId: string,
  options?: OpenInRegionOptions,
) {
  return hiddenByPlan(
    model,
    model.previewOpenSurfaceInRegion(instanceId, {
      ...options,
      focusExisting: true,
    }),
    instanceId,
  );
}

/**
 * The owners a guard was registered for from now until `stop`, through
 * navigation's own registration notice: what an open asked about must not
 * have gained unsaved work it was not asked about by the time it commits.
 */
function watchGuardRegistrations(): {
  readonly registered: ReadonlySet<string>;
  stop(): void;
} {
  const registered = new Set<string>();
  const stop = navigationStore.subscribeNavigationGuardOwners((owner) =>
    registered.add(owner),
  );
  return { registered, stop };
}

/** None of `owners` gained a guard while `watch` was held. */
function noneRegistered(
  watch: { readonly registered: ReadonlySet<string> },
  owners: readonly (string | null | undefined)[],
): boolean {
  return owners.every((owner) => !owner || !watch.registered.has(owner));
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
  const { projectId, projectSlug } = request;
  if (projectId === null || projectSlug === null)
    return { ok: false, reason: 'unsupplied' };
  const station = relations.stationId;
  if (station === null) return { ok: false, reason: 'station-unverified' };
  const watch = watchGuardRegistrations();
  try {
    return await openWatched(
      getModel,
      relations,
      opener,
      request,
      projectId,
      projectSlug,
      station,
      watch,
      options,
    );
  } finally {
    watch.stop();
  }
}

async function openWatched(
  getModel: () => RelatedOpenModel,
  relations: PaneRelationsValue,
  opener: PaneOpener,
  request: OpenFilePreviewRequest,
  projectId: string,
  projectSlug: string,
  station: string,
  watch: { readonly registered: ReadonlySet<string> },
  options: OpenInRegionOptions | undefined,
): Promise<RelatedOpenOutcome> {
  const { path, lineRange, thread } = request;
  const target: PaneRelationTarget = {
    kind: 'file',
    projectId,
    projectSlug,
    path,
    thread: thread ?? null,
  };
  const selection = openerSelectionKey(opener);
  const before = getModel();
  const focus = occurrenceToFocus(
    relations.keptFor(target),
    relations.transientFor(opener),
    station,
    target,
  );
  if (focus) {
    const focusId = focus.instanceId;
    const planned = hiddenByReveal(before, focusId, options);
    if (!planned.ok) return { ok: false, reason: planned.reason };
    const hidden = planned.hidden;
    if (!(await guardsAllow(hidden)))
      return { ok: false, reason: 'guard-cancelled' };
    let arrangementRefusal: OpenPaneRefusal | undefined;
    // Focusing writes too — the arrangement, and a new line range onto the
    // preview's state — so it commits under the same lock, after the same
    // checks, as a new preview: the guard above was answered for THIS
    // Station, source, target and covered pane.
    const result = await relations.transact<RelatedOpenOutcome>(
      (tx) => {
        const current = relations.currentSelection(opener.occurrenceId);
        if (current !== undefined && current !== selection)
          return { ok: false, reason: 'superseded' };
        const fresh = prunePaneRelations(tx.record, relatedOccurrenceExists);
        const model = getModel();
        const now = hiddenByReveal(model, focusId, options);
        if (
          occurrenceToFocus(
            keptPaneForTarget(fresh, station, target),
            transientPaneForOpener(fresh, station, opener),
            station,
            target,
          )?.instanceId !== focusId ||
          !now.ok ||
          !samePanes(now.hidden, hidden) ||
          !noneRegistered(watch, hidden)
        )
          return { ok: false, reason: 'superseded' };
        const outcome = revealFilePreview(model, focusId, lineRange, options);
        if (!outcome.ok) {
          arrangementRefusal = outcome.reason;
          return { ok: false, reason: 'refused' };
        }
        return { ok: true, value: { ...outcome, disposition: 'focused' } };
      },
      { station },
    );
    if (!result.ok)
      return { ok: false, reason: arrangementRefusal ?? result.reason };
    return result.value;
  }

  const transient = relations.transientFor(opener);
  const replacing =
    transient && relatedOccurrenceExists(transient.instanceId)
      ? transient.instanceId
      : undefined;
  const state: WorkspaceFilePreviewPaneState = {
    version: '1.0',
    projectSlug,
    path,
    ...(lineRange ? { lineRange } : {}),
    wrap: true,
    ...(thread ? { thread } : {}),
  };
  // Minting writes nothing; the id is what the plan places.
  const instance = createFilePreviewPaneInstance(state, projectId);
  if (!instance) return { ok: false, reason: 'no-surface' };
  const nextId = String(instance.instanceId);
  const storage = window.localStorage;
  let arrangementRefusal: OpenPaneRefusal | undefined;
  // In place: the new preview takes the replaced one's tab slot. A phone
  // layer replaces its own pane; a preview this tab does not place is left
  // to whichever tab places it, beside a new one.
  const placementPlan = (model: RelatedOpenModel) => {
    const inPlace =
      replacing !== undefined &&
      model.readPhoneLayer()?.surfaceId !== replacing &&
      isDockRegion(occupiedRegion(model.readRegions(), replacing) ?? 'main');
    return {
      inPlace,
      planned: hiddenByPlan(
        model,
        inPlace && replacing !== undefined
          ? model.previewReplacePane(replacing, nextId)
          : model.previewOpenSurfaceInRegion(nextId, {
              region: 'right',
              ...options,
            }),
        nextId,
      ),
    };
  };
  const plan = placementPlan(before);
  if (!plan.planned.ok) return { ok: false, reason: plan.planned.reason };
  const asked = [
    ...new Set([...(replacing ? [replacing] : []), ...plan.planned.hidden]),
  ];
  if (!(await guardsAllow(asked)))
    return { ok: false, reason: 'guard-cancelled' };
  const samePlan = (now: ReturnType<typeof placementPlan>) =>
    now.inPlace === plan.inPlace &&
    now.planned.ok &&
    plan.planned.ok &&
    samePanes(now.planned.hidden, plan.planned.hidden);

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
        keptPaneForTarget(fresh, station, target) !== undefined ||
        !samePlan(placementPlan(getModel())) ||
        !noneRegistered(watch, asked)
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
      const inPlace = plan.inPlace && replacing !== undefined;
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
