import { createHash } from 'node:crypto';
import type {
  NativeDeviceBindingCandidateV1,
  NativeDeviceProofBindingReadbackV1,
} from '@kontourai/station-contracts/native-device-proof';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import {
  type NativeDeviceProofApprovalTuple,
  NativeDeviceProofBindingError,
  NativeDeviceProofBindingService,
  NativeDeviceProofOperatorAuthority,
} from '../../services/ssh/native-device-proof-binding-service.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SURFACE_KEYS =
  'appIdentifier,channel,clientInstanceId,keyThumbprint,kind';
const JWK_KEYS = 'crv,kty,x,y';
const MAX_BODY_BYTES = 4096;
const READBACK_VERSION =
  'station-native-device-proof-binding-readback/v1' as const;

export interface NativeDeviceProofBindingRouteDeps {
  readonly bindings: NativeDeviceProofBindingService;
  readonly operatorAuthority: NativeDeviceProofOperatorAuthority;
  readonly security: Pick<
    EnvironmentSecurityService,
    'verifyOperatorCredential' | 'authorizeCredential' | 'resolveGrantedScope'
  >;
}

class InvalidRequest extends Error {}

async function readBoundedJson(context: Context): Promise<unknown> {
  const result = await readBoundedRequestBody(context.req.raw, MAX_BODY_BYTES);
  if (result.status !== 'ok') throw new InvalidRequest();
  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    throw new InvalidRequest();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join(',') === keys;
}

function parseCandidate(value: unknown): NativeDeviceBindingCandidateV1 {
  if (
    !record(value) ||
    !exactKeys(
      value,
      'bindingId,deviceId,deviceProofJwk,deviceProofKeyThumbprint,stationId,surface,version',
    ) ||
    value.version !== 'station-native-device-binding-candidate/v1' ||
    typeof value.stationId !== 'string' ||
    value.stationId.length < 1 ||
    value.stationId.length > 512 ||
    typeof value.deviceId !== 'string' ||
    value.deviceId.length < 1 ||
    value.deviceId.length > 512 ||
    typeof value.bindingId !== 'string' ||
    !UUID_V4.test(value.bindingId) ||
    typeof value.deviceProofKeyThumbprint !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.deviceProofKeyThumbprint) ||
    !record(value.surface) ||
    !exactKeys(value.surface, SURFACE_KEYS) ||
    value.surface.kind !== 'station-native' ||
    typeof value.surface.appIdentifier !== 'string' ||
    (value.surface.channel !== 'dev' &&
      value.surface.channel !== 'nightly' &&
      value.surface.channel !== 'beta' &&
      value.surface.channel !== 'stable') ||
    typeof value.surface.clientInstanceId !== 'string' ||
    typeof value.surface.keyThumbprint !== 'string' ||
    !record(value.deviceProofJwk) ||
    !exactKeys(value.deviceProofJwk, JWK_KEYS) ||
    value.deviceProofJwk.kty !== 'EC' ||
    value.deviceProofJwk.crv !== 'P-256' ||
    typeof value.deviceProofJwk.x !== 'string' ||
    typeof value.deviceProofJwk.y !== 'string'
  ) {
    throw new InvalidRequest();
  }
  const jwk: NativeDeviceBindingCandidateV1['deviceProofJwk'] = {
    kty: value.deviceProofJwk.kty,
    crv: value.deviceProofJwk.crv,
    x: value.deviceProofJwk.x,
    y: value.deviceProofJwk.y,
  };
  const recomputed = createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
  if (recomputed !== value.deviceProofKeyThumbprint) throw new InvalidRequest();
  return {
    version: value.version,
    stationId: value.stationId,
    deviceId: value.deviceId,
    bindingId: value.bindingId,
    surface: {
      kind: value.surface.kind,
      appIdentifier: value.surface.appIdentifier,
      channel: value.surface.channel,
      clientInstanceId: value.surface.clientInstanceId,
      keyThumbprint: value.surface.keyThumbprint,
    },
    deviceProofJwk: jwk,
    deviceProofKeyThumbprint: value.deviceProofKeyThumbprint,
  };
}

function parseBody(value: unknown): {
  operation: 'create' | 'revoke';
  candidate: NativeDeviceBindingCandidateV1;
} {
  if (
    !record(value) ||
    !exactKeys(value, 'candidate,operation') ||
    (value.operation !== 'create' && value.operation !== 'revoke')
  ) {
    throw new InvalidRequest();
  }
  return {
    operation: value.operation,
    candidate: parseCandidate(value.candidate),
  };
}

function currentOperator(
  request: Request,
  deps: NativeDeviceProofBindingRouteDeps,
): boolean {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (
    principal?.authority !== 'operator-credential' ||
    !deps.security.verifyOperatorCredential(principal.credential)
  )
    return false;
  return isRuntimeRequestPrincipalCurrent(request, deps.security);
}

