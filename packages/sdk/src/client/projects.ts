/**
 * Canonical project + project-layout fetchers (#167 Wave 1). Shared by the
 * SDK's `workspaceProjects.ts` (thin wrappers), the CLI's `resourceSpecs.projects`
 * and `runProjectLayoutCommand` (`packages/cli/src/commands/core.ts`), and
 * `station-control-operations-tools.ts`'s `list_projects`/`get_project`/
 * `list_project_layouts` tools.
 *
 * `fetchAvailableLayouts` (plugin-contributed layout catalog) is intentionally
 * left in `packages/sdk/src/api.ts` — it is not in the audit's triplication
 * table.
 */
import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import type { ProjectIconCandidate } from '@kontourai/station-contracts/project';
import {
  isWellFormedProjectResolutionView,
  isWellFormedProjectResourceBindOutcome,
  type ProjectResolutionView,
  type ProjectResourceBindOutcome,
} from '@kontourai/station-contracts/project-identity';
import type {
  WorkspaceFilePreview,
  WorkspaceFilePreviewRequest,
} from '@kontourai/station-contracts/workspace-file-preview';
import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type {
  WorkspacePaneAvailability,
  WorkspacePaneAvailabilityInput,
} from '@kontourai/station-contracts/workspace-pane-availability';
import {
  type ClientRequestOptions,
  envelopeErrorMessage,
  getJson,
  mutateJson,
  readJsonBody,
  StationHttpError,
} from './http';

interface ProjectEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Read-only, host-produced Pane catalog projection; no renderer state is implied. */
export interface ProjectWorkspacePaneCatalog {
  version: '1.0';
  /** Canonical Project identity; distinct from the route slug. */
  projectId: string;
  contributions: readonly (LayoutCatalogItem & {
    disabledReason?: string;
  })[];
  descriptors: readonly WorkspacePaneDescriptor[];
  instances: readonly WorkspacePaneInstance[];
  /** Current availability result, optionally scoped to a placed instance. */
  availability?: readonly ProjectWorkspacePaneAvailabilityProjection[];
}

/** Preserves descriptor identity without inventing an unplaced instance. */
export interface ProjectWorkspacePaneAvailabilityProjection {
  descriptorId: WorkspacePaneDescriptor['id'];
  instanceId?: WorkspacePaneInstance['instanceId'];
  /** Server-authoritative bounded facts for host-side availability composition. */
  input: WorkspacePaneAvailabilityInput;
  availability: WorkspacePaneAvailability;
}

/** Exact terminal identity confirmed terminated by a project-bound request. */
export interface ProjectTerminalCloseResult {
  sessionId: string;
  projectSlug: string;
  terminalId: string;
}

/**
 * The single unwrap behind every `client/projects.ts` call.
 *
 * Status FIRST (4-HOME-006): a non-2xx is a failure whatever the body looks
 * like — including the runtime's auth refusal, which carries no `success` key
 * and whose `error` is an object, and including a body that is not JSON at
 * all. Only then does an `ok` response with `success:false` count as a
 * route-level refusal. The message itself comes from `envelopeErrorMessage`,
 * the one derivation shared with every other client fetcher, so no caller
 * renders `[object Object]` again.
 *
 * A non-2xx throws `StationHttpError`, so a consumer can branch on the STATUS
 * (`LayoutView`'s 404 not-found state, `RouteViewBoundary`'s authority
 * classification) instead of sniffing the message text for 'not found'.
 */
async function unwrapOrThrow<T = any>(
  response: Response,
  defaultError?: string,
): Promise<T> {
  const result = (await readJsonBody(response)) as
    | ProjectEnvelope<T>
    | undefined;
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      envelopeErrorMessage(
        result,
        defaultError ?? `Request failed with HTTP ${response.status}`,
      ),
    );
  }
  if (!result?.success) {
    throw new Error(
      envelopeErrorMessage(result, defaultError ?? 'Request failed'),
    );
  }
  return result.data as T;
}

/** `GET /api/projects` — list projects. */
export async function listProjects(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await getJson(`${apiBase}/api/projects`, opts);
  return unwrapOrThrow(response);
}

/** `GET /api/projects/:slug` — get a project. */
export async function getProject(
  apiBase: string,
  slug: string,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await getJson(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}`,
    opts,
  );
  return unwrapOrThrow(response);
}

/** `GET /api/projects/icon-candidates` — bounded local artwork discovery. */
export async function listProjectIconCandidates(
  apiBase: string,
  workspacePath: string,
  opts?: ClientRequestOptions,
): Promise<ProjectIconCandidate[]> {
  const response = await getJson(
    `${apiBase}/api/projects/icon-candidates?path=${encodeURIComponent(workspacePath)}`,
    opts,
  );
  return unwrapOrThrow(response, 'Failed to discover project artwork');
}

/** `GET /api/projects/:slug/layouts` — list a project's layouts. */
export async function listProjectLayouts(
  apiBase: string,
  projectSlug: string,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await getJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/layouts`,
    opts,
  );
  return unwrapOrThrow(response);
}

