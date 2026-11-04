import type { ApprovalMode } from './provider.js';

/**
 * How a Project preselects a NEW chat's model, and how it sets a new chat's
 * approval mode.
 *
 * - `fixed`: the value the Project stores (`defaultProviderId`/`defaultModel`
 *   for the model, `defaultApprovalMode` for approvals). An absent choice is
 *   `fixed`, so a Project saved before this setting existed keeps its
 *   behavior.
 * - `last-used`: what the caller's most recent chat in this Project STARTED
 *   with, as the server recorded it when that start succeeded
 *   (`src-server/services/projects/project-chat-defaults.ts`). With nothing
 *   recorded yet, or a value that cannot be applied, the `fixed` value applies
 *   and the view says why ({@link ProjectChatApprovalDefault.fallback}).
 */
export const PROJECT_CHAT_DEFAULT_SELECTIONS = ['fixed', 'last-used'] as const;

export type ProjectChatDefaultSelection =
  (typeof PROJECT_CHAT_DEFAULT_SELECTIONS)[number];

export function isProjectChatDefaultSelection(
  value: unknown,
): value is ProjectChatDefaultSelection {
  return value === 'fixed' || value === 'last-used';
}

/**
 * The Project-record fields this module owns. `PUT /projects/:slug` accepts
 * `null` on each to mean "drop the stored value", as it does for the
 * settings overrides (`project-settings-overrides.ts`).
 */
export const PROJECT_CHAT_DEFAULT_RECORD_FIELDS = [
  'defaultModelSelection',
  'defaultApprovalMode',
  'defaultApprovalModeSelection',
] as const;

export type ProjectChatDefaultRecordField =
  (typeof PROJECT_CHAT_DEFAULT_RECORD_FIELDS)[number];

/** A concrete posture: a Project default is never "leave it to the engine". */
export type ProjectChatApprovalPosture = Exclude<
  ApprovalMode,
  'connection-default'
>;

export const PROJECT_CHAT_APPROVAL_POSTURES = [
  'ask',
  'auto',
  'never',
] as const satisfies readonly ProjectChatApprovalPosture[];

export function isProjectChatApprovalPosture(
  value: unknown,
): value is ProjectChatApprovalPosture {
  return value === 'ask' || value === 'auto' || value === 'never';
}

/** The model one recorded chat start in this Project used, for one Agent. */
export interface ProjectChatLastUsedModel {
  agentSlug: string;
  modelId: string;
  /** When the start that recorded it succeeded (ISO 8601). */
  startedAt: string;
}

/** The approval mode the caller's latest recorded chat start ran in. */
export interface ProjectChatLastUsedApproval {
  approvalMode: ProjectChatApprovalPosture;
  startedAt: string;
}

/** Why a `last-used` choice did not supply the value. */
export type ProjectChatDefaultFallback =
  /** No chat start in this Project has been recorded for the caller. */
  | 'no-history'
  /**
   * The last chat ran with full access, and this start's caller cannot grant
   * it. A recorded full access is never re-applied on its own.
   */
  | 'full-access-not-granted';

/**
 * The Project's own layer of a new chat's approval mode. It sits BELOW the
 * Agent's own default and ABOVE the Station default
 * (`src-server/services/orchestration/approval-posture.ts`). Absent
 * `approvalMode`: the Project does not decide, and the Station default (or
 * the engine's own settings) applies.
 */
export interface ProjectChatApprovalDefault {
  approvalMode?: ProjectChatApprovalPosture;
  source: 'last-used' | 'fixed' | 'none';
  fallback?: ProjectChatDefaultFallback;
}

/**
 * The one resolution of a Project's approval layer, used by the session-start
 * posture and by the read the composer shows. Pure.
 *
 * `lastUsedApplies` is false for a start that is not a person's interactive
 * chat (a delegation, a webhook, an automatic replay): those never inherit a
 * posture someone picked for their own chat, and take the `fixed` value.
 * `mayGrantFullAccess` is the start's own proof (a minted grant), never a
 * value from the request body.
 */
export function resolveProjectChatApprovalDefault(input: {
  selection?: unknown;
  fixed?: unknown;
  lastUsed?: ProjectChatLastUsedApproval;
  lastUsedApplies: boolean;
  mayGrantFullAccess: boolean;
}): ProjectChatApprovalDefault {
  const fixed = isProjectChatApprovalPosture(input.fixed)
    ? input.fixed
    : undefined;
  const fixedLayer = (
    fallback?: ProjectChatDefaultFallback,
  ): ProjectChatApprovalDefault => ({
    ...(fixed ? { approvalMode: fixed } : {}),
    source: fixed ? 'fixed' : 'none',
    ...(fallback ? { fallback } : {}),
  });
  if (input.selection !== 'last-used' || !input.lastUsedApplies)
    return fixedLayer();
  const last = input.lastUsed?.approvalMode;
  if (!isProjectChatApprovalPosture(last)) return fixedLayer('no-history');
  if (last === 'never' && !input.mayGrantFullAccess)
    return fixedLayer('full-access-not-granted');
  return { approvalMode: last, source: 'last-used' };
}

/**
 * `GET /api/projects/:slug/chat-defaults`: what a new chat in this Project
 * starts with for the CALLER. Recorded values are the caller's own.
 */
export interface ProjectChatDefaultsView {
  version: 'station.project-chat-defaults/v1';
  projectSlug: string;
  model: {
    selection: ProjectChatDefaultSelection;
    /**
     * Newest first, at most one per Agent. Present whatever the selection,
     * so a settings surface can show what `last-used` would pick; a composer
     * applies it only under `last-used` ({@link projectLastUsedModelFor}).
     */
    lastUsed: ProjectChatLastUsedModel[];
  };
  approvalMode: {
    selection: ProjectChatDefaultSelection;
    fixed?: ProjectChatApprovalPosture;
    lastUsed?: ProjectChatLastUsedApproval;
    /** {@link resolveProjectChatApprovalDefault} for this caller's chat. */
    resolved: ProjectChatApprovalDefault;
  };
}

/**
 * The model a `last-used` Project preselects for `agentSlug`, or `undefined`
 * when the Project uses its fixed default or has no start recorded for that
 * Agent. Whether the model is still available is the caller's check against
 * its live catalog.
 */
export function projectLastUsedModelFor(
  view: Pick<ProjectChatDefaultsView, 'model'> | undefined,
  agentSlug: string | undefined,
): ProjectChatLastUsedModel | undefined {
  if (!view || !agentSlug || view.model.selection !== 'last-used')
    return undefined;
  return view.model.lastUsed.find((entry) => entry.agentSlug === agentSlug);
}