function publicReadback(
  binding: ReturnType<NativeDeviceProofBindingService['bindingById']>,
  current: boolean,
): NativeDeviceProofBindingReadbackV1 | null {
  if (!binding) return null;
  return {
    version: READBACK_VERSION,
    binding: {
      stationId: binding.stationId,
      deviceId: binding.deviceId,
      bindingId: binding.bindingId,
      surface: binding.surface,
      deviceProofJwk: binding.deviceProof.jwk,
      deviceProofKeyThumbprint: binding.deviceProof.thumbprint,
      state: binding.state,
      createdAt: binding.createdAt,
      approvedAt: binding.approvedAt,
      ...(binding.revokedAt === undefined
        ? {}
        : { revokedAt: binding.revokedAt }),
      ...(binding.revocationReason === undefined
        ? {}
        : { revocationReason: binding.revocationReason }),
    },
    currentDeviceBinding: current,
  };
}

type RouteStatus = 400 | 403 | 404 | 409 | 503;

function serviceStatus(error: unknown): RouteStatus {
  if (!(error instanceof NativeDeviceProofBindingError)) return 503;
  if (
    error.code === 'store_unavailable' ||
    error.code === 'station_unavailable'
  )
    return 503;
  if (error.code === 'operator_unauthorized') return 403;
  if (error.code === 'binding_not_found') return 404;
  if (
    error.code === 'binding_id_conflict' ||
    error.code === 'operator_approval_reused'
  )
    return 409;
  return 400;
}

export function createNativeDeviceProofBindingRoutes(
  deps: NativeDeviceProofBindingRouteDeps,
) {
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/:bindingId', (context) => {
    if (!currentOperator(context.req.raw, deps))
      return context.json({ error: { code: 'operator_required' } }, 403);
    const bindingId = context.req.param('bindingId');
    if (!UUID_V4.test(bindingId))
      return context.json({ error: { code: 'invalid_request' } }, 400);
    try {
      const binding = deps.bindings.bindingById({ bindingId });
      if (!binding) return context.json({ error: { code: 'not_found' } }, 404);
      const current = deps.bindings.currentBinding({
        deviceId: binding.deviceId,
        surface: binding.surface,
      });
      return context.json({
        data: publicReadback(binding, current?.binding.bindingId === bindingId),
      });
    } catch {
      return context.json({ error: { code: 'unavailable' } }, 503);
    }
  });

  app.post('/:bindingId/approve', async (context) => {
    if (!currentOperator(context.req.raw, deps))
      return context.json({ error: { code: 'operator_required' } }, 403);
    let operation: 'create' | 'revoke';
    let candidate: NativeDeviceBindingCandidateV1;
    try {
      ({ operation, candidate } = parseBody(await readBoundedJson(context)));
    } catch {
      return context.json({ error: { code: 'invalid_request' } }, 400);
    }
    const pathBindingId = context.req.param('bindingId');
    if (!UUID_V4.test(pathBindingId) || candidate.bindingId !== pathBindingId)
      return context.json({ error: { code: 'invalid_request' } }, 400);
    if (!currentOperator(context.req.raw, deps))
      return context.json({ error: { code: 'operator_required' } }, 403);
    const tuple: NativeDeviceProofApprovalTuple = {
      operation,
      stationId: candidate.stationId,
      deviceId: candidate.deviceId,
      bindingId: candidate.bindingId,
      surface: candidate.surface,
      jwk: candidate.deviceProofJwk,
    };
    try {
      const approval = deps.operatorAuthority.approve({
        operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
        tuple,
      });
      if (!currentOperator(context.req.raw, deps))
        return context.json({ error: { code: 'operator_required' } }, 403);
      const binding =
        operation === 'create'
          ? deps.bindings.createBinding({
              bindingId: candidate.bindingId,
              deviceId: candidate.deviceId,
              surface: candidate.surface,
              jwk: candidate.deviceProofJwk,
              approval,
            })
          : deps.bindings.revokeBinding({
              bindingId: candidate.bindingId,
              deviceId: candidate.deviceId,
              surface: candidate.surface,
              jwk: candidate.deviceProofJwk,
              approval,
            })[0];
      const historical = deps.bindings.bindingById({
        bindingId: candidate.bindingId,
      });
      if (!historical)
        throw new NativeDeviceProofBindingError('store_unavailable');
      const current = deps.bindings.currentBinding({
        deviceId: historical.deviceId,
        surface: historical.surface,
      });
      return context.json({
        data: publicReadback(
          historical,
          current?.binding.bindingId === binding.bindingId,
        ),
      });
    } catch (error) {
      const status = serviceStatus(error);
      return context.json(
        {
          error: {
            code:
              status === 503
                ? 'unavailable'
                : status === 404
                  ? 'not_found'
                  : status === 409
                    ? 'conflict'
                    : status === 403
                      ? 'operator_required'
                      : 'invalid_request',
          },
        },
        status,
      );
    }
  });
  return app;
}
