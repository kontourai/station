import type {
  ProjectRoomCoordinatorSettings,
  ProjectRoomCoordinatorView,
  ProjectRoomStatusSweep,
} from '@kontourai/station-contracts/project-room-coordinator';
import { envelopeError } from './api-error-message';
import {
  type ApiRequestScope,
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';
import {
  type ProjectRoomGuards,
  ProjectRoomProtocolError,
} from './project-rooms';

/**
 * The `#general` coordinator (#5063): its suggested-Tasks cards, Start, the
 * status sweep and the Project's limits. Served where the host advertises
 * `projectRoomCoordinator`, and answered only while the
 * `project-room-coordinator` Feature Preview is on.
 */
type Envelope<T> = { success?: boolean; data?: T; error?: unknown };
async function read<T>(response: Response, fallback: string): Promise<T> {
  const body = (await readJsonBody(response)) as Envelope<T> | undefined;
  if (!response.ok || body?.success !== true || body.data === undefined)
    throw envelopeError(response, body, fallback);
  return body.data;
}

const base = (scope: ApiRequestScope, slug: string) => {
  if (!slug) throw new Error('Project identity is required');
  return `${scope.apiBase}/api/projects/${encodeURIComponent(slug)}/room/coordinator`;
};

function checkedView(
  view: ProjectRoomCoordinatorView,
  slug: string,
): ProjectRoomCoordinatorView {
  if (
    !view ||
    view.projectSlug !== slug ||
    !Array.isArray(view.proposals) ||
    view.proposals.some((proposal) => !Array.isArray(proposal.tasks))
  )
    throw new ProjectRoomProtocolError('Coordinator response incompatible.');
  return view;
}

/** The coordinator's cards in the Project's `#general`, newest first. */
export async function getProjectRoomCoordinator(
  scope: ApiRequestScope,
  slug: string,
  signal?: AbortSignal,
): Promise<ProjectRoomCoordinatorView> {
  const view = await read<ProjectRoomCoordinatorView>(
    await getJson(base(scope, slug), { requestScope: scope, signal }),
    'Coordinator unavailable.',
  );
  return checkedView(view, slug);
}

/** Start: some rows of a card, or every proposed row (Start all). */
export async function startProjectRoomCoordinatorTasks(
  scope: ApiRequestScope,
  slug: string,
  guard: ProjectRoomGuards,
  proposalId: string,
  rowIds?: readonly string[],
): Promise<ProjectRoomCoordinatorView> {
  const view = await read<ProjectRoomCoordinatorView>(
    await mutateJson(
      `${base(scope, slug)}/proposals/${encodeURIComponent(proposalId)}/start`,
      'POST',
      { requestScope: scope },
      { ...guard, ...(rowIds ? { rowIds: [...rowIds] } : {}) },
    ),
    'Could not start these Tasks.',
  );
  return checkedView(view, slug);
}

/** The status sweep: one line per open Task, posted in `#general`. */
export async function runProjectRoomStatusSweep(
  scope: ApiRequestScope,
  slug: string,
  guard: ProjectRoomGuards,
): Promise<ProjectRoomStatusSweep> {
  const sweep = await read<ProjectRoomStatusSweep>(
    await mutateJson(
      `${base(scope, slug)}/sweep`,
      'POST',
      { requestScope: scope },
      guard,
    ),
    'Status sweep unavailable.',
  );
  if (typeof sweep.messageId !== 'string' || typeof sweep.tasks !== 'number')
    throw new ProjectRoomProtocolError('Status sweep response incompatible.');
  return sweep;
}

/** The Project's coordinator limits (owner only). */
export async function setProjectRoomCoordinatorSettings(
  apiBase: string,
  projectSlug: string,
  settings: ProjectRoomCoordinatorSettings,
  options?: ClientRequestOptions,
): Promise<{ roomCoordinator?: ProjectRoomCoordinatorSettings }> {
  if (!projectSlug) throw new Error('Project identity is required');
  return read(
    await mutateJson(
      `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/room-coordinator`,
      'PUT',
      options,
      settings,
    ),
    'Could not save the coordinator settings.',
  );
}