/** `GET /api/projects/:slug/panes` — current built-in/plugin/MCP Pane catalog. */
export async function listProjectWorkspacePanes(
  apiBase: string,
  projectSlug: string,
  opts?: ClientRequestOptions,
): Promise<ProjectWorkspacePaneCatalog> {
  const response = await getJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/panes`,
    opts,
  );
  return unwrapOrThrow<ProjectWorkspacePaneCatalog>(response);
}

/** `DELETE /api/projects/:slug/terminals/:terminalId` — terminate one Project terminal. */
export async function closeProjectTerminal(
  apiBase: string,
  projectSlug: string,
  terminalId: string,
  opts?: ClientRequestOptions,
): Promise<ProjectTerminalCloseResult> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/terminals/${encodeURIComponent(terminalId)}`,
    'DELETE',
    opts,
  );
  return unwrapOrThrow<ProjectTerminalCloseResult>(
    response,
    'Failed to close terminal',
  );
}

/** `POST /api/projects/:slug/file-preview` — bounded, project-bound file preview. */
export async function previewProjectWorkspaceFile(
  apiBase: string,
  projectSlug: string,
  request: WorkspaceFilePreviewRequest,
  opts?: ClientRequestOptions,
): Promise<WorkspaceFilePreview> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/file-preview`,
    'POST',
    opts,
    request,
  );
  return unwrapOrThrow<WorkspaceFilePreview>(
    response,
    'Failed to preview file',
  );
}

/**
 * `GET /api/projects/:slug/resolution` — station#1502 slice 4.
 *
 * What THIS Station can truthfully say about the project's resources: the
 * `not-backing` / `backing` / `unreadable` posture, one result PER DECLARED
 * RESOURCE, and which of them a no-`resourceId` caller gets (station#1503
 * slice 5). See `ProjectResolutionView` for why the discriminator is the
 * posture and not a resource state, why the primary selection is carried
 * separately, and why this response deliberately carries no `manifest.repos`.
 */
export async function getProjectResolution(
  apiBase: string,
  projectSlug: string,
  opts?: ClientRequestOptions,
): Promise<ProjectResolutionView> {
  const response = await getJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/resolution`,
    opts,
  );
  const view = await unwrapOrThrow<unknown>(
    response,
    'Failed to read project resolution',
  );
  // The predicate is CALLED, not merely declared. Its own docblock says it
  // exists for values that arrive without a compiler and that this one
  // "crosses the wire on every settings render" — and the surface's switches
  // are exhaustive with no `default:` (deliberately), so an unrecognised
  // posture would fall off the end and React would render NOTHING: a header
  // and a description over an empty body, with no error and no named gap.
  // A nightly desktop app against a stable server is exactly that scenario.
  // Throwing routes it into the surface's existing `isError` → ErrorState +
  // Retry branch instead (station#1502 fix round, MEDIUM-1).
  if (!isWellFormedProjectResolutionView(view)) {
    throw new Error(
      `This Station answered with a project resolution this client does not understand (${describeUnknownShape(view)}). It may be running a newer version than this app.`,
    );
  }
  return view;
}

/**
 * Enough of an unrecognized value to act on, and never the value itself: the
 * response may carry paths or reasons, and a client-side error string is the
 * wrong place to widen what a malformed payload discloses. So: the type, or
 * the discriminant if it is a string, or the key names — nothing else.
 */
function describeUnknownShape(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return `it is ${value === null ? 'null' : typeof value}, not an object`;
  }
  const posture = (value as { posture?: unknown }).posture;
  if (typeof posture === 'string') return `posture "${posture}"`;
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 0
    ? 'it carries no fields'
    : `its fields are ${keys.join(', ')}`;
}

/**
 * `POST /api/projects/:slug/bind` — station#1502 slice 4, the repair action.
 *
 * Points ONE of the project's resources — `body.resourceId`, or the primary
 * when it is omitted — at a checkout the OPERATOR named. The server
 * verifies before it records and refuses with the reason otherwise (§3.6:
 * "never silently re-bind"), so a rejection surfaces here as a thrown error
 * carrying that reason verbatim — it must be shown, not retried and not
 * replaced with a generic message.
 *
 * Resolves with a {@link ProjectResourceBindOutcome}: the row was recorded,
 * and either the freshly re-derived view or a NAMED gap explaining why this
 * Station could not re-read what it can now say. A re-read failure is NOT a
 * failed bind and must never be surfaced as one.
 */
