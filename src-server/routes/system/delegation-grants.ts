import { Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  COMMAND_NOT_GRANTED_CODE,
  isOperatorInPersonNotAgent,
} from '../../security/coding-authority.js';
import {
  type DelegationGrantStore,
  delegationGrantSettingsSchema,
  isHighRiskDelegationGitPath,
} from '../../security/confinement/delegation-grants.js';
import {
  FeaturePreviewDisabledError,
  requireFeaturePreview,
} from '../../services/feature-previews/feature-preview-refusal.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';

class DelegationGrantWriteRefused extends Error {}

const operatorRefusal = {
  success: false as const,
  code: COMMAND_NOT_GRANTED_CODE,
  error: 'Delegation grant settings require the operator.',
};

export function createDelegationGrantRoutes(
  store: DelegationGrantStore,
  preview: FeaturePreviewSelector,
  isRequestPrincipalCurrent: (request: Request) => boolean,
  childrenOf?: (grantId: string) => string[],
  postureOf?: (sessionId: string) => unknown,
) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    assertCurrent(c.req.raw);
    await next();
  });

  function assertCurrent(request: Request) {
    requireFeaturePreview(preview, 'delegation-grants', 'Delegation grants');
    if (
      !isOperatorInPersonNotAgent(request) ||
      !isRequestPrincipalCurrent(request)
    )
      throw new DelegationGrantWriteRefused();
  }

  app.onError((error, c) => {
    if (error instanceof FeaturePreviewDisabledError) {
      return c.json(error.refusal, 404);
    }
    if (error instanceof DelegationGrantWriteRefused) {
      return c.json(operatorRefusal, 403);
    }
    throw error;
  });

  app.get('/', (c) => {
    const grants = store.readActive();
    if (!grants) {
      return c.json(
        {
          success: false,
          error:
            'Delegation grants could not be read. Standing grants are disabled.',
        },
        503,
      );
    }
    return c.json({
      success: true,
      data: grants.map((grant) => ({
        ...grant,
        highRiskGitWrites: Object.values(grant.extraGitWritePaths)
          .flat()
          .some(isHighRiskDelegationGitPath),
        children: childrenOf?.(grant.id) ?? [],
      })),
    });
  });
  app.get('/sessions/:id', (c) =>
    c.json({ success: true, data: postureOf?.(c.req.param('id')) ?? null }),
  );

  app.post('/', async (c) => {
    const body = await readBoundedRequestBody(c.req.raw, 64 * 1024);
    if (body.status === 'too-large') {
      return c.json(
        { success: false, error: 'Delegation grant settings are too large.' },
        413,
      );
    }
    let input: unknown;
    if (body.status === 'ok') {
      try {
        input = JSON.parse(body.body);
      } catch {
        return c.json({ success: false, error: 'Invalid JSON.' }, 400);
      }
    }
    const settings = delegationGrantSettingsSchema.safeParse(input);
    if (!settings.success) {
      return c.json(
        {
          success: false,
          error:
            settings.error.issues[0]?.message ??
            'Invalid delegation grant settings.',
        },
        400,
      );
    }
    const data = await store.create(settings.data, () =>
      assertCurrent(c.req.raw),
    );
    return c.json({ success: true, data }, 201);
  });

  app.delete('/:id', async (c) => {
    const revoked = await store.revoke(c.req.param('id'), () =>
      assertCurrent(c.req.raw),
    );
    if (!revoked) {
      return c.json(
        { success: false, error: 'Delegation grant not found.' },
        404,
      );
    }
    return c.json({ success: true, data: { revoked } });
  });

  return app;
}
