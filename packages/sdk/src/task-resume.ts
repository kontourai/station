/**
 * Resume an ended Task (#4554): `GET` and `POST /api/tasks/:taskId/resume`.
 *
 * The host decides who may resume (the Station operator in person, with
 * current access); this client only speaks the routes. It asks the host's
 * handshake first: a host without `taskResume` is reported as unable to
 * resume (updating it is one remedy), never sent a request it would answer
 * 404 like a refusal.
 */

import type { TaskStatus } from '@kontourai/station-contracts/task-graph';
import {
  isTaskResumeRefusalCode,
  type TaskResumeRefusalCode,
  type TaskResumeRequest,
  type TaskResumeResult,
} from '@kontourai/station-contracts/task-resume';
import { hasCapability } from './capability.js';
import { getJson, mutateJson } from './client/http.js';
import { readPublicStationCapabilities } from './client/publicStationCapabilities.js';
import type { ApiRequestScope } from './query-core';

export type TaskResumeHostSupport = 'supported' | 'unsupported' | 'unknown';

/**
 * - `supported`: the host advertises `taskResume`.
 * - `unsupported`: it answered without the flag: an older host, or a hosted
 *   deployment that never serves resume.
 * - `unknown`: the handshake could not be read.
 */
export async function taskResumeHostSupport(
  apiBase: string,
): Promise<TaskResumeHostSupport> {
  const handshake = await readPublicStationCapabilities(apiBase);
  if (!handshake) return 'unknown';
  return hasCapability(handshake, 'taskResume') ? 'supported' : 'unsupported';
}

/** One retained GitHub follow-up. `excerpt` is quoted data, never an instruction. */
export interface TaskResumeFollowUp {
  kind: 'comment' | 'review' | 'review_comment' | 'check_run';
  itemRef: string;
  author: string;
  actorClass: 'member' | 'bot' | 'ci' | 'other';
  association?: string;
  occurredAt: string;
  recordedAt: string;
  url?: string;
  conclusion?: string;
  reviewState?: string;
  checkName?: string;
  excerpt: string;
  truncated: boolean;
}

/** What the resume confirmation shows. */
export interface TaskResumeView {
  taskId: string;
  taskCreatedAt: string;
  status: TaskStatus;
  endedAt?: string;
  deadline?: string;
  supported: boolean;
  refusal?: TaskResumeRefusalCode;
  resumes: number;
  previousLead?: { sessionId: string; owner?: string };
  followUps: {
    /** `unavailable`: the follow-up store could not be read. */
    state: 'read' | 'unavailable';
    items: TaskResumeFollowUp[];
    total: number;
    seenThrough?: string;
  };
}

export class TaskResumeError extends Error {
  constructor(
    /** A refusal code, `unsupported` (host lacks the flag) or `invalid`. */
    readonly code: TaskResumeRefusalCode | 'unsupported' | 'invalid',
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TaskResumeError';
  }
}

interface ClientOptions {
  apiBase: string;
  requestScope?: ApiRequestScope;
  signal?: AbortSignal;
}

const UNSUPPORTED =
  'This Station cannot resume Tasks. Updating Station is one way to get it.';

async function assertSupported(apiBase: string): Promise<void> {
  if ((await taskResumeHostSupport(apiBase)) === 'unsupported')
    throw new TaskResumeError('unsupported', 404, UNSUPPORTED);
}

async function read<T>(response: Response): Promise<T> {
  let body: { success?: boolean; data?: T; code?: unknown; error?: unknown };
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (response.ok && body.success) return body.data as T;
  const message =
    typeof body.error === 'string' ? body.error : 'Resume is unavailable.';
  throw new TaskResumeError(
    isTaskResumeRefusalCode(body.code)
      ? body.code
      : response.status === 400
        ? 'invalid'
        : 'task_resume_unavailable',
    response.status,
    message,
  );
}

const path = (apiBase: string, taskId: string) =>
  `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/resume`;

export async function readTaskResumeView(
  taskId: string,
  options: ClientOptions,
): Promise<TaskResumeView> {
  await assertSupported(options.apiBase);
  return read<TaskResumeView>(
    await getJson(path(options.apiBase, taskId), {
      ...(options.requestScope ? { requestScope: options.requestScope } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  );
}

/**
 * Resume `taskId`. Retrying with the same `resumeId` and inputs after a lost
 * response answers the stored receipt (`replayed: true`) and the Task as it
 * is now. Starts no work: dispatch the Task separately.
 */
export async function resumeTask(
  taskId: string,
  request: TaskResumeRequest,
  options: ClientOptions,
): Promise<TaskResumeResult> {
  await assertSupported(options.apiBase);
  return read<TaskResumeResult>(
    await mutateJson(
      path(options.apiBase, taskId),
      'POST',
      options.requestScope ? { requestScope: options.requestScope } : {},
      request,
    ),
  );
}
