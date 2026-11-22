import type {
  CustomAppearanceDocument,
  CustomAppearanceProposalInput,
  CustomAppearanceRenderReport,
  CustomAppearanceSaveInput,
} from '@kontourai/station-contracts/custom-appearance';
import { type ClientRequestOptions, mutateJson } from './http';
import { unwrapProjectResponse } from './project-response';

const path = (apiBase: string) => `${apiBase}/api/me/appearance`;

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
