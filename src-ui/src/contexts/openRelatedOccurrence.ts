import { readPaneFence, writePaneFence } from '../regions/pane-fence';
import {
  keptPaneForTarget,
  openerSelectionKey,
  type PaneOpener,
  type PaneRelation,
  type PaneRelationTarget,
  paneRelationOf,
  prunePaneRelations,
  sameRelationTarget,
  transientPaneForOpener,
  withPaneRelation,
} from '../regions/pane-relations';
import {
  type DockRegionId,
  isDockRegion,
  occupiedRegion,
  type RegionArrangement,
  type RegionId,
} from '../regions/region-model';
import { forgetRegionPaneState } from '../regions/region-surface-panes';
import { readActivityReviewPane } from '../workspace-panes/activityReviewPane';
import { readFilePreviewPaneState } from '../workspace-panes/filePreviewPaneStateStorage';
import { readPluginPaneState } from '../workspace-panes/pluginPaneOccurrence';
import { navigationStore } from './navigation-store';
import type {
  PaneRelationsRefusal,
  PaneRelationsValue,
} from './PaneRelationsContext';
import type {
  OpenInRegionOptions,
  OpenInRegionOutcome,
  OpenSurfacePreview,
  RegionModelValue,
} from './RegionModelContext';
import type { OpenPaneRefusal } from './useOpenInRegion';

/**
 * Opening a RELATED pane occurrence (docs/design/pane-relationships.md), for
 * every kind of pane that opens as one: one reusable preview per exact opener
 * selection, Keep and unsaved work protect it, an exact kept target is
 * focused rather than duplicated, and every new occurrence is fenced to the
 * Station it was opened on (`pane-fence.ts`). The kind of pane supplies only
 * its target, its state and its reveal (`RelatedOccurrenceAdapter`).
 *
 * The order is what makes every refusal leave everything as it was:
 *
 * 1. Plan from the current record, with no write.
 * 2. Ask the unsaved-changes guard of every pane the open would take off
 *    screen — the preview it replaces, the pane it covers. Cancel ends here.
 * 3. Take the record's exclusive lock and re-read it. The verified Station,
 *    the opener's selection, the plan (the occurrence to focus or replace),
 *    the pane the open takes off screen and the adapter's own admission must
 *    all still be what step 2 asked about; otherwise the open is
 *    `superseded` / `station-changed` / the adapter's refusal. What the open
 *    takes off screen is read from the model's committed arrangement and
 *    phone layer, which a guard's own callback may have changed before it
 *    answered. A guard registered for one of those panes from step 2 until
 *    now is unsaved work nobody was asked about: the open is `superseded`.
 *    At the bound it is refused.
 * 4. Focus the occurrence the plan named, or fence and store a new one, write
 *    the record, then commit the arrangement. A refusal at any step removes
 *    what the earlier steps wrote.
 *
 * Without a verified Station there is nothing to fence a new occurrence to,
 * so a related open is refused (`station-unverified`) before anything is
 * written.
 */

export type RelatedOpenRefusal =
  | OpenPaneRefusal
  | PaneRelationsRefusal
  | 'guard-cancelled';

export type RelatedOpenDisposition = 'opened' | 'focused' | 'replaced';

export type RelatedOpenOutcome<AdapterRefusal extends string = never> =
  | (Extract<OpenInRegionOutcome, { ok: true }> & {
      disposition?: RelatedOpenDisposition;
    })
  | { ok: false; reason: RelatedOpenRefusal | AdapterRefusal };

export type RelatedOpenModel = Pick<
  RegionModelValue,
  | 'readRegions'
  | 'readPhoneLayer'
  | 'openSurfaceInRegion'
  | 'previewOpenSurfaceInRegion'
  | 'replacePane'
  | 'previewReplacePane'
>;

/** A new occurrence's identity and state, staged but not yet written. */
export interface MintedRelatedOccurrence {
  readonly instanceId: string;
  readonly stateKey: string;
  /** Write the occurrence's state. False (nothing written) refuses the open. */
  prepare(): boolean;
  /** Remove what `prepare` wrote, and with it the occurrence's fence. */
  rollback(): void;
}

