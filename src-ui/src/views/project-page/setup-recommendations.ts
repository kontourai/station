import type { PendingContinuation } from '../../lib/continue-in-project';

/**
 * #5071: what a new Project's Setup recommendations card proposes. Every
 * recommendation starts on and is shown with its toggle; nothing is created
 * until the person applies them. Only things Station can do today are
 * proposed: no schedule is offered until schedules belong to a Project.
 */
export type SetupRecommendation =
  | {
      id: 'brief';
      kind: 'brief';
      label: string;
      /** Editable before Apply; saved as the Project's description. */
      brief: string;
    }
  | {
      id: string;
      kind: 'task';
      label: string;
      detail: string;
      task: {
        title: string;
        description: string;
        /** The chat answer this Task cites, when it continues a chat. */
        reference?: { sessionId: string; turnId: string };
      };
    };

export const EXPLORE_TASK_TITLE = 'Explore and propose next steps';
export const EXPLORE_TASK_DESCRIPTION =
  'Read the repository without changing, committing or pushing anything, then summarize it and propose up to three next steps.';

export function setupRecommendations(input: {
  project: {
    name: string;
    description?: string;
    /** A repository is attached (a Git working directory or source). */
    hasRepository: boolean;
  };
  continuation?: PendingContinuation;
}): SetupRecommendation[] {
  const recommendations: SetupRecommendation[] = [];
  if (!input.project.description?.trim())
    recommendations.push({
      id: 'brief',
      kind: 'brief',
      label: 'Brief',
      brief: `${input.project.name}: what this Project is for, what done looks like, and how work here should be done.`,
    });
  if (input.continuation)
    recommendations.push({
      id: 'continue-chat',
      kind: 'task',
      label: input.continuation.title,
      detail: 'A Task that cites the chat this Project came from.',
      task: {
        title: input.continuation.title,
        description: input.continuation.description,
        ...(input.continuation.turnId
          ? {
              reference: {
                sessionId: input.continuation.sessionId,
                turnId: input.continuation.turnId,
              },
            }
          : {}),
      },
    });
  if (input.project.hasRepository)
    recommendations.push({
      id: 'explore',
      kind: 'task',
      label: EXPLORE_TASK_TITLE,
      detail:
        'Asks the agent to read the repository and propose next steps, without changing files.',
      task: {
        title: EXPLORE_TASK_TITLE,
        description: EXPLORE_TASK_DESCRIPTION,
      },
    });
  return recommendations;
}

const DONE_PREFIX = 'station.setup-recommendations.done.';

/** Applied or dismissed: the card does not come back for this Project. */
export function setupRecommendationsSettled(
  projectId: string,
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage,
): boolean {
  try {
    return storage?.getItem(`${DONE_PREFIX}${projectId}`) != null;
  } catch {
    return false;
  }
}

export function settleSetupRecommendations(
  projectId: string,
  outcome: 'applied' | 'dismissed',
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(`${DONE_PREFIX}${projectId}`, outcome);
  } catch {
    /* The card may reappear; applying twice is refused by its own state. */
  }
}
