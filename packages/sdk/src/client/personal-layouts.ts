/**
 * Canonical fetchers for `/api/me/layouts` — the authenticated caller's own
 * Boards (#2061 for the routes, #2062 for the UI that reads them).
 *
 * A **Board** is a Layout owned by a principal rather than a project
 * (`docs/design/shell-ownership-and-boards.md`, decision D1). The whole
 * authorization model is that there is no owner in any of these URLs: the
 * server resolves the owner from the request's own authentication, so a
 * client cannot address another person's Boards because there is nowhere to
 * write another person into. That is why none of these functions takes a
 * principal, an owner, or a user id — and why a future one must not either.
 *
 * Shaped after `client/projects.ts`'s layout fetchers, which these mirror
 * one-for-one across a different ownership scope.
 */
import type {
  LayoutConfig,
  LayoutMetadata,
} from '@kontourai/station-contracts/layout';
import type { ClientRequestOptions } from './http';
import {
  envelopeErrorMessage,
  getJson,
  mutateJson,
  readJsonBody,
  StationHttpError,
} from './http';
import { unwrapProjectResponse as unwrapOrThrow } from './project-response';

/** The fields a caller may supply when creating a Board. */
export interface PersonalLayoutCreateInput {
  slug: string;
  name: string;
  type?: string;
  icon?: string;
  description?: string;
  config?: Record<string, unknown>;
}

/**
 * The subset a caller may change. The slug is the address, not a field — the
 * server refuses a body that names one, so renaming a Board changes its
 * DISPLAY name and leaves its identity alone.
 */
export type PersonalLayoutUpdateInput = Partial<
  Omit<PersonalLayoutCreateInput, 'slug'>
>;

/** `GET /api/me/layouts` — list the caller's own Boards. */
export async function listPersonalLayouts(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<LayoutMetadata[]> {
  const response = await getJson(`${apiBase}/api/me/layouts`, opts);
  return (await unwrapOrThrow(response)) as LayoutMetadata[];
}

/** `GET /api/me/layouts/:layoutSlug` — read one of the caller's own Boards. */
export async function getPersonalLayout(
  apiBase: string,
  layoutSlug: string,
  opts?: ClientRequestOptions,
): Promise<LayoutConfig> {
  const response = await getJson(
    `${apiBase}/api/me/layouts/${encodeURIComponent(layoutSlug)}`,
    opts,
  );
  return (await unwrapOrThrow(response)) as LayoutConfig;
}

/** `POST /api/me/layouts` — create a Board. A repeated slug answers 409. */
export async function createPersonalLayout(
  apiBase: string,
  body: PersonalLayoutCreateInput,
  opts?: ClientRequestOptions,
): Promise<LayoutConfig> {
  const response = await mutateJson(
    `${apiBase}/api/me/layouts`,
    'POST',
    opts,
    body,
  );
  return (await unwrapOrThrow(response)) as LayoutConfig;
}

/** `PUT /api/me/layouts/:layoutSlug` — patch a Board; omitted fields stay. */
export async function updatePersonalLayout(
  apiBase: string,
  layoutSlug: string,
  body: PersonalLayoutUpdateInput,
  opts?: ClientRequestOptions,
): Promise<LayoutConfig> {
  const response = await mutateJson(
    `${apiBase}/api/me/layouts/${encodeURIComponent(layoutSlug)}`,
    'PUT',
    opts,
    body,
  );
  return (await unwrapOrThrow(response)) as LayoutConfig;
}

/**
 * `POST /api/me/layouts/:layoutSlug/promote` — MOVE a Board into a project,
 * where it becomes that project's Layout (#2062).
 *
 * The caller's own copy is gone when this resolves, and the returned record
 * carries the Board's original `id`. A caller that keeps showing the Board in
 * a personal list after this has a stale cache, not a copy.
 */
export async function promotePersonalLayout(
  apiBase: string,
  layoutSlug: string,
  projectSlug: string,
  opts?: ClientRequestOptions,
): Promise<LayoutConfig> {
  const response = await mutateJson(
    `${apiBase}/api/me/layouts/${encodeURIComponent(layoutSlug)}/promote`,
    'POST',
    opts,
    { projectSlug },
  );
  return (await unwrapOrThrow(response)) as LayoutConfig;
}

/** `DELETE /api/me/layouts/:layoutSlug` — delete one of the caller's Boards. */
export async function deletePersonalLayout(
  apiBase: string,
  layoutSlug: string,
  opts?: ClientRequestOptions,
): Promise<void> {
  const response = await mutateJson(
    `${apiBase}/api/me/layouts/${encodeURIComponent(layoutSlug)}`,
    'DELETE',
    opts,
  );
  const result = (await readJsonBody(response)) as
    | { success?: boolean }
    | undefined;
  if (!response.ok) {
    throw new StationHttpError(
      response.status,
      envelopeErrorMessage(result, 'Failed to delete Board'),
    );
  }
  if (!result?.success) {
    throw new Error(envelopeErrorMessage(result, 'Failed to delete Board'));
  }
}