/** What one kind of related pane supplies to `openRelatedOccurrence`. */
export interface RelatedOccurrenceAdapter<AdapterRefusal extends string> {
  /** The exact target, which dedupe and Keep compare. */
  readonly target: PaneRelationTarget;
  /** The opener's installation generation, recorded with a new relation. */
  readonly generation: string;
  /** Where a new occurrence lands when it replaces no preview in place. */
  readonly landing: DockRegionId;
  /**
   * The adapter's own admission, asked when the open is planned and again
   * inside the lock after any guard answered. Null admits.
   */
  admit?(): AdapterRefusal | null;
  /**
   * Whether an existing occurrence's OWN stored state is this exact target,
   * asked before it is focused. A relation names an occurrence; it never
   * vouches for what the occurrence is bound to.
   */
  confirms?(instanceId: string): boolean;
  attestFocusedOpener?(relation: PaneRelation): PaneOpener | undefined;
  /**
   * Reveal an existing occurrence, carrying anything this request adds. It
   * opens the occurrence with `{ ...options, focusExisting: true }`, which is
   * the open the pipeline previews to know what the reveal takes off screen.
   */
  reveal(
    model: RelatedOpenModel,
    instanceId: string,
    options?: OpenInRegionOptions,
  ): OpenInRegionOutcome;
  /** A new occurrence's ids and staged state, or null when none can be minted. */
  mint(): MintedRelatedOccurrence | null;
}

/**
 * Whether a related occurrence still exists in durable, origin-wide storage:
 * its fence, and its own state for the kinds that store one. Never by whether
 * this tab places it: another tab may be showing it.
 */
export function relatedOccurrenceExists(instanceId: string): boolean {
  const storage = window.localStorage;
  if (readPaneFence(storage, instanceId).status === 'none') return false;
  if (instanceId.startsWith('file-preview:'))
    return readFilePreviewPaneState(storage, instanceId) !== null;
  if (instanceId.startsWith('plugin-pane:'))
    return readPluginPaneState(storage, instanceId) !== null;
  if (instanceId.startsWith('activity-review:'))
    return readActivityReviewPane(storage, instanceId) !== null;
  return true;
}

/**
 * The occurrence an open of `target` focuses rather than mints: the kept
 * occurrence of that exact target, else the opener's transient preview when
 * it already shows that exact target — either only while it still exists.
 */
