import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  type UnattendedGrantStore,
  UnattendedGrantStoreUnavailableError,
  UnattendedGrantValidationError,
} from '../../services/agents/unattended-grant-store.js';
import type { Logger } from '../../utils/logger.js';
import {
  getBody,
  unattendedGrantMutationSchema,
  validate,
} from '../schemas/schemas.js';

type OperatorIdentityForRequest = (context: Context) => string | undefined;

/**
 * Operator management routes for exact unattended-tool grants (station#2037).
 *
 * The runtime authentication boundary gates this complete family to
 * `access:manage`, including remote paired-device operators. The supplied
 * identity resolver is intentionally derived from that request's authenticated
 * operator-authority context, never request data: an unattended principal must
 * not be able to record itself as the grantor.
 */
export function createUnattendedGrantRoutes(
  store: UnattendedGrantStore,
  options: {
    operatorIdentityForRequest: OperatorIdentityForRequest;
    logger?: Pick<Logger, 'warn'>;
  },
) {
  const app = new Hono();

  const unavailable = (error: UnattendedGrantStoreUnavailableError) => {
    options.logger?.warn('Unattended grant store unavailable', {
      error: error.message,
    });
    return { success: false, error: 'Unattended grant store unavailable' };
  };

  const requireOperator = (c: Context) =>
    options.operatorIdentityForRequest(c) || undefined;

  app.get('/', (c) => {
    if (!requireOperator(c)) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }
    try {
      return c.json({ success: true, data: store.listGrants() });
    } catch (error) {
      if (error instanceof UnattendedGrantStoreUnavailableError) {
        return c.json(unavailable(error), 503);
      }
      throw error;
    }
  });

  app.post('/', validate(unattendedGrantMutationSchema), async (c) => {
    const grantedBy = requireOperator(c);
    if (!grantedBy) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }
    const body = getBody(c) as { principalKey: string; toolName: string };
    try {
      // grantTool returns the exact receipt it commits. Do not read the store
      // after a successful mutation: a later read failure must not report a
      // committed authority grant as a failed request.
      const receipt = await store.grantTool(
        body.principalKey,
        body.toolName,
        grantedBy,
      );
      return c.json({ success: true, data: receipt });
    } catch (error) {
      if (error instanceof UnattendedGrantValidationError) {
        return c.json({ success: false, error: error.message }, 400);
      }
      if (error instanceof UnattendedGrantStoreUnavailableError) {
        return c.json(unavailable(error), 503);
      }
      throw error;
    }
  });

  app.post('/revoke', validate(unattendedGrantMutationSchema), async (c) => {
    if (!requireOperator(c)) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }
    const body = getBody(c) as { principalKey: string; toolName: string };
    try {
      await store.revokeGrant(body.principalKey, body.toolName);
      return c.json({ success: true });
    } catch (error) {
      if (error instanceof UnattendedGrantValidationError) {
        return c.json({ success: false, error: error.message }, 400);
      }
      if (error instanceof UnattendedGrantStoreUnavailableError) {
        return c.json(unavailable(error), 503);
      }
      throw error;
    }
  });

  return app;
}
