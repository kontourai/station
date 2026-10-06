import { Hono } from 'hono';
import { z } from 'zod';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import {
  NativeSurfaceOperatorAuthority,
  type NativeSurfaceRegistry,
} from '../../services/connections/native-surface-registry.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';

interface NativeRelaySurfaceRouteDependencies {
  registry: NativeSurfaceRegistry;
  security: Pick<
    EnvironmentSecurityService,
    'verifyOperatorCredential' | 'authorizeCredential' | 'resolveGrantedScope'
  >;
}
const mutation = z
  .object({ operation: z.enum(['approve', 'revoke']), tuple: z.unknown() })
  .strict();

/** Caller mounts under the ordinary operator route policy; no public registration endpoint. */
export function createNativeRelaySurfaceRoutes(
  deps: NativeRelaySurfaceRouteDependencies,
) {
  const app = new Hono();
  const authority = new NativeSurfaceOperatorAuthority();
  const currentOperator = (request: Request) => {
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    return (
      principal?.authority === 'operator-credential' &&
      deps.security.verifyOperatorCredential(principal.credential) &&
      isRuntimeRequestPrincipalCurrent(request, deps.security)
    );
  };
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (!currentOperator(context.req.raw))
      return context.json({ error: { code: 'operator_required' } }, 403);
    await next();
  });
  app.get('/', (context) => {
    try {
      return context.json({
        data: deps.registry
          .approvedSurfaces()
          .map(({ approvalId, revision, scope, surface }) => ({
            approvalId,
            revision,
            scope,
            surface,
          })),
      });
    } catch {
      return context.json({ error: { code: 'unavailable' } }, 503);
    }
  });
  app.post('/', async (context) => {
    const bounded = await readBoundedRequestBody(context.req.raw, 4096);
    if (bounded.status !== 'ok')
      return context.json({ error: { code: 'invalid_request' } }, 400);
    let parsed: z.infer<typeof mutation>;
    try {
      parsed = mutation.parse(JSON.parse(bounded.body));
    } catch {
      return context.json({ error: { code: 'invalid_request' } }, 400);
    }
    if (!currentOperator(context.req.raw))
      return context.json({ error: { code: 'operator_required' } }, 403);
    let approval: ReturnType<NativeSurfaceOperatorAuthority['approve']>;
    try {
      approval = authority.approve(
        LOCAL_OPERATOR_PRINCIPAL_ID,
        parsed.operation,
        parsed.tuple,
      );
    } catch {
      return context.json({ error: { code: 'invalid_request' } }, 400);
    }
    if (!currentOperator(context.req.raw))
      return context.json({ error: { code: 'operator_required' } }, 403);
    try {
      if (parsed.operation === 'revoke') {
        deps.registry.revoke(approval);
        return context.json({ data: { state: 'revoked' } });
      }
      const { approvalId, revision, scope, surface } =
        deps.registry.approve(approval);
      return context.json({ data: { approvalId, revision, scope, surface } });
    } catch (error) {
      if (error instanceof Error && error.message === 'native_surface_revoked')
        return context.json({ error: { code: 'native_surface_revoked' } }, 409);
      if (error instanceof Error && error.message === 'native_surface_capacity')
        return context.json(
          { error: { code: 'native_surface_capacity' } },
          409,
        );
      return context.json({ error: { code: 'unavailable' } }, 503);
    }
  });
  return app;
}
