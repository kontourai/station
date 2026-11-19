/**
 * The coordinator in a Project Room's `#general` channel (#5063).
 *
 * A person asks an Agent in `#general`. While the `project-room-coordinator`
 * preview is on, the Agent answers as the Project's coordinator: it answers
 * in place, proposes new Tasks, or sends the message to a Task already
 * working on it, and its reply always says which. Proposed Tasks wait on a
 * card with Start per row and Start all, unless the Project starts them
 * without asking.
 *
 * The Project's limits are enforced by Station, not asked of the model:
 * the maximum number of coordinator Tasks working at once, propose before
 * start, and pull requests only when the person asked for one.
 *
 * Shapes and pure helpers only. The server decides and enforces
 * (`src-server/services/projects/project-room-coordinator*.ts`).
 */

/** The Station-wide Feature Preview that turns the coordinator on. */
export const PROJECT_ROOM_COORDINATOR_PREVIEW_ID = 'project-room-coordinator';

/** Coordinator Tasks working at once when the Project names no limit. */
export const DEFAULT_COORDINATOR_MAX_CONCURRENT_TASKS = 2;
/** The most coordinator Tasks a Project may let work at once. */
export const MAX_COORDINATOR_CONCURRENT_TASKS = 10;

export const PROJECT_ROOM_COORDINATOR_LIMITS = {
  /** Tasks one reply may propose. */
  tasksPerProposal: 6,
  titleChars: 120,
  /** What a proposed Task is asked to do: its first message. */
  promptChars: 4_000,
  /** A message the coordinator sends on to an existing Task. */
  messageChars: 4_000,
  /** The part of a settled Task's answer its result message quotes. */
  resultExcerptChars: 1_200,
  /** Open Tasks one status sweep reports. */
  sweepTasks: 30,
  /** The part of each Task's latest output a sweep line quotes. */
  sweepExcerptChars: 240,
  /** Cards the coordinator view returns, newest first. */
  viewProposals: 20,
} as const;

/**
 * Pull requests a coordinator Task may open: only when the person's own
 * message asked for one (`when-asked`, the default), or whenever the Task
 * decides to (`allowed`).
 */
export type ProjectRoomCoordinatorPullRequests = 'when-asked' | 'allowed';

/** The Project's coordinator settings (`ProjectConfig.roomCoordinator`). */
export interface ProjectRoomCoordinatorSettings {
  /** Start proposed Tasks at once instead of showing the card first. */
  startWithoutAsking: boolean;
  /** Coordinator Tasks working at once, 1–10. The rest wait for a slot. */
  maxConcurrentTasks: number;
  pullRequests: ProjectRoomCoordinatorPullRequests;
}

export const DEFAULT_PROJECT_ROOM_COORDINATOR_SETTINGS: ProjectRoomCoordinatorSettings =
  Object.freeze({
    startWithoutAsking: false,
    maxConcurrentTasks: DEFAULT_COORDINATOR_MAX_CONCURRENT_TASKS,
    pullRequests: 'when-asked',
  });

const SETTINGS_KEYS = new Set([
  'startWithoutAsking',
  'maxConcurrentTasks',
  'pullRequests',
]);

/** A settings body as a client sent it (every field), or undefined. */
export function parseProjectRoomCoordinatorSettings(
  value: unknown,
): ProjectRoomCoordinatorSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !SETTINGS_KEYS.has(key)))
    return undefined;
  const { startWithoutAsking, maxConcurrentTasks, pullRequests } = record;
  if (typeof startWithoutAsking !== 'boolean') return undefined;
  if (
    typeof maxConcurrentTasks !== 'number' ||
    !Number.isInteger(maxConcurrentTasks) ||
    maxConcurrentTasks < 1 ||
    maxConcurrentTasks > MAX_COORDINATOR_CONCURRENT_TASKS
  )
    return undefined;
  if (pullRequests !== 'when-asked' && pullRequests !== 'allowed')
    return undefined;
  return { startWithoutAsking, maxConcurrentTasks, pullRequests };
}

/** The settings a Project runs with: its stored ones, else the defaults. */
export function effectiveProjectRoomCoordinatorSettings(
  stored: unknown,
): ProjectRoomCoordinatorSettings {
  return (
    parseProjectRoomCoordinatorSettings(stored) ?? {
      ...DEFAULT_PROJECT_ROOM_COORDINATOR_SETTINGS,
    }
  );
}

/**
 * Whether a person's message asks for a pull request (or merge request).
 * This, not the model's say-so, decides whether a `when-asked` Project's
 * coordinator Task may open one.
 */
export function askedForPullRequest(text: string): boolean {
  return /\b(?:pull[\s-]?requests?|merge[\s-]?requests?|PRs?|MRs?)\b/i.test(
    text,
  );
}

/** The tag the coordinator's reply ends with, carrying its routing. */
export const COORDINATOR_ROUTING_TAG = 'station_routing';

/** One Task the coordinator proposes. */
export interface CoordinatorProposedTask {
  title: string;
  /** What the Task is asked to do: its first message. */
  prompt: string;
  /** The Agent to run it; absent means the Agent that was asked. */
  agentId?: string;
  /** The coordinator thinks this Task should open a pull request. */
  pullRequest: boolean;
}

/** Where one `#general` message went. */
export type CoordinatorRouting =
  | { kind: 'answer' }
  | { kind: 'tasks'; tasks: CoordinatorProposedTask[] }
  | { kind: 'existing-task'; taskId: string; message: string };

export interface ParsedCoordinatorReply {
  /** The reply with every routing block removed, trimmed. */
  text: string;
  routing: CoordinatorRouting;
  /** A routing block was present but unusable; the reply is an answer. */
  malformed: boolean;
}

