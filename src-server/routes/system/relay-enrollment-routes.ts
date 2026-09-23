import {
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
} from '@kontourai/station-contracts/relay-enrollment';
import { Hono } from 'hono';
import {
  RelayEnrollmentRefusal,
  type RelayEnrollmentService,
} from '../../services/identity/relay-enrollment-service.js';

/**
 * Internal-only handler factory for the relay fresh-client ceremony.
 * StationRuntime intentionally does not mount this surface until finalize and
 * signed activation ACK are complete.
 */
export function createRelayEnrollmentRoutes(service: RelayEnrollmentService) {
  const app = new Hono();
  const run = async (
    operation: (request: Request) => Promise<unknown>,
    request: Request,
    status: 201 | 202,
  ) => {
    try {
      return Response.json(await operation(request), {
        status,
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      const refusal = error instanceof RelayEnrollmentRefusal;
      const code = refusal
        ? `relay_enrollment_${error.code}`
        : 'relay_enrollment_unavailable';
      const responseStatus = refusal
        ? error.code === 'rate_limited'
          ? 429
          : error.code === 'invalid'
            ? 400
            : error.code === 'expired'
              ? 410
              : error.code === 'approval_required'
                ? 409
                : error.code === 'unsupported'
                  ? 501
                  : 503
        : 503;
      return Response.json(
        { error: { code } },
        { status: responseStatus, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  };
  app.post(RELAY_ENROLLMENT_BEGIN_PATH, (c) =>
    run((request) => service.beginFreshClient(request), c.req.raw, 201),
  );
  app.post(RELAY_ENROLLMENT_LOGIN_PATH, (c) =>
    run((request) => service.loginFreshClient(request), c.req.raw, 202),
  );
  return app;
}
