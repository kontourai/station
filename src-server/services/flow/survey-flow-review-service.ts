import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ContinuePausedFlowGateFromSurveyInput,
  type ContinuePausedFlowGateFromSurveyResult,
  createSurveyFlowGateAdapter,
  type DiscoverSurveyGateReviewWorkInput,
  discoverSurveyGateReviewWork,
  type ResolvedSurveyFlowGateReviewSession,
  type SurveyGateReviewWorkRequest,
} from '@kontourai/flow-agents';
import {
  buildReviewItemPresentation,
  reviewSessionSummary,
} from '@kontourai/survey/review-workbench';
import {
  surveyFlowReviewContinuations,
  surveyFlowReviewDiscoveries,
  surveyFlowReviewUnavailableProjects,
} from '../../telemetry/metrics.js';

export interface StationSurveyReviewSession
  extends ResolvedSurveyFlowGateReviewSession {
  readonly reviewSessionRef: string;
  readonly projectSlug: string;
}

/** Host capability only: Survey and Flow Agents remain authoritative for data semantics. */
export interface StationSurveyReviewSessionStore {
  list(
    projectSlug: string,
  ):
    | readonly StationSurveyReviewSession[]
    | Promise<readonly StationSurveyReviewSession[]>;
  resolve(
    reviewSessionRef: string,
  ): StationSurveyReviewSession | Promise<StationSurveyReviewSession>;
}

export class FileStationSurveyReviewSessionStore
  implements StationSurveyReviewSessionStore
{
  constructor(
    private readonly projects: {
      listSlugs(): readonly string[];
      workspace(slug: string): string | undefined;
    },
  ) {}

  async list(
    projectSlug: string,
  ): Promise<readonly StationSurveyReviewSession[]> {
    const workspace = this.projects.workspace(projectSlug);
    if (!workspace) return [];
    try {
      const raw = JSON.parse(
        await readFile(
          join(workspace, '.station', 'survey-review-sessions.json'),
          'utf8',
        ),
      ) as { sessions?: unknown };
      if (!Array.isArray(raw.sessions)) {
        throw new Error(
          'Survey review session store must contain a sessions array',
        );
      }
      return raw.sessions.map((value) =>
        assertStationSurveyReviewSession(value, projectSlug),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async resolve(reviewSessionRef: string): Promise<StationSurveyReviewSession> {
    const matches = (
      await Promise.all(
        this.projects.listSlugs().map((slug) => this.list(slug)),
      )
    )
      .flat()
      .filter((session) => session.reviewSessionRef === reviewSessionRef);
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `Survey review session not found: ${reviewSessionRef}`
          : `Survey review session ref is ambiguous: ${reviewSessionRef}`,
      );
    }
    return matches[0];
  }
}

function assertStationSurveyReviewSession(
  value: unknown,
  projectSlug: string,
): StationSurveyReviewSession {
  if (!value || typeof value !== 'object') {
    throw new Error('Survey review session entry must be an object');
  }
  const session = value as Partial<StationSurveyReviewSession>;
  for (const [field, candidate] of [
    ['reviewSessionRef', session.reviewSessionRef],
    ['projectionSource', session.projectionSource],
    ['workflowSubjectRef', session.workflowSubjectRef],
  ] as const) {
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new Error(
        `Survey review session ${field} must be a non-empty string`,
      );
    }
  }
  if (
    !session.record ||
    !Array.isArray(session.events) ||
    !session.currentSnapshot
  ) {
    throw new Error('Survey review session is missing canonical Survey state');
  }
  if (session.projectSlug && session.projectSlug !== projectSlug) {
    throw new Error(
      'Survey review session project binding does not match its store',
    );
  }
  return { ...session, projectSlug } as StationSurveyReviewSession;
}

export interface SurveyFlowReviewQueueItem {
  readonly reviewSessionRef: string;
  readonly projectSlug: string;
  readonly projectionSource: string;
  readonly workflowSubjectRef: string;
  readonly sessionName: string;
  readonly updatedAt: string;
  readonly summary: ReturnType<typeof reviewSessionSummary>;
  readonly items: readonly ReturnType<typeof buildReviewItemPresentation>[];
}

export const SURVEY_FLOW_REVIEW_UNAVAILABLE_REASONS = [
  /** The workspace path itself could not be traversed or opened. Shares its
   * name with the review-evidence reason so one root cause reads the same in
   * both feeds — they render in the same alert. */
  'workspace-unreadable',
  /** The sessions file was reachable but could not be read, parsed, or
   * validated. A missing workspace or an absent file stays a normal empty
   * state (the store returns [] for both) and never lands here. */
  'sessions-unreadable',
  /** The sessions loaded, and building the queue projection from them threw —
   * a Station defect, not something the operator can fix in the file. */
  'projection-failed',
] as const;
export type SurveyFlowReviewUnavailableReason =
  (typeof SURVEY_FLOW_REVIEW_UNAVAILABLE_REASONS)[number];

/**
 * Errno codes that mean the path, not the file's contents, is the problem.
 * ENOENT is deliberately absent: the store already turns it into an empty
 * project. EACCES on the sessions file itself lands here too — imprecise by
 * one level, but it points at the same remedy (path and permissions) and
 * matches the review-evidence classifier rather than inventing a second
 * answer for one cause.
 */
