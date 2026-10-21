import {
  createWorkspaceActivityReviewPaneInstance,
  WORKSPACE_ACTIVITY_REVIEW_PANE_DESCRIPTOR_ID,
  WORKSPACE_ACTIVITY_REVIEW_PANE_INSTANCE_PATTERN,
} from '@kontourai/station-contracts/workspace-activity-review-pane';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { removeFencedRecord, removePaneFence } from '../regions/pane-fence';
import type { PaneRelationTarget } from '../regions/pane-relations';

export const ACTIVITY_REVIEW_PANE_ID =
  WORKSPACE_ACTIVITY_REVIEW_PANE_INSTANCE_PATTERN;
export const ACTIVITY_REVIEW_DESCRIPTOR_ID =
  WORKSPACE_ACTIVITY_REVIEW_PANE_DESCRIPTOR_ID;
const STATE_PREFIX = 'station:activity-review:v1:';

export interface ActivityReviewPaneState {
  version: 1;
  threadId: string;
  projectSlug: string | null;
  title: string;
}

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function parseState(value: unknown): ActivityReviewPaneState | null {
  if (typeof value !== 'object' || value === null) return null;
  const state = value as Record<string, unknown>;
  return state.version === 1 &&
    text(state.threadId, 1024) &&
    (state.projectSlug === null || text(state.projectSlug, 256)) &&
    text(state.title, 160)
    ? {
        version: 1,
        threadId: state.threadId,
        projectSlug: state.projectSlug,
        title: state.title,
      }
    : null;
}

type PaneStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function readActivityReviewPane(storage: PaneStorage, id: string) {
  if (!ACTIVITY_REVIEW_PANE_ID.test(id)) return null;
  try {
    const raw = storage.getItem(`${STATE_PREFIX}${id}`);
    return raw && raw.length <= 4096 ? parseState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function activityReviewTarget(
  state: Pick<ActivityReviewPaneState, 'threadId' | 'projectSlug'>,
): Extract<PaneRelationTarget, { kind: 'activity-session' }> {
  return {
    kind: 'activity-session',
    threadId: state.threadId,
    projectSlug: state.projectSlug,
  };
}

export function activityReviewInstance(id: string) {
  return createWorkspaceActivityReviewPaneInstance(id);
}

export function prepareActivityReviewPane(state: ActivityReviewPaneState) {
  const id = `activity-review:${randomCorrelationId().replaceAll('-', '')}`;
  const storage = window.localStorage;
  const key = `${STATE_PREFIX}${id}`;
  let written = false;
  return {
    instanceId: id,
    stateKey: id,
    prepare() {
      if (!parseState(state)) return false;
      const raw = JSON.stringify(state);
      if (raw.length > 4096) return false;
      try {
        let count = 0;
        for (let index = 0; index < storage.length; index += 1)
          if (storage.key(index)?.startsWith(STATE_PREFIX)) count += 1;
        if (count >= 48 || storage.getItem(key) !== null) return false;
        storage.setItem(key, raw);
        written = true;
        return true;
      } catch {
        return false;
      }
    },
    rollback() {
      if (written) removeActivityReviewPane(storage, id);
      else if (storage.getItem(key) === null) removePaneFence(storage, id);
    },
  };
}

export function removeActivityReviewPane(storage: PaneStorage, id: string) {
  if (!ACTIVITY_REVIEW_PANE_ID.test(id)) return false;
  return removeFencedRecord(storage, id, `${STATE_PREFIX}${id}`);
}
