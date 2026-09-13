import { envelopeErrorMessage, readJsonBody, StationHttpError } from './http';

export interface ProjectEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
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
export async function unwrapProjectResponse<T = any>(
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
