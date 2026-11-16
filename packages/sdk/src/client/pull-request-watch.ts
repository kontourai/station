import type {
  ProjectPullRequestWatchSettings,
  TaskPullRequestWatchModeInput,
  TaskPullRequestWatchView,
} from '@kontourai/station-contracts/pull-request-watch';
import { envelopeError } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';

/**
 * Task-owned pull requests (#5066). The routes are served only where pull
 * request agent feedback is (`pullRequestFeedback`); gate on
 * `readPullRequestFeedbackCapability` from `./pull-request-feedback`.
 */
type Envelope<T> = { success?: boolean; data?: T; error?: string };
async function read<T>(response: Response): Promise<T> {
  const body = (await readJsonBody(response)) as Envelope<T> | undefined;
  if (!response.ok || !body?.success || body.data === undefined)
    throw envelopeError(response, body, 'Pull request watch unavailable');
  return body.data;
}

const taskPath = (apiBase: string, taskId: string) => {
  if (!taskId) throw new Error('Task identity is required');
  return `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/pull-request-watch`;
};

/** What a Task watches, its fix attempts and its refused agent actions. */
export async function getTaskPullRequestWatch(
  apiBase: string,
  taskId: string,
  options?: ClientRequestOptions,
): Promise<TaskPullRequestWatchView> {
  const view = await read<TaskPullRequestWatchView>(
    await getJson(taskPath(apiBase, taskId), options),
  );
  if (view.taskId !== taskId || !Array.isArray(view.pullRequests))
    throw new Error('Pull request watch response has the wrong identity');
  return view;
}

/** A person's choice for one Task: `on`, `off` (Stop watching) or `project`. */
export async function setTaskPullRequestWatch(
  apiBase: string,
  taskId: string,
  mode: TaskPullRequestWatchModeInput,
  options?: ClientRequestOptions,
): Promise<TaskPullRequestWatchView> {
  return read<TaskPullRequestWatchView>(
    await mutateJson(taskPath(apiBase, taskId), 'PUT', options, { mode }),
  );
}

/** A Project's setting: whether its Tasks watch their pull requests. */
export async function setProjectPullRequestWatch(
  apiBase: string,
  projectSlug: string,
  settings: ProjectPullRequestWatchSettings,
  options?: ClientRequestOptions,
): Promise<{ pullRequestWatch?: ProjectPullRequestWatchSettings }> {
  if (!projectSlug) throw new Error('Project identity is required');
  return read(
    await mutateJson(
      `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/pull-request-watch`,
      'PUT',
      options,
      settings,
    ),
  );
}
