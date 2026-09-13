import type {
  WorkspacePaneHostActionCatalog,
  WorkspacePaneHostActionExecution,
  WorkspacePaneHostActionPreparation,
  WorkspacePaneHostActionPrepareRequest,
} from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { WORKSPACE_PANE_HOST_ACTION_UNAVAILABLE_REASONS } from '@kontourai/station-contracts/workspace-pane-host-contribution';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readEnvelopeOrThrow,
} from './http.js';

function hostPath(apiBase: string, projectSlug: string) {
  return `${apiBase}/api/orchestration/pane-host/${encodeURIComponent(projectSlug)}`;
}

export async function getWorkspacePaneHostActions(
  apiBase: string,
  projectSlug: string,
  options?: ClientRequestOptions,
): Promise<WorkspacePaneHostActionCatalog> {
  const response = await getJson(
    `${hostPath(apiBase, projectSlug)}/catalog`,
    options,
  );
  const data =
    await readEnvelopeOrThrow<WorkspacePaneHostActionCatalog>(response);
  if (
    !data ||
    data.projectSlug !== projectSlug ||
    typeof data.complete !== 'boolean' ||
    data.support !== 'supported' ||
    !Array.isArray(data.contributions)
  )
    throw new Error('Workspace action catalog is unavailable.');
  return data;
}

export async function prepareWorkspacePaneHostAction(
  apiBase: string,
  projectSlug: string,
  request: WorkspacePaneHostActionPrepareRequest,
  options?: ClientRequestOptions,
): Promise<WorkspacePaneHostActionPreparation> {
  const data = await readEnvelopeOrThrow<WorkspacePaneHostActionPreparation>(
    await mutateJson(
      `${hostPath(apiBase, projectSlug)}/prepare`,
      'POST',
      options,
      request,
    ),
  );
  if (
    !data ||
    !(
      (data.state === 'prepared' && /^[A-Za-z0-9_-]{43}$/.test(data.ticket)) ||
      (data.state === 'unavailable' &&
        WORKSPACE_PANE_HOST_ACTION_UNAVAILABLE_REASONS.includes(data.reason))
    )
  )
    throw new Error('Workspace action preparation is unavailable.');
  return data;
}

/** Never retries this mutation, including a lost response or spent ticket. */
export async function executeWorkspacePaneHostAction(
  apiBase: string,
  projectSlug: string,
  ticket: string,
  options?: ClientRequestOptions,
): Promise<WorkspacePaneHostActionExecution> {
  try {
    const data = await readEnvelopeOrThrow<WorkspacePaneHostActionExecution>(
      await mutateJson(
        `${hostPath(apiBase, projectSlug)}/execute`,
        'POST',
        options,
        { ticket },
      ),
    );
    if (
      data?.state === 'accepted' &&
      [data.conversationId, data.sessionId, data.turnId].every(
        (id) =>
          typeof id === 'string' &&
          id.length > 0 &&
          id.length <= 256 &&
          [...id].every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
      )
    )
      return data;
    if (
      data?.state === 'unavailable' &&
      WORKSPACE_PANE_HOST_ACTION_UNAVAILABLE_REASONS.includes(data.reason)
    )
      return data;
    return { state: 'indeterminate' };
  } catch {
    return { state: 'indeterminate' };
  }
}
