import {
  NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH,
  NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_CANCEL_PATH,
  NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH,
  NATIVE_RELAY_ENROLLMENT_LOGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_REGISTER_PATH,
  NATIVE_RELAY_ENROLLMENT_STATUS_PATH,
} from '@kontourai/station-contracts/native-relay-enrollment';
import { Hono } from 'hono';
import { z } from 'zod';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { nativeEnrollmentCandidateSchema } from '../../services/identity/native-relay-enrollment-schema.js';
import {
  NativeRelayEnrollmentRefusal,
  type NativeRelayEnrollmentService,
} from '../../services/identity/native-relay-enrollment-service.js';

const CODES = {
  invalid: 'native_enrollment_invalid',
  expired: 'native_enrollment_expired',
  unsupported: 'native_enrollment_unsupported',
  unavailable: 'native_enrollment_unavailable',
  approval_required: 'native_enrollment_approval_required',
  operator_required: 'operator_required',
  replayed: 'native_enrollment_replayed',
  busy: 'native_enrollment_busy',
} as const;
function refusal(error: unknown): Response {
  if (!(error instanceof NativeRelayEnrollmentRefusal))
    return Response.json(
      { error: { code: 'native_enrollment_unavailable' } },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  const status =
    error.code === 'operator_required'
      ? 403
      : error.code === 'unsupported'
        ? 501
        : error.code === 'expired'
          ? 410
          : error.code === 'busy' || error.code === 'approval_required'
            ? 409
            : error.code === 'unavailable'
              ? 503
              : 400;
  return Response.json(
    { error: { code: CODES[error.code] } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** Exactly seven POST leaves; every call mints its private Pion bootstrap capability first. */
export function createNativeRelayEnrollmentRoutes(
  service: NativeRelayEnrollmentService,
) {
  const app = new Hono();
  const paths = [
    NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
    NATIVE_RELAY_ENROLLMENT_LOGIN_PATH,
    NATIVE_RELAY_ENROLLMENT_REGISTER_PATH,
    NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH,
    NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH,
    NATIVE_RELAY_ENROLLMENT_STATUS_PATH,
    NATIVE_RELAY_ENROLLMENT_CANCEL_PATH,
  ] as const;
  for (const path of paths)
    app.post(path, async (context) => {
      try {
        const cap = service.capability(context.req.raw);
        const result =
          path === NATIVE_RELAY_ENROLLMENT_BEGIN_PATH
            ? await service.begin(cap)
            : path === NATIVE_RELAY_ENROLLMENT_LOGIN_PATH
              ? await service.login(cap)
              : path === NATIVE_RELAY_ENROLLMENT_REGISTER_PATH
                ? await service.login(cap, true)
                : path === NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH
                  ? await service.finalize(cap)
                  : path === NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH
                    ? await service.activate(cap)
                    : await service.status(
                        cap,
                        path === NATIVE_RELAY_ENROLLMENT_CANCEL_PATH,
                      );
        return Response.json(result, {
          status: 200,
          headers: { 'Cache-Control': 'no-store' },
        });
      } catch (error) {
        return refusal(error);
      }
    });
  return app;
}

/** Mounted only under the existing exact operator access-management policy. */
export function createNativeRelayEnrollmentOperatorRoutes(
  service: NativeRelayEnrollmentService,
) {
  const app = new Hono();
  app.get('/', (context) => {
    try {
      return Response.json(
        { data: service.pendingApprovals(context.req.raw) },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      return refusal(error);
    }
  });
  app.post('/:enrollmentId/approve', async (context) => {
    try {
      service.assertOperator(context.req.raw);
      const raw = await readBoundedRequestBody(context.req.raw, 4096);
      if (raw.status !== 'ok')
        throw new NativeRelayEnrollmentRefusal('invalid');
      const body = z
        .object({ candidate: nativeEnrollmentCandidateSchema })
        .strict()
        .parse(JSON.parse(raw.body));
      await service.approve(
        context.req.raw,
        context.req.param('enrollmentId'),
        body.candidate,
      );
      return Response.json(
        { data: { state: 'approved' } },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    } catch (error) {
      return refusal(error);
    }
  });
  return app;
}