const WORKSPACE_ERRNO_CODES = new Set(['ENOTDIR', 'EACCES', 'ELOOP', 'EPERM']);

function classifySessionStoreFailure(
  error: unknown,
): SurveyFlowReviewUnavailableReason {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === 'string' && WORKSPACE_ERRNO_CODES.has(code)) {
    return 'workspace-unreadable';
  }
  return 'sessions-unreadable';
}

export interface SurveyFlowReviewUnavailableProject {
  readonly projectSlug: string;
  readonly reason: SurveyFlowReviewUnavailableReason;
}

/**
 * Cross-project aggregate, total over the inventory (archive#3322, mirroring the
 * archive#3303 review-evidence shape): a project Station cannot read contributes
 * zero items plus an `unavailableProjects` entry carrying the reason it
 * failed, instead of failing the whole flow-reviews source.
 */
export interface SurveyFlowReviewAggregate {
  readonly items: SurveyFlowReviewQueueItem[];
  readonly unavailableProjects: SurveyFlowReviewUnavailableProject[];
}

function projectQueueItems(
  sessions: readonly StationSurveyReviewSession[],
): SurveyFlowReviewQueueItem[] {
  return sessions.map((session) => ({
    reviewSessionRef: session.reviewSessionRef,
    projectSlug: session.projectSlug,
    projectionSource: session.projectionSource,
    workflowSubjectRef: session.workflowSubjectRef,
    sessionName: session.record.sessionName,
    updatedAt: session.record.updatedAt,
    summary: reviewSessionSummary(session.currentSnapshot),
    items: session.currentSnapshot.items.map((item) =>
      buildReviewItemPresentation(item),
    ),
  }));
}

export class SurveyFlowReviewService {
  readonly #store: StationSurveyReviewSessionStore;
  readonly #adapter: ReturnType<typeof createSurveyFlowGateAdapter>;
  readonly #diagnostic: (projectSlug: string, error: unknown) => void;

  constructor(
    store: StationSurveyReviewSessionStore,
    options?: { diagnostic?: (projectSlug: string, error: unknown) => void },
  ) {
    this.#store = store;
    this.#adapter = createSurveyFlowGateAdapter({ reviewSessions: store });
    this.#diagnostic = options?.diagnostic ?? (() => {});
  }

  async list(projectSlug: string): Promise<SurveyFlowReviewQueueItem[]> {
    return projectQueueItems(await this.#store.list(projectSlug));
  }

  async listAll(
    projectSlugs: readonly string[],
  ): Promise<SurveyFlowReviewAggregate> {
    const uniqueProjectSlugs = [...new Set(projectSlugs)].sort();
    const settled = await Promise.all(
      uniqueProjectSlugs.map((projectSlug) => this.#collect(projectSlug)),
    );
    return {
      items: settled.flatMap((entry) => entry.items ?? []),
      unavailableProjects: settled.flatMap((entry) =>
        entry.reason
          ? [{ projectSlug: entry.projectSlug, reason: entry.reason }]
          : [],
      ),
    };
  }

  /**
   * The two failure phases are caught separately because that is what makes
   * the reported reason derived rather than asserted: a store failure is
   * about the workspace or the file, a projection failure is a Station
   * defect, and one catch around both could only ever guess.
   */
  async #collect(projectSlug: string): Promise<{
    projectSlug: string;
    items: SurveyFlowReviewQueueItem[] | null;
    reason: SurveyFlowReviewUnavailableReason | null;
  }> {
    let sessions: readonly StationSurveyReviewSession[];
    try {
      sessions = await this.#store.list(projectSlug);
    } catch (error) {
      return this.#unavailable(
        projectSlug,
        classifySessionStoreFailure(error),
        error,
      );
    }
    try {
      return { projectSlug, items: projectQueueItems(sessions), reason: null };
    } catch (error) {
      return this.#unavailable(projectSlug, 'projection-failed', error);
    }
  }

  #unavailable(
    projectSlug: string,
    reason: SurveyFlowReviewUnavailableReason,
    error: unknown,
  ): {
    projectSlug: string;
    items: null;
    reason: SurveyFlowReviewUnavailableReason;
  } {
    this.#diagnostic(projectSlug, error);
    surveyFlowReviewUnavailableProjects.add(1, { reason });
    return { projectSlug, items: null, reason };
  }

  async discover(
    input: DiscoverSurveyGateReviewWorkInput,
  ): Promise<SurveyGateReviewWorkRequest[]> {
    try {
      const result = await discoverSurveyGateReviewWork(input);
      surveyFlowReviewDiscoveries.add(result.length, { outcome: 'success' });
      return result;
    } catch (error) {
      surveyFlowReviewDiscoveries.add(1, { outcome: 'rejected' });
      throw error;
    }
  }

  async continuePausedGate(
    input: ContinuePausedFlowGateFromSurveyInput,
  ): Promise<ContinuePausedFlowGateFromSurveyResult> {
    try {
      const result = await this.#adapter.continuePausedGate(input);
      surveyFlowReviewContinuations.add(1, { outcome: 'resumed' });
      return result;
    } catch (error) {
      surveyFlowReviewContinuations.add(1, { outcome: 'rejected' });
      throw error;
    }
  }
}