export async function bindProjectResource(
  apiBase: string,
  projectSlug: string,
  body: { path: string; resourceId?: string },
  opts?: ClientRequestOptions,
): Promise<ProjectResourceBindOutcome> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/bind`,
    'POST',
    opts,
    body,
  );
  const outcome = await unwrapOrThrow<unknown>(
    response,
    'Failed to bind project resource',
  );
  // Same reason as `getProjectResolution` above: an unrecognised view would
  // reach the surface's `default:`-free switch and render nothing at all.
  if (!isWellFormedProjectResourceBindOutcome(outcome)) {
    throw new Error(
      `This Station answered the bind with a shape this client does not understand (${describeUnknownShape(outcome)}). It may be running a newer version than this app.`,
    );
  }
  return outcome;
}

/** `GET /api/projects/:slug/layouts/:layoutSlug` — get one layout. */
export async function getProjectLayout(
  apiBase: string,
  projectSlug: string,
  layoutSlug: string,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await getJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/layouts/${encodeURIComponent(layoutSlug)}`,
    opts,
  );
  return unwrapOrThrow(response);
}

/** `POST /api/projects` — create a project. */
export async function createProject(
  apiBase: string,
  body: Record<string, unknown>,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await mutateJson(
    `${apiBase}/api/projects`,
    'POST',
    opts,
    body,
  );
  return unwrapOrThrow(response);
}

/** `PUT /api/projects/:slug` — update a project. */
export async function updateProject(
  apiBase: string,
  slug: string,
  body: Record<string, unknown>,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}`,
    'PUT',
    opts,
    body,
  );
  return unwrapOrThrow(response);
}

/**
 * `PUT /api/projects/order` — persist the explicit sidebar order
 * (station#3315). `order` is the full desired slug order; the server assigns
 * each listed project its index as `position` and returns the sorted list.
 */
export async function reorderProjects(
  apiBase: string,
  order: readonly string[],
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await mutateJson(
    `${apiBase}/api/projects/order`,
    'PUT',
    opts,
    {
      order,
    },
  );
  return unwrapOrThrow(response);
}

/** `DELETE /api/projects/:slug` — delete a project. */
export async function deleteProject(
  apiBase: string,
  slug: string,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}`,
    'DELETE',
    opts,
  );
  return unwrapOrThrow(response);
}

/** `POST /api/projects/:slug/layouts` — create a project layout. */
export async function createProjectLayout(
  apiBase: string,
  projectSlug: string,
  body: Record<string, unknown>,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/layouts`,
    'POST',
    opts,
    body,
  );
  return unwrapOrThrow(response);
}

/** `POST /api/projects/:slug/layouts/apply` — apply a catalog layout safely. */
export async function applyProjectLayout(
  apiBase: string,
  projectSlug: string,
  layoutId: string,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/layouts/apply`,
    'POST',
    opts,
    { layoutId },
  );
  return unwrapOrThrow(response);
}

/**
 * `PUT /api/projects/:slug/layouts/:layoutSlug` — update a project layout.
 * No plain-function or hook equivalent exists in `workspaceProjects.ts`
 * today (the CLI's `projects layouts update` verb builds this request
 * inline) — added here per the #167 plan so the CLI can be migrated to it
 * in Wave 2A without inventing a new capability.
 */
export async function updateProjectLayout(
  apiBase: string,
  projectSlug: string,
  layoutSlug: string,
  body: Record<string, unknown>,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/layouts/${encodeURIComponent(layoutSlug)}`,
    'PUT',
    opts,
    body,
  );
  return unwrapOrThrow(response);
}

/** `DELETE /api/projects/:slug/layouts/:layoutSlug` — delete a project layout. */
export async function deleteProjectLayout(
  apiBase: string,
  projectSlug: string,
  layoutSlug: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/layouts/${encodeURIComponent(layoutSlug)}`,
    'DELETE',
    opts,
  );
  const result = (await readJsonBody(response)) as
    | ProjectEnvelope<never>
    | undefined;
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      envelopeErrorMessage(result, 'Failed to delete layout'),
    );
  }
  if (!result?.success) {
    throw new Error(envelopeErrorMessage(result, 'Failed to delete layout'));
  }
}

/**
 * `POST /api/projects/:slug/layouts/from-plugin` — create a project layout
 * from a plugin-contributed layout template. No plain-function or hook
 * equivalent exists in `workspaceProjects.ts` today (CLI-only, `core.ts`'s
 * `runProjectLayoutCommand`'s `from-plugin` branch) — added here per the
 * #167 plan for the same reason as `updateProjectLayout` above.
 */
export async function createProjectLayoutFromPlugin(
  apiBase: string,
  projectSlug: string,
  plugin: string,
  opts?: ClientRequestOptions,
): Promise<any> {
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(projectSlug)}/layouts/from-plugin`,
    'POST',
    opts,
    { plugin },
  );
  return unwrapOrThrow(response);
}
