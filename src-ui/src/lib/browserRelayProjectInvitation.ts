import type { SavedConnection } from '@kontourai/station-connect';
import { ACCOUNT_AUTHENTICATION_FAILURE_HEADER } from '@kontourai/station-contracts/application-session';
import { createBrowserRelayApplicationCredential } from './browserRelayApplicationAuthority';
import { captureBrowserRelayRoute } from './browserRelayRouteBinding';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new Error('Invitation cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

async function boundedJson(response: Response, signal: AbortSignal) {
  if (!response.body) throw new Error('Station invitation response is empty.');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let used = 0;
  let abortRead: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortRead = () => {
      void reader.cancel().catch(() => {});
      reject(signal.reason ?? new Error('Invitation request cancelled'));
    };
    signal.addEventListener('abort', abortRead!, { once: true });
    if (signal.aborted) abortRead();
  });
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await Promise.race([reader.read(), cancelled]);
      signal.throwIfAborted();
      if (item.done) break;
      used += item.value.byteLength;
      if (used > bytes.byteLength)
        throw new Error('Station invitation response is too large.');
      bytes.set(item.value, used - item.value.byteLength);
    }
    return JSON.parse(
      new TextDecoder().decode(bytes.subarray(0, used)),
    ) as unknown;
  } finally {
    if (abortRead) signal.removeEventListener('abort', abortRead);
    void reader.cancel().catch(() => {});
  }
}

/** Accept one Project invitation through the selected Station's encrypted account channel. */
export async function acceptBrowserRelayProjectInvitation(input: {
  connection: SavedConnection;
  token: string;
  signal?: AbortSignal;
}): Promise<{ projectSlug: string }> {
  const route = input.connection.brokerRoute;
  if (!route || !TOKEN.test(input.token))
    throw new Error('Enter a valid Project invitation token.');
  const binding = captureBrowserRelayRoute(
    input.connection.id,
    input.connection.url,
    route,
  );
  if (!binding?.isCurrent())
    throw new Error('Reconnect to this Station before joining its Project.');
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timeout = setTimeout(
    () => controller.abort(new Error('Station invitation request timed out')),
    REQUEST_TIMEOUT_MS,
  );
  try {
    const authority = await abortable(
      createBrowserRelayApplicationCredential({
        connectionId: input.connection.id,
        applicationOrigin: input.connection.url,
        route,
        transport: binding.transport,
        routeIsCurrent: binding.isCurrent,
      }),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (
      !binding.isCurrent() ||
      !authority.transport ||
      !authority.transportBindingIsCurrent?.()
    )
      throw new Error('An approved Station account and Device are required.');
    const response = await abortable(
      authority.transport(
        `${input.connection.url}/api/account-auth/accept-invitation`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: window.location.origin,
          },
          body: JSON.stringify({ token: input.token }),
          credentials: 'omit',
          signal: controller.signal,
        },
      ),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (response.status === 401) {
      if (
        response.headers.get(ACCOUNT_AUTHENTICATION_FAILURE_HEADER) ===
        'account'
      )
        await abortable(
          Promise.resolve(authority.onAccountUnauthorized?.()),
          controller.signal,
        );
      else
        await abortable(
          Promise.resolve(authority.onUnauthorized?.()),
          controller.signal,
        );
    }
    const body = await boundedJson(response, controller.signal);
    if (!response.ok) {
      const code =
        record(body) &&
        record(body.error) &&
        typeof body.error.code === 'string'
          ? body.error.code
          : `HTTP ${response.status}`;
      throw new Error(`Station refused the Project invitation: ${code}.`);
    }
    if (
      !record(body) ||
      !record(body.data) ||
      body.data.grantsDeviceAccess !== false ||
      !record(body.data.scope) ||
      body.data.scope.stationId !== route.scope.stationId ||
      typeof body.data.scope.localProjectSlug !== 'string' ||
      !body.data.scope.localProjectSlug
    )
      throw new Error('Station did not confirm this Project membership.');
    if (!binding.isCurrent() || !authority.transportBindingIsCurrent())
      throw new Error(
        'The selected Station authority changed during invitation acceptance.',
      );
    return { projectSlug: body.data.scope.localProjectSlug };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}
