/**
 * #5069: Pause, Resume, Archive and Unarchive for a Project.
 *
 * A paused or archived Project *holds* its work:
 *
 * - its state is written first, so the turn admission below refuses every
 *   new turn in the Project's chats (a person's message, a scheduled run, a
 *   recovery replay) before anything is interrupted;
 * - every running turn in the Project is then interrupted through the
 *   orchestration's own `interruptTurn`, the same server-owned path bounded
 *   unattended work uses, never a new kill path;
 * - the scheduler claims none of the Project's schedules
 *   (`heldProjectIds`).
 *
 * The interrupt is a sweep, repeated until no turn in the Project is running
 * or `PROJECT_LIFECYCLE_STOP_WAIT_MS` has passed: a turn admitted just before
 * the state was written becomes active after the first look, and the next
 * look stops it. Resume and Unarchive only lift the hold; an interrupted
 * chat continues when someone messages it.
 */
import type {
  ProjectConfig,
  ProjectMetadata,
} from '@kontourai/station-contracts/project';
import {
  PROJECT_LIFECYCLE_STOP_WAIT_MS,
  type ProjectLifecycle,
  type ProjectLifecycleAction,
  type ProjectLifecycleResult,
  type ProjectLifecycleState,
  projectHeldRefusalMessage,
  projectLifecycleHoldsWork,
  projectLifecycleStateAfter,
} from '@kontourai/station-contracts/project-lifecycle';

export interface ProjectLifecycleDeps {
  /** The Project as stored; throws when it does not exist. */
  readProject(slug: string): ProjectConfig;
  listProjects(): ProjectMetadata[];
  /** Persists the state (absent clears it) and returns the stored Project. */
  writeLifecycle(
    slug: string,
    lifecycle: ProjectLifecycle | undefined,
  ): Promise<ProjectConfig>;
  /** Every session with an active turn (`OrchestrationService`). */
  listActiveTurnThreadIds(): string[];
  /** A session's current Project binding (`OrchestrationService`). */
  resolveSessionProjectSlug(threadId: string): string | undefined;
  /** The orchestration's own server-owned turn interrupt. */
  interruptTurn(threadId: string): Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to `PROJECT_LIFECYCLE_STOP_WAIT_MS`. */
  stopWaitMs?: number;
  /** How often the sweep looks again. */
  pollMs?: number;
}

export type ProjectTurnAdmission =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface ProjectTurnStop {
  interrupted: number;
  stillRunning: number;
  failed: number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class ProjectLifecycleService {
  /**
   * Held Projects by slug, so admitting a turn in a Station with nothing
   * paused costs one map check and no session read. Loaded from storage on
   * first use and kept current by every write here.
   */
  private held: Map<string, ProjectLifecycleState> | undefined;

  constructor(private readonly deps: ProjectLifecycleDeps) {}

  private heldBySlug(): Map<string, ProjectLifecycleState> {
    if (!this.held) {
      this.held = new Map();
      for (const project of this.deps.listProjects())
        if (projectLifecycleHoldsWork(project.lifecycle))
          this.held.set(project.slug, project.lifecycle!.state);
    }
    return this.held;
  }

  /** The held state of a Project, read fresh from its record. */
  private currentHold(slug: string): ProjectLifecycleState | undefined {
    try {
      const lifecycle = this.deps.readProject(slug).lifecycle;
      return projectLifecycleHoldsWork(lifecycle)
        ? lifecycle!.state
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Registered with `OrchestrationService.registerTurnAdmission`: every
   * turn, first or successor, crosses it.
   */
  admitTurn(input: { threadId: string }): ProjectTurnAdmission {
    const held = this.heldBySlug();
    if (held.size === 0) return { allowed: true };
    const slug = this.deps.resolveSessionProjectSlug(input.threadId);
    if (!slug || !held.has(slug)) return { allowed: true };
    // The map only says where to look; the record decides.
    const state = this.currentHold(slug);
    if (!state) {
      held.delete(slug);
      return { allowed: true };
    }
    return { allowed: false, reason: projectHeldRefusalMessage(state) };
  }

  /** Ids of Projects whose schedules the scheduler must not claim. */
  heldProjectIds(): Set<string> {
    const ids = new Set<string>();
    for (const project of this.deps.listProjects())
      if (projectLifecycleHoldsWork(project.lifecycle)) ids.add(project.id);
    return ids;
  }

  /** Sessions in the Project with a turn running now. */
  runningThreadIds(slug: string): string[] {
    return this.deps
      .listActiveTurnThreadIds()
      .filter(
        (threadId) => this.deps.resolveSessionProjectSlug(threadId) === slug,
      );
  }

  /**
   * Interrupts every running turn in the Project until none is running or
   * the wait ends. Callers hold the Project first, so no new turn can start.
   */
  async stopProjectTurns(slug: string): Promise<ProjectTurnStop> {
    const now = this.deps.now ?? Date.now;
    const sleep = this.deps.sleep ?? defaultSleep;
    const deadline =
      now() + (this.deps.stopWaitMs ?? PROJECT_LIFECYCLE_STOP_WAIT_MS);
    const pollMs = this.deps.pollMs ?? 100;
    const asked = new Set<string>();
    const failedIds = new Set<string>();
    for (;;) {
      const running = this.runningThreadIds(slug);
      const fresh = running.filter((threadId) => !asked.has(threadId));
      for (const threadId of fresh) asked.add(threadId);
      const outcomes = await Promise.allSettled(
        fresh.map((threadId) => this.deps.interruptTurn(threadId)),
      );
      outcomes.forEach((outcome, index) => {
        if (outcome.status === 'rejected') failedIds.add(fresh[index]);
      });
      if (running.length === 0 || now() >= deadline)
        return {
          interrupted: asked.size,
          stillRunning: running.length,
          failed: failedIds.size,
        };
      await sleep(pollMs);
    }
  }

  async apply(
    slug: string,
    action: ProjectLifecycleAction,
  ): Promise<ProjectLifecycleResult> {
    const nextState = projectLifecycleStateAfter(action);
    const current = this.deps.readProject(slug).lifecycle;
    const lifecycle: ProjectLifecycle | undefined = nextState
      ? current?.state === nextState
        ? current
        : { state: nextState, changedAt: new Date().toISOString() }
      : undefined;
    // Resume lifts a pause, not an archive; Unarchive lifts either.
    if (action === 'resume' && current?.state === 'archived')
      return { lifecycle: current, interrupted: 0, stillRunning: 0, failed: 0 };
    const stored = await this.deps.writeLifecycle(slug, lifecycle);
    const held = this.heldBySlug();
    if (lifecycle) held.set(stored.slug, lifecycle.state);
    else held.delete(stored.slug);
    if (!lifecycle) return { interrupted: 0, stillRunning: 0, failed: 0 };
    const stop = await this.stopProjectTurns(stored.slug);
    return { lifecycle, ...stop };
  }

  /** Called after a Project is deleted, so its slug can be reused unheld. */
  forget(slug: string): void {
    this.held?.delete(slug);
  }
}