const ROUTING_BLOCK = new RegExp(
  `<${COORDINATOR_ROUTING_TAG}>([\\s\\S]*?)</${COORDINATOR_ROUTING_TAG}>`,
  'gi',
);

function boundedLine(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.replace(/\s+/g, ' ').trim();
  return line && line.length <= max ? line : undefined;
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function parseRouting(raw: string): CoordinatorRouting | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (record.route === 'answer') return { kind: 'answer' };
  if (record.route === 'task') {
    const taskId = boundedLine(record.taskId, 256);
    const message = boundedText(
      record.message,
      PROJECT_ROOM_COORDINATOR_LIMITS.messageChars,
    );
    return taskId && message
      ? { kind: 'existing-task', taskId, message }
      : undefined;
  }
  if (record.route === 'tasks') {
    if (!Array.isArray(record.tasks)) return undefined;
    if (
      record.tasks.length < 1 ||
      record.tasks.length > PROJECT_ROOM_COORDINATOR_LIMITS.tasksPerProposal
    )
      return undefined;
    const tasks: CoordinatorProposedTask[] = [];
    for (const entry of record.tasks) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        return undefined;
      const task = entry as Record<string, unknown>;
      const title = boundedLine(
        task.title,
        PROJECT_ROOM_COORDINATOR_LIMITS.titleChars,
      );
      const prompt = boundedText(
        task.prompt,
        PROJECT_ROOM_COORDINATOR_LIMITS.promptChars,
      );
      if (!title || !prompt) return undefined;
      const agentId =
        task.agent === undefined ? undefined : boundedLine(task.agent, 128);
      if (task.agent !== undefined && !agentId) return undefined;
      tasks.push({
        title,
        prompt,
        ...(agentId ? { agentId } : {}),
        pullRequest: task.pullRequest === true,
      });
    }
    return { kind: 'tasks', tasks };
  }
  return undefined;
}

/**
 * Read the coordinator's reply: its visible text and where it routed the
 * message. The last routing block decides; a reply with none, or with one
 * that does not parse, is an answer in place.
 */
export function parseCoordinatorReply(text: string): ParsedCoordinatorReply {
  const blocks = [...text.matchAll(ROUTING_BLOCK)];
  const visible = text.replace(ROUTING_BLOCK, '').trim();
  const last = blocks[blocks.length - 1];
  if (!last)
    return { text: visible, routing: { kind: 'answer' }, malformed: false };
  const routing = parseRouting(last[1] ?? '');
  return routing
    ? { text: visible, routing, malformed: false }
    : { text: visible, routing: { kind: 'answer' }, malformed: true };
}

/**
 * A coordinator Task's state, named by what happens next:
 *
 * - `proposed`: on the card, waiting for Start.
 * - `waiting`: started, waiting for a free slot (the Project's limit).
 * - `starting`: Station is creating and starting its Task.
 * - `working`: its Task is running.
 * - `done` / `failed`: settled; its result was posted to the room.
 * - `refused`: Station did not start it; `refusal` says why.
 */
export const COORDINATOR_TASK_STATES = [
  'proposed',
  'waiting',
  'starting',
  'working',
  'done',
  'failed',
  'refused',
] as const;
export type CoordinatorTaskState = (typeof COORDINATOR_TASK_STATES)[number];

/** States that hold one of the Project's slots. */
export function coordinatorTaskHoldsSlot(state: CoordinatorTaskState): boolean {
  return state === 'starting' || state === 'working';
}

/** States a status sweep reports: started and not yet settled. */
export function coordinatorTaskIsOpen(state: CoordinatorTaskState): boolean {
  return state === 'waiting' || coordinatorTaskHoldsSlot(state);
}

/** One row of a suggested-Tasks card. */
export interface ProjectRoomCoordinatorTask {
  rowId: string;
  title: string;
  prompt: string;
  agentId: string;
  agentLabel: string;
  /** Where its Session runs: the Project's directory or its own worktree. */
  placement: 'project' | 'worktree';
  /** Whether Station lets this Task open a pull request. */
  mayOpenPullRequest: boolean;
  /** Pull requests Station refused this Task's agent. */
  pullRequestRefusals: number;
  state: CoordinatorTaskState;
  taskId?: string;
  /** Why Station did not start it (`refused`). */
  refusal?: string;
  /** The room message that reported its result. */
  resultMessageId?: string;
  updatedAt: string;
}

/** One suggested-Tasks card, under the coordinator message that made it. */
export interface ProjectRoomCoordinatorProposal {
  proposalId: string;
  /** The coordinator's room message; absent until it is posted. */
  messageId?: string;
  createdAt: string;
  tasks: ProjectRoomCoordinatorTask[];
}

/** What `GET /api/projects/:slug/room/coordinator` answers. */
export interface ProjectRoomCoordinatorView {
  projectSlug: string;
  settings: ProjectRoomCoordinatorSettings;
  /** Coordinator Tasks holding a slot now. */
  working: number;
  /** Coordinator Tasks waiting for a slot. */
  waiting: number;
  /** Newest first, at most `viewProposals`. */
  proposals: ProjectRoomCoordinatorProposal[];
}

/** `POST …/proposals/:proposalId/start`: some rows, or every proposed row. */
export interface ProjectRoomCoordinatorStartInput {
  rowIds?: string[];
}

/** What a status sweep posted. */
export interface ProjectRoomStatusSweep {
  messageId: string;
  /** Open Tasks the sweep reported. */
  tasks: number;
}

/** The app path of a Task, as coordinator messages link it. */
export function coordinatorTaskPath(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}