function occurrenceToFocus(
  kept: PaneRelation | undefined,
  transient: PaneRelation | undefined,
  station: string,
  target: PaneRelationTarget,
  confirms: (instanceId: string) => boolean,
): PaneRelation | undefined {
  const usable = (relation: PaneRelation) =>
    relatedOccurrenceExists(relation.instanceId) &&
    confirms(relation.instanceId);
  if (kept && usable(kept)) return kept;
  if (
    transient &&
    sameRelationTarget(station, transient.target, target) &&
    usable(transient)
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
 * screen — other than `subject`, the occurrence being opened or revealed —
 * sorted; or the plan's refusal. Read from the plan rather than from the
 * landing the request asked for: on a phone the fold puts a first related
 * pane over Chat, in whichever region Chat holds, not in the side region
 * requested.
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

function samePlan(
  a: { inPlace: boolean; planned: ReturnType<typeof hiddenByPlan> },
  b: { inPlace: boolean; planned: ReturnType<typeof hiddenByPlan> },
): boolean {
  return (
    a.inPlace === b.inPlace &&
    a.planned.ok &&
    b.planned.ok &&
    samePanes(a.planned.hidden, b.planned.hidden)
  );
}

/** What revealing an existing occurrence takes off screen (see `reveal`). */
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
export function watchGuardRegistrations(): {
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
export async function guardsAllow(
  owners: readonly (string | null | undefined)[],
  skipGuard?: { identity: symbol; owner: string },
): Promise<boolean> {
  for (const owner of new Set(owners)) {
    if (!owner || !navigationStore.hasNavigationGuard(owner)) continue;
    const allowed = await new Promise<boolean>((resolve) =>
      navigationStore.runNavigationGuards(
        () => resolve(true),
        () => resolve(false),
        { owner, skipGuard },
      ),
    );
    if (!allowed) return false;
  }
  return true;
}

export async function openRelatedOccurrence<AdapterRefusal extends string>(
  getModel: () => RelatedOpenModel,
  relations: PaneRelationsValue,
  opener: PaneOpener,
  adapter: RelatedOccurrenceAdapter<AdapterRefusal>,
  options?: OpenInRegionOptions,
): Promise<RelatedOpenOutcome<AdapterRefusal>> {
  const station = relations.stationId;
  if (station === null) return { ok: false, reason: 'station-unverified' };
  const refusedFirst = adapter.admit?.() ?? null;
  if (refusedFirst !== null) return { ok: false, reason: refusedFirst };
  const watch = watchGuardRegistrations();
  try {
    return await openWatched(
      getModel,
      relations,
      opener,
      adapter,
      station,
      watch,
      options,
    );
  } finally {
    watch.stop();
  }
}

async function openWatched<AdapterRefusal extends string>(
  getModel: () => RelatedOpenModel,
  relations: PaneRelationsValue,
  opener: PaneOpener,
  adapter: RelatedOccurrenceAdapter<AdapterRefusal>,
  station: string,
  watch: { readonly registered: ReadonlySet<string> },
  options: OpenInRegionOptions | undefined,
): Promise<RelatedOpenOutcome<AdapterRefusal>> {
  const { target, landing } = adapter;
  const confirms = adapter.confirms ?? (() => true);
  const selection = openerSelectionKey(opener);
  // A refusal the transaction cannot name in its own vocabulary: the
  // arrangement's, or the adapter's. The transaction refuses `refused` so
  // its writes roll back, and the open reports this instead.
  let stepRefusal: RelatedOpenRefusal | AdapterRefusal | undefined;
  const readmitted = (): boolean => {
    const refused = adapter.admit?.() ?? null;
    if (refused === null) return true;
    stepRefusal = refused;
    return false;
  };
  const before = getModel();
  const focus = occurrenceToFocus(
    relations.keptFor(target),
    relations.transientFor(opener),
    station,
    target,
    confirms,
  );
  if (focus) {
    const focusId = focus.instanceId;
    const planned = hiddenByReveal(before, focusId, options);
    if (!planned.ok) return { ok: false, reason: planned.reason };
    const hidden = planned.hidden;
    if (!(await guardsAllow(hidden)))
      return { ok: false, reason: 'guard-cancelled' };
    // Focusing writes too — the arrangement, and anything the reveal carries
    // onto the occurrence's state — so it commits under the same lock, after
    // the same checks, as a new occurrence: the guard above was answered for
    // THIS Station, source, target and covered pane.
    const result = await relations.transact<RelatedOpenOutcome<AdapterRefusal>>(
      (tx) => {
        const current = relations.currentSelection(opener.occurrenceId);
        if (current !== undefined && current !== selection)
          return { ok: false, reason: 'superseded' };
        if (!readmitted()) return { ok: false, reason: 'refused' };
        const fresh = prunePaneRelations(tx.record, relatedOccurrenceExists);
        const held = paneRelationOf(fresh, focusId);
        const model = getModel();
        const now = hiddenByReveal(model, focusId, options);
        if (
          !held ||
          JSON.stringify(held) !== JSON.stringify(focus) ||
          occurrenceToFocus(
            keptPaneForTarget(fresh, station, target),
            transientPaneForOpener(fresh, station, opener),
            station,
            target,
            confirms,
          )?.instanceId !== focusId ||
          !now.ok ||
          !samePanes(now.hidden, hidden) ||
          !noneRegistered(watch, hidden)
        )
          return { ok: false, reason: 'superseded' };
        const attestedOpener = adapter.attestFocusedOpener?.(held);
        if (
          attestedOpener &&
          !tx.write({
            ...fresh,
            entries: fresh.entries.map((entry) =>
              entry.instanceId === focusId
                ? { ...entry, opener: attestedOpener }
                : entry,
            ),
          })
        )
          return { ok: false, reason: 'storage' };
        const outcome = adapter.reveal(model, focusId, options);
        if (!outcome.ok) {
          stepRefusal = outcome.reason;
          return { ok: false, reason: 'refused' };
        }
        return { ok: true, value: { ...outcome, disposition: 'focused' } };
      },
      { station },
    );
    if (!result.ok) return { ok: false, reason: stepRefusal ?? result.reason };
    return result.value;
  }

  const transient = relations.transientFor(opener);
  const replacing =
    transient && relatedOccurrenceExists(transient.instanceId)
      ? transient.instanceId
      : undefined;
  // Minting writes nothing until `prepare`; the id is what the plan places.
  const minted = adapter.mint();
  if (!minted) return { ok: false, reason: 'no-surface' };
  const nextId = minted.instanceId;
  const storage = window.localStorage;
  // In place: the new occurrence takes the replaced one's tab slot. A phone
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
              region: landing,
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

  const result = await relations.transact<RelatedOpenOutcome<AdapterRefusal>>(
    (tx) => {
      // The open is for what the opener showed when it was clicked.
      const current = relations.currentSelection(opener.occurrenceId);
      if (current !== undefined && current !== selection)
        return { ok: false, reason: 'superseded' };
      if (!readmitted()) return { ok: false, reason: 'refused' };
      const fresh = prunePaneRelations(tx.record, relatedOccurrenceExists);
      const transientNow = transientPaneForOpener(fresh, station, opener);
      if (
        transientNow?.instanceId !== replacing ||
        occurrenceToFocus(
          keptPaneForTarget(fresh, station, target),
          transientNow,
          station,
          target,
          confirms,
        ) !== undefined ||
        !samePlan(placementPlan(getModel()), plan) ||
        !noneRegistered(watch, asked)
      )
        return { ok: false, reason: 'superseded' };
      const written = withPaneRelation(
        fresh,
        {
          instanceId: nextId,
          stateKey: minted.stateKey,
          stationId: station,
          generation: adapter.generation,
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
      if (!minted.prepare()) {
        // Its own rollback: the fence goes only with no state under it.
        minted.rollback();
        return { ok: false, reason: 'storage' };
      }
      // Rollback removes the new state and, with it, the new fence.
      if (!tx.write(written.record)) {
        minted.rollback();
        return { ok: false, reason: 'storage' };
      }
      const model = getModel();
      const inPlace = plan.inPlace && replacing !== undefined;
      const outcome: OpenInRegionOutcome = inPlace
        ? model.replacePane(replacing, nextId)
        : model.openSurfaceInRegion(nextId, { region: landing, ...options });
      if (!outcome.ok) {
        minted.rollback();
        stepRefusal = outcome.reason;
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
  if (!result.ok) return { ok: false, reason: stepRefusal ?? result.reason };
  return result.value;
}

/**
 * Reveal one EXISTING related occurrence, the handle-addressed half of the
 * pipeline above: the covered pane's guard is asked first, then — inside the
 * lock, over a fresh read — the occurrence must still be the related one
 * `admitRelation` accepts, still exist, the covered pane must be the one the
 * guard was asked about, and the adapter's admission must still hold.
 */
export async function revealRelatedOccurrence<AdapterRefusal extends string>(
  getModel: () => RelatedOpenModel,
  relations: PaneRelationsValue,
  instanceId: string,
  adapter: {
    readonly landing: DockRegionId;
    admitRelation(relation: PaneRelation | undefined): boolean;
    admit?(): AdapterRefusal | null;
    reveal(model: RelatedOpenModel, instanceId: string): OpenInRegionOutcome;
  },
): Promise<RelatedOpenOutcome<AdapterRefusal | 'unknown-handle'>> {
  const station = relations.stationId;
  if (station === null) return { ok: false, reason: 'station-unverified' };
  if (
    !adapter.admitRelation(relations.relationOf(instanceId)) ||
    !relatedOccurrenceExists(instanceId)
  )
    return { ok: false, reason: 'unknown-handle' };
  const refusedFirst = adapter.admit?.() ?? null;
  if (refusedFirst !== null) return { ok: false, reason: refusedFirst };
  const watch = watchGuardRegistrations();
  try {
    return await revealWatched(
      getModel,
      relations,
      instanceId,
      adapter,
      station,
      watch,
    );
  } finally {
    watch.stop();
  }
}

async function revealWatched<AdapterRefusal extends string>(
  getModel: () => RelatedOpenModel,
  relations: PaneRelationsValue,
  instanceId: string,
  adapter: {
    readonly landing: DockRegionId;
    admitRelation(relation: PaneRelation | undefined): boolean;
    admit?(): AdapterRefusal | null;
    reveal(model: RelatedOpenModel, instanceId: string): OpenInRegionOutcome;
  },
  station: string,
  watch: { readonly registered: ReadonlySet<string> },
): Promise<RelatedOpenOutcome<AdapterRefusal | 'unknown-handle'>> {
  const planned = hiddenByReveal(getModel(), instanceId);
  if (!planned.ok) return { ok: false, reason: planned.reason };
  const hidden = planned.hidden;
  if (!(await guardsAllow(hidden)))
    return { ok: false, reason: 'guard-cancelled' };
  let stepRefusal:
    | RelatedOpenRefusal
    | AdapterRefusal
    | 'unknown-handle'
    | undefined;
  const result = await relations.transact<
    RelatedOpenOutcome<AdapterRefusal | 'unknown-handle'>
  >(
    (tx) => {
      const fresh = prunePaneRelations(tx.record, relatedOccurrenceExists);
      if (!adapter.admitRelation(paneRelationOf(fresh, instanceId))) {
        stepRefusal = 'unknown-handle';
        return { ok: false, reason: 'refused' };
      }
      const refused = adapter.admit?.() ?? null;
      if (refused !== null) {
        stepRefusal = refused;
        return { ok: false, reason: 'refused' };
      }
      const model = getModel();
      const now = hiddenByReveal(model, instanceId);
      if (
        !now.ok ||
        !samePanes(now.hidden, hidden) ||
        !noneRegistered(watch, hidden)
      )
        return { ok: false, reason: 'superseded' };
      const outcome = adapter.reveal(model, instanceId);
      if (!outcome.ok) {
        stepRefusal = outcome.reason;
        return { ok: false, reason: 'refused' };
      }
      return { ok: true, value: { ...outcome, disposition: 'focused' } };
    },
    { station },
  );
  if (!result.ok) return { ok: false, reason: stepRefusal ?? result.reason };
  return result.value;
}
