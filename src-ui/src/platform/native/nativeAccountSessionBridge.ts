import {
  APPLICATION_SESSION_NATIVE_REVOKE_PATH,
  type NativeApplicationSessionContinuationV1,
  type NativeApplicationSessionRevocation,
} from '@kontourai/station-contracts/application-session';
import type { ProjectInvitationAcceptance } from '@kontourai/station-contracts/project-membership';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  NativeApplicationSessionClient,
  type NativeApplicationSessionProofProvider,
  type NativeApplicationSessionTrustSnapshotV1,
  type NativeLocalAccountCredentials,
} from '@kontourai/station-sdk/application-session-native';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { z } from 'zod';
import type { TauriInvoker } from './nativeRelaySignalingBridge';
import { invokeTauri } from './tauriInvoke';

const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const publicKey = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: opaque,
    y: opaque,
  })
  .strict();
const surface = z
  .object({
    kind: z.literal('station-native'),
    appIdentifier: z.string().min(1).max(255),
    channel: z.enum(['dev', 'stable', 'beta', 'nightly']),
    clientInstanceId: z.string().uuid(),
    keyThumbprint: opaque,
  })
  .strict();
const target = z
  .object({
    kind: z.literal('station-native'),
    stationId: z.string().uuid(),
    audience: z.string().url(),
    surface,
  })
  .strict();
const preparedSchema = z
  .object({
    version: z.literal('station-native-account-operation/v1'),
    accountContextHandle: opaque,
    contextExpiresAtMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .refine((value) => Number.isFinite(new Date(value).getTime())),
    publicKey,
    target,
    deviceId: z.string().uuid(),
    body: z
      .object({
        version: z.literal('station.application-session-native/v1'),
        publicKey,
      })
      .strict(),
  })
  .strict();
const accountHeaders = z
  .object({
    'X-Station-Native-Account-Continuation': opaque,
    'X-Station-Native-Account-Proof': z.string().min(1).max(4096),
  })
  .strict();
const exchangePrepared = z
  .object({
    body: z
      .object({
        version: z.literal('station.application-session-native/v1'),
        challengeId: opaque,
        credentials: z
          .object({
            username: z.string().min(3).max(32),
            password: z.string().min(1).max(128),
          })
          .strict(),
        proof: z.string().min(1).max(4096),
      })
      .strict(),
    headers: z
      .object({ 'X-Station-Native-Account-Proof': z.string().min(1).max(4096) })
      .strict(),
  })
  .strict();
const invitationPrepared = z
  .object({
    body: z.object({ token: opaque }).strict(),
    headers: accountHeaders,
  })
  .strict();
const invitationAcceptance = z
  .object({
    scope: z
      .object({
        stationId: z.string().uuid(),
        localProjectId: z.string().min(1).max(128),
        localProjectSlug: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
        portableProjectId: z.string().min(1).max(512),
      })
      .strict(),
    grantsDeviceAccess: z.literal(false),
  })
  .strict();
const revocationPrepared = z
  .object({ body: z.object({}).strict(), headers: accountHeaders })
  .strict();
const INVITATION_PATH = '/api/account-auth/accept-invitation';
const RESPONSE_LIMIT = 64 * 1024;

/** Producer supplied by the verified native peer/ICE owner; this interface mints no authority. */
export interface NativeAccountApplicationOwner {
  readonly origin: string;
  readonly scope: SelfHostedBrokerNativeScopeV2;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  fetch(
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response>;
  assertCurrent(): Promise<void>;
  isCurrent(): boolean;
}
export interface NativeAccountPublicScope {
  readonly instanceId: string;
  readonly generation: number;
  readonly authorityKey: string;
  readonly principal: NativeApplicationSessionContinuationV1['principal'];
  readonly deviceId: string;
  readonly target: NativeApplicationSessionContinuationV1['target'];
  readonly keyThumbprint: string;
  readonly expiresAt: string;
}
const defaultInvoker: TauriInvoker = {
  invoke: (command, args) => invokeTauri<unknown>(command, args),
};
function sameSurface(
  a: SelfHostedBrokerNativeClientSurfaceV2,
  b: SelfHostedBrokerNativeClientSurfaceV2,
): boolean {
  return (
    a.kind === b.kind &&
    a.appIdentifier === b.appIdentifier &&
    a.channel === b.channel &&
    a.clientInstanceId === b.clientInstanceId &&
    a.keyThumbprint === b.keyThumbprint
  );
}
async function readBounded(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('native_account_response_missing');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT)
        throw new Error('native_account_response_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const result: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
  );
  if (!response.ok)
    throw Object.assign(new Error('native_account_http_refused'), {
      status: response.status,
    });
  return result;
}

