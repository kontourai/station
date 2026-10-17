import type {
  PersonalBoardDocument,
  PersonalBoardProposalInput,
  PersonalBoardSaveInput,
} from '@kontourai/station-contracts/personal-board';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { unwrapProjectResponse } from './project-response';

const path = (apiBase: string, slug: string) =>
  `${apiBase}/api/me/boards/${encodeURIComponent(slug)}`;
export async function getPersonalBoard(
  apiBase: string,
  slug: string,
  opts?: ClientRequestOptions,
): Promise<PersonalBoardDocument> {
  return unwrapProjectResponse(await getJson(path(apiBase, slug), opts));
}
export async function proposePersonalBoard(
  apiBase: string,
  slug: string,
  input: PersonalBoardProposalInput,
  opts?: ClientRequestOptions,
): Promise<PersonalBoardDocument> {
  return unwrapProjectResponse(
    await mutateJson(`${path(apiBase, slug)}/proposal`, 'POST', opts, input),
  );
}
export async function savePersonalBoard(
  apiBase: string,
  slug: string,
  input: PersonalBoardSaveInput,
  opts?: ClientRequestOptions,
): Promise<PersonalBoardDocument> {
  return unwrapProjectResponse(
    await mutateJson(path(apiBase, slug), 'PUT', opts, input),
  );
}
export async function dismissPersonalBoardProposal(
  apiBase: string,
  slug: string,
  revision: string,
  opts?: ClientRequestOptions,
): Promise<PersonalBoardDocument> {
  return unwrapProjectResponse(
    await mutateJson(`${path(apiBase, slug)}/proposal`, 'DELETE', opts, {
      revision,
    }),
  );
}
