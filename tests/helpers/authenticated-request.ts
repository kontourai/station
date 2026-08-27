import type { APIRequestContext, APIResponse } from '@playwright/test';
import { test as base } from '@playwright/test';
import { e2eOperatorAuthorizationHeaders } from './e2e-operator-credential';

type RequestOptions = Parameters<APIRequestContext['fetch']>[1];

export interface AuthenticatedE2ERequest {
  delete(url: string, options?: RequestOptions): Promise<APIResponse>;
  get(url: string, options?: RequestOptions): Promise<APIResponse>;
  patch(url: string, options?: RequestOptions): Promise<APIResponse>;
  post(url: string, options?: RequestOptions): Promise<APIResponse>;
  put(url: string, options?: RequestOptions): Promise<APIResponse>;
}

function allowedOrigins(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    [env.PW_BASE_URL, env.PW_API_BASE_URL]
      .filter((value): value is string => Boolean(value))
      .map((value) => new URL(value).origin),
  );
}

export function createAuthenticatedE2ERequest(
  request: APIRequestContext,
  env: NodeJS.ProcessEnv = process.env,
): AuthenticatedE2ERequest {
  const origins = allowedOrigins(env);
  const uiBase = env.PW_BASE_URL;
  const authorization = e2eOperatorAuthorizationHeaders(
    env.STATION_E2E_HOST_CREDENTIAL,
  );
  const call = (
    method: 'delete' | 'get' | 'patch' | 'post' | 'put',
    url: string,
    options: RequestOptions = {},
  ) => {
    const resolved = new URL(url, uiBase);
    if (
      resolved.username ||
      resolved.password ||
      !origins.has(resolved.origin)
    ) {
      throw new Error(
        `Authenticated E2E request refused unowned origin ${resolved.origin}`,
      );
    }
    const headers = new Headers(options.headers);
    headers.set('Authorization', authorization.Authorization);
    return request[method](url, {
      ...options,
      headers: Object.fromEntries(headers.entries()),
    });
  };
  return {
    delete: (url, options) => call('delete', url, options),
    get: (url, options) => call('get', url, options),
    patch: (url, options) => call('patch', url, options),
    post: (url, options) => call('post', url, options),
    put: (url, options) => call('put', url, options),
  };
}

export function authenticatedE2EFetch(
  input: string | URL,
  init: RequestInit = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Response> {
  const resolved = new URL(input);
  if (
    resolved.username ||
    resolved.password ||
    !allowedOrigins(env).has(resolved.origin)
  ) {
    throw new Error(
      `Authenticated E2E fetch refused unowned origin ${resolved.origin}`,
    );
  }
  const headers = new Headers(init.headers);
  headers.set(
    'Authorization',
    e2eOperatorAuthorizationHeaders(env.STATION_E2E_HOST_CREDENTIAL)
      .Authorization,
  );
  return fetch(resolved, { ...init, headers });
}

export const test = base.extend<{
  authenticatedRequest: AuthenticatedE2ERequest;
}>({
  authenticatedRequest: async ({ request }, use) => {
    await use(createAuthenticatedE2ERequest(request));
  },
});

export { expect } from '@playwright/test';
