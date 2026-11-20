/**
 * Project lifecycle (#5069): Pause, Archive and Delete, and what each one
 * stops or removes.
 *
 * - **Paused**: Station interrupts every running turn in the Project's chats,
 *   admits no new turn there (a person's message, a schedule, a recovery
 *   replay), and claims none of the Project's schedules. Resume lifts the
 *   hold; a stopped chat continues only when someone messages it.
 * - **Archived**: everything Paused does, and the Project leaves the
 *   sidebar. Unarchive returns it, active.
 * - **Delete** (`ProjectDeletionPreview`): what the confirmation counts.
 *
 * Absent `ProjectConfig.lifecycle` means active. The state is server-written
 * by the lifecycle route only; the ordinary Project update refuses it.
 */

export type ProjectLifecycleState = 'paused' | 'archived';

export interface ProjectLifecycle {
  readonly state: ProjectLifecycleState;
  /** ISO time the state was entered. */
  readonly changedAt: string;
}

export const PROJECT_LIFECYCLE_ACTIONS = [
  'pause',
  'resume',
  'archive',
  'unarchive',
] as const;

export type ProjectLifecycleAction = (typeof PROJECT_LIFECYCLE_ACTIONS)[number];

/** The state an action leaves the Project in; `undefined` is active. */
export function projectLifecycleStateAfter(
  action: ProjectLifecycleAction,
): ProjectLifecycleState | undefined {
  switch (action) {
    case 'pause':
      return 'paused';
    case 'archive':
      return 'archived';
    case 'resume':
    case 'unarchive':
      return undefined;
  }
}

/**
 * Whether a Project in `lifecycle` holds its work: no turn is admitted in its
 * chats and none of its schedules is claimed. Paused and archived both hold.
 */
export function projectLifecycleHoldsWork(
  lifecycle: Pick<ProjectLifecycle, 'state'> | undefined,
): boolean {
  return lifecycle?.state === 'paused' || lifecycle?.state === 'archived';
}

/**
 * How long the lifecycle route waits for interrupted turns to end before it
 * reports the ones still running. Published so the UI and docs can state it.
 */
export const PROJECT_LIFECYCLE_STOP_WAIT_MS = 10_000;

/** `POST /api/projects/:slug/lifecycle` body. */
export interface ProjectLifecycleRequest {
  readonly action: ProjectLifecycleAction;
}

/** `POST /api/projects/:slug/lifecycle` result. */
export interface ProjectLifecycleResult {
  /** The Project's state after the action; absent is active. */
  readonly lifecycle?: ProjectLifecycle;
  /** Running turns Station asked to stop. Zero for Resume and Unarchive. */
  readonly interrupted: number;
  /**
   * Turns still running when the bounded wait
   * (`PROJECT_LIFECYCLE_STOP_WAIT_MS`) ended. They admit no further turn.
   */
  readonly stillRunning: number;
  /** Interrupt requests that failed; each turn is still held. */
  readonly failed: number;
}

/** The refusal code a held Project's turn admission answers with. */
export const PROJECT_HELD_REFUSAL_CODE = 'project_held';

/** The sentence a refused turn shows for a held Project. */
export function projectHeldRefusalMessage(
  state: ProjectLifecycleState,
): string {
  return state === 'paused'
    ? 'This Project is paused. Resume it to continue.'
    : 'This Project is archived. Unarchive it to continue.';
}

/**
 * `GET /api/projects/:slug/deletion-preview`: what Delete removes and what it
 * keeps, counted from the same records the delete acts on.
 */
export interface ProjectDeletionPreview {
  readonly removes: {
    /** Layouts stored with the Project. */
    readonly layouts: number;
    /** Knowledge documents stored with the Project. */
    readonly knowledgeDocuments: number;
    /** Scheduled jobs that belong to the Project. */
    readonly schedules: number;
  };
  /** Running turns in the Project's chats that Delete stops. */
  readonly stops: { readonly runningSessions: number };
  /** Kept: still readable after the Project is gone. */
  readonly keeps: {
    readonly tasks: number;
    readonly sessions: number;
  };
}
