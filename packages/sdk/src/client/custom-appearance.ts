import type {
  CustomAppearanceDocument,
  CustomAppearanceLibraryDocument,
  CustomAppearanceLibrarySaveInput,
  CustomAppearanceLibraryUpdateInput,
  CustomAppearanceProposalInput,
  CustomAppearanceRenderReport,
  CustomAppearanceSaveInput,
} from '@kontourai/station-contracts/custom-appearance';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { unwrapProjectResponse } from './project-response';

/** The calling person's custom appearance (docs/decisions/custom-appearance.md). */
const path = (apiBase: string) => `${apiBase}/api/me/appearance`;

export async function getCustomAppearance(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceDocument> {
  return unwrapProjectResponse(await getJson(path(apiBase), opts));
}
/** Agents may call this; the person previews and keeps it in Station. */
export async function proposeCustomAppearance(
  apiBase: string,
  input: CustomAppearanceProposalInput,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceDocument> {
  return unwrapProjectResponse(
    await mutateJson(`${path(apiBase)}/proposal`, 'POST', opts, input),
  );
}
/** The person's own save; `appearance: null` turns it off. Refuses agents. */
export async function saveCustomAppearance(
  apiBase: string,
  input: CustomAppearanceSaveInput,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceDocument> {
  return unwrapProjectResponse(
    await mutateJson(path(apiBase), 'PUT', opts, input),
  );
}
export async function keepCustomAppearanceProposal(
  apiBase: string,
  input: { revision: string; proposalId: string },
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceDocument> {
  return unwrapProjectResponse(
    await mutateJson(`${path(apiBase)}/proposal/keep`, 'POST', opts, input),
  );
}
export async function dismissCustomAppearanceProposal(
  apiBase: string,
  revision: string,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceDocument> {
  return unwrapProjectResponse(
    await mutateJson(`${path(apiBase)}/proposal`, 'DELETE', opts, { revision }),
  );
}
export async function reportCustomAppearanceRender(
  apiBase: string,
  report: Omit<CustomAppearanceRenderReport, 'reportedAt'>,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceDocument> {
  return unwrapProjectResponse(
    await mutateJson(`${path(apiBase)}/proposal/report`, 'POST', opts, report),
  );
}

/** 404 means the host is older or Appearance Studio is disabled. */
export async function getCustomAppearanceLibrary(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceLibraryDocument> {
  return unwrapProjectResponse(await getJson(`${path(apiBase)}/library`, opts));
}
export async function saveCustomAppearanceLibraryTheme(
  apiBase: string,
  input: CustomAppearanceLibrarySaveInput,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceLibraryDocument> {
  return unwrapProjectResponse(
    await mutateJson(`${path(apiBase)}/library`, 'POST', opts, input),
  );
}
export async function updateCustomAppearanceLibraryTheme(
  apiBase: string,
  input: CustomAppearanceLibraryUpdateInput,
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceLibraryDocument> {
  return unwrapProjectResponse(
    await mutateJson(`${path(apiBase)}/library`, 'PATCH', opts, input),
  );
}
export async function removeCustomAppearanceLibraryTheme(
  apiBase: string,
  input: { revision: string; id: string },
  opts?: ClientRequestOptions,
): Promise<CustomAppearanceLibraryDocument> {
  return unwrapProjectResponse(
    await mutateJson(`${path(apiBase)}/library`, 'DELETE', opts, input),
  );
}
