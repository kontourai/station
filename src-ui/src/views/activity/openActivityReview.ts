import type { ActivityReviewSource } from '../../contexts/ActivityReviewContext';
import {
  openRelatedOccurrence,
  type RelatedOpenModel,
} from '../../contexts/openRelatedOccurrence';
import type { PaneRelationsValue } from '../../contexts/PaneRelationsContext';
import {
  BUILTIN_PANE_GENERATION,
  openerSelectionKey,
  sameRelationTarget,
} from '../../regions/pane-relations';
import { sessionTitle } from '../../utils/sessionDisplay';
import {
  activityReviewTarget,
  prepareActivityReviewPane,
  readActivityReviewPane,
} from '../../workspace-panes/activityReviewPane';

export function openActivityReview(
  getModel: () => RelatedOpenModel,
  relations: PaneRelationsValue,
  readSource: () => ActivityReviewSource | null,
  threadId: string,
) {
  const source = readSource();
  const session = source?.items.find((item) => item.threadId === threadId);
  if (!source || !session)
    return Promise.resolve({
      ok: false as const,
      reason: 'superseded' as const,
    });
  const state = {
    version: 1 as const,
    threadId,
    projectSlug: session.projectSlug ?? null,
    title: sessionTitle(session).slice(0, 160),
  };
  const target = activityReviewTarget(state);
  return openRelatedOccurrence(getModel, relations, source.opener, {
    generation: BUILTIN_PANE_GENERATION,
    landing: 'right',
    target,
    admit: () => {
      const current = readSource();
      const item = current?.items.find((entry) => entry.threadId === threadId);
      return current?.owner === source.owner &&
        current.apiBase === source.apiBase &&
        current.stationId === source.stationId &&
        openerSelectionKey(current.opener) ===
          openerSelectionKey(source.opener) &&
        item !== undefined &&
        (item.projectSlug ?? null) === state.projectSlug
        ? null
        : 'superseded';
    },
    confirms: (id) => {
      const stored = readActivityReviewPane(window.localStorage, id);
      return (
        stored !== null &&
        sameRelationTarget(
          source.stationId ?? '',
          target,
          activityReviewTarget(stored),
        )
      );
    },
    reveal: (model, id, options) =>
      model.openSurfaceInRegion(id, {
        ...options,
        focusExisting: true,
      }),
    mint: () => prepareActivityReviewPane(state),
  });
}