export async function createNativeAccountSessionBridge(input: {
  profileName: string;
  expectedProfileRevision: number;
  signal: AbortSignal;
  application: NativeAccountApplicationOwner;
  invoke?: TauriInvoker;
}) {
  const profileName = input.profileName,
    revision = input.expectedProfileRevision,
    application = input.application,
    signal = input.signal,
    invoke = input.invoke ?? defaultInvoker;
  let contextExpiresAtMs: number | undefined;
  let retired = false,
    generation = 0,
    busy = false;
  let continuation: NativeApplicationSessionContinuationV1 | undefined;
  let projection: NativeAccountPublicScope | null = null;
  const listeners = new Set<() => void>();
  const instanceId = randomCorrelationId();
  const assertCurrent = async () => {
    signal.throwIfAborted();
    if (
      retired ||
      !application.isCurrent() ||
      (contextExpiresAtMs !== undefined && Date.now() >= contextExpiresAtMs)
    )
      throw new Error('native_account_scope_retired');
    await application.assertCurrent();
    signal.throwIfAborted();
    if (
      retired ||
      !application.isCurrent() ||
      (contextExpiresAtMs !== undefined && Date.now() >= contextExpiresAtMs)
    )
      throw new Error('native_account_scope_retired');
  };
  await assertCurrent();
  const prepared = preparedSchema.parse(
    await invoke.invoke('station_native_account_challenge_prepare', {
      profileName,
      expectedProfileRevision: revision,
    }),
  );
  contextExpiresAtMs = prepared.contextExpiresAtMs;
  await assertCurrent();
  if (
    prepared.target.audience !== application.origin ||
    prepared.target.stationId !== application.scope.stationId ||
    !sameSurface(prepared.target.surface, application.surface) ||
    JSON.stringify(prepared.publicKey) !==
      JSON.stringify(prepared.body.publicKey)
  )
    throw new Error('native_account_prepared_owner_mismatch');
  const trust: NativeApplicationSessionTrustSnapshotV1 = Object.freeze({
    ...prepared.target,
    deviceId: prepared.deviceId,
    surface: Object.freeze({ ...prepared.target.surface }),
  });
  const host: NativeApplicationSessionProofProvider = {
    kind: 'station-native-host-proof-provider/v1',
    contextExpiresAtMs: prepared.contextExpiresAtMs,
    publicKey: prepared.publicKey,
    async prepareExchange(args) {
      await assertCurrent();
      const result = await invoke.invoke(
        'station_native_account_exchange_prepare',
        { accountContextHandle: prepared.accountContextHandle, ...args },
      );
      await assertCurrent();
      return exchangePrepared.parse(result);
    },
    async requestHeaders(args) {
      await assertCurrent();
      const result = await invoke.invoke(
        'station_native_account_request_headers',
        { accountContextHandle: prepared.accountContextHandle, ...args },
      );
      await assertCurrent();
      return accountHeaders.parse(result);
    },
    async prepareRevocation(args) {
      await assertCurrent();
      const result = await invoke.invoke(
        'station_native_account_revoke_prepare',
        {
          accountContextHandle: prepared.accountContextHandle,
          ...args,
        },
      );
      await assertCurrent();
      return revocationPrepared.parse(result);
    },
    async prepareInvitationAcceptance(args) {
      await assertCurrent();
      const result = await invoke.invoke(
        'station_native_account_accept_invitation_prepare',
        { accountContextHandle: prepared.accountContextHandle, ...args },
      );
      await assertCurrent();
      return invitationPrepared.parse(result);
    },
  };
  const client = new NativeApplicationSessionClient(
    {
      async post(request) {
        await assertCurrent();
        const response = await application.fetch(
          `${application.origin}${request.path}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...request.headers },
            body: JSON.stringify(request.body),
            signal,
          },
        );
        const result = await readBounded(response, signal);
        await assertCurrent();
        return z.object({ data: z.unknown() }).strict().parse(result).data;
      },
    },
    () => {
      if (retired || !application.isCurrent())
        throw new Error('native_account_scope_retired');
      return trust;
    },
    host,
  );
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const retire = () => {
    if (retired) return;
    retired = true;
    continuation = undefined;
    projection = null;
    generation++;
    notify();
  };
  signal.addEventListener('abort', retire, { once: true });
  return {
    async login(
      credentials: NativeLocalAccountCredentials,
    ): Promise<NativeAccountPublicScope> {
      if (busy || continuation)
        throw new Error('native_account_login_pending_or_ready');
      busy = true;
      try {
        await assertCurrent();
        const accepted = await client.exchange({
          username: credentials.username,
          password: credentials.password,
        });
        await assertCurrent();
        continuation = accepted;
        generation++;
        projection = Object.freeze({
          instanceId,
          generation,
          authorityKey: accepted.authorityKey,
          principal: Object.freeze({ ...accepted.principal }),
          deviceId: accepted.deviceId,
          target: Object.freeze({
            ...accepted.target,
            surface: Object.freeze({ ...accepted.target.surface }),
          }),
          keyThumbprint: accepted.keyThumbprint,
          expiresAt: accepted.expiresAt,
        });
        notify();
        return projection;
      } finally {
        busy = false;
      }
    },
    current(): NativeAccountPublicScope | null {
      return !retired &&
        !signal.aborted &&
        application.isCurrent() &&
        projection &&
        Date.parse(projection.expiresAt) > Date.now()
        ? projection
        : null;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async requestHeaders(request: { method: 'GET' | 'HEAD'; path: string }) {
      await assertCurrent();
      if (!continuation) throw new Error('native_account_login_required');
      const retained = continuation;
      const result = await client.headers(retained, request);
      await assertCurrent();
      if (continuation !== retained)
        throw new Error('native_account_scope_retired');
      return result;
    },
    async acceptInvitation(
      token: string,
    ): Promise<ProjectInvitationAcceptance> {
      await assertCurrent();
      if (!continuation) throw new Error('native_account_login_required');
      const retained = continuation;
      const acceptance = await client.prepareInvitationAcceptance(
        retained,
        token,
      );
      await assertCurrent();
      const response = await application.fetch(
        `${application.origin}${INVITATION_PATH}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...acceptance.headers,
          },
          body: JSON.stringify(acceptance.body),
          signal,
        },
      );
      const result = await readBounded(response, signal);
      await assertCurrent();
      if (continuation !== retained)
        throw new Error('native_account_scope_retired');
      const accepted = z
        .object({ data: invitationAcceptance })
        .strict()
        .parse(result).data;
      if (accepted.scope.stationId !== prepared.target.stationId)
        throw new Error('native_account_membership_owner_mismatch');
      return accepted;
    },
    async logout(): Promise<NativeApplicationSessionRevocation> {
      await assertCurrent();
      if (busy || !continuation)
        throw new Error('native_account_login_required');
      busy = true;
      const retained = continuation;
      try {
        const revocation = await client.prepareRevocation(retained);
        await assertCurrent();
        if (continuation !== retained)
          throw new Error('native_account_scope_retired');
        continuation = undefined;
        projection = null;
        generation++;
        for (const listener of listeners) listener();
        const response = await application.fetch(
          `${application.origin}${APPLICATION_SESSION_NATIVE_REVOKE_PATH}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...revocation.headers,
            },
            body: JSON.stringify(revocation.body),
            signal,
          },
        );
        const result = await readBounded(response, signal);
        await assertCurrent();
        return z
          .object({ data: z.object({ revoked: z.literal(true) }).strict() })
          .strict()
          .parse(result).data;
      } finally {
        busy = false;
        retire();
      }
    },
    retire,
  };
}
