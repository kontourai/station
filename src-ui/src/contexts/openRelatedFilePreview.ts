import type { WorkspaceFilePreviewPaneState } from '@kontourai/station-contracts/workspace-file-preview';
import { useCallback, useLayoutEffect, useRef } from 'react';
import {
  BUILTIN_PANE_GENERATION,
  type PaneOpener,
} from '../regions/pane-relations';
import { createFilePreviewPaneInstance } from '../workspace-panes/filePreviewPaneInstance';
import { createFilePreviewPaneStatePreparation } from '../workspace-panes/filePreviewPaneStateStorage';
import {
  openRelatedOccurrence,
  type RelatedOpenModel,
  type RelatedOpenOutcome,
  type RelatedOpenRefusal,
} from './openRelatedOccurrence';
import type {
  PaneRelationsRefusal,
  PaneRelationsValue,
} from './PaneRelationsContext';
import { usePaneRelations } from './PaneRelationsContext';
import {
  type OpenInRegionOptions,
  useRegionModelOptional,
} from './RegionModelContext';
import {
  describeOpenInRegionRefusal,
  type OpenFilePreviewRequest,
  type OpenPaneRefusal,
  openFilePreviewInRegion,
  revealFilePreview,
} from './useOpenInRegion';

export type {
  RelatedOpenDisposition,
  RelatedOpenOutcome,
  RelatedOpenRefusal,
} from './openRelatedOccurrence';

/**
 * A file preview opened as a RELATED pane (docs/design/pane-relationships.md)
 * through the shared related-occurrence pipeline (`openRelatedOccurrence`):
 * its target is the exact file — Project, path and the session it is read
 * through — focusing a kept or current preview carries a newly requested line
 * range onto it, and a new preview's state is the bounded file-preview record.
 * Previews made before relationships keep their unfenced reads; no new
 * unfenced one is minted.
 */

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
  const state: WorkspaceFilePreviewPaneState = {
    version: '1.0',
    projectSlug,
    path,
    ...(lineRange ? { lineRange } : {}),
    wrap: true,
    ...(thread ? { thread } : {}),
  };
  return openRelatedOccurrence(getModel, relations, opener, {
    target: {
      kind: 'file',
      projectId,
      projectSlug,
      path,
      thread: thread ?? null,
    },
    generation: BUILTIN_PANE_GENERATION,
    landing: 'right',
    reveal: (model, instanceId, revealOptions) =>
      revealFilePreview(model, instanceId, lineRange, revealOptions),
    mint: () => {
      const instance = createFilePreviewPaneInstance(state, projectId);
      if (!instance) return null;
      const stateKey = String(instance.stateKey);
      const preparation = createFilePreviewPaneStatePreparation(
        window.localStorage,
        stateKey,
        state,
      );
      return {
        instanceId: String(instance.instanceId),
        stateKey,
        prepare: () => preparation.prepare(),
        rollback: () => preparation.rollback(),
      };
    },
  }, options);
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
