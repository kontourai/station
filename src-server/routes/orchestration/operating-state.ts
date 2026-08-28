/**
 * Console `OperatingState` + board-intent routes (roadmap archive#586, part of
 * epic archive#580, S6). Mounted at `/api/projects/:slug/operating-state`, mirroring
 * `routes/work-items.ts`'s project-scoped route seam.
 */
import type { ConsoleAction } from '@kontourai/console-core';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import { resolveAndExecuteStationBoardIntent } from '../../capabilities/station-board-intent.js';
import {
  createStationHostIntentBindings,
  type StationIntent,
  type StationIntentBindingDeps,
} from '../../capabilities/station-intent-bindings.js';
import {
  getTenantRequestContext,
  loadHostedTenantRegistryFromEnvironment,
} from '../../runtime/bootstrap/runtime-tenant-context.js';
import type { OperatingStateService } from '../../services/infra/operating-state-service.js';
import { errorMessage } from '../schemas/schemas.js';
import { getCachedUser } from '../system/auth.js';

type IncomingBoardIntent = StationIntent & Pick<ConsoleAction, 'id' | 'kind'>;

export interface OperatingStateRouteDeps {
  /** Resolve a project slug to its workspace path (workingDirectory). */
  getWorkspacePath: (slug: string) => string | undefined;
  /** Runtime-composed request authority; direct construction has a safe fallback. */
  getSessionReadAuthority?: (request: Request) => SessionReadAuthority;
  intentBindingDeps: StationIntentBindingDeps;
}

interface BoardIntentRequestBody {
  intent?: unknown;
  consent?: unknown;
}

/** Minimal runtime shape gate on untrusted JSON input — only checks the two
 * fields this route itself branches on (`id`/`kind`); every deeper field
 * (`authority`, `subjectRefs`, ...) is untrusted input that
 * `resolveIntentBinding`/each binding's own `validatedSubjectId` choke
 * point (see `station-intent-bindings.ts`) is responsible for validating,
 * never this route. */
function asIncomingBoardIntent(value: unknown): IncomingBoardIntent | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as Record<string, unknown>).id !== 'string' ||
    typeof (value as Record<string, unknown>).kind !== 'string'
  ) {
    return null;
  }
  return value as unknown as IncomingBoardIntent;
}

/**
 * Hosted mode exposes exactly one otherwise board-local operation: resume a
 * Station session. This gate validates the authority and subject shape; the
 * central session read below still owns persisted owner and tenant authority.
 */
function sessionResumeSubjectId(
  intent: IncomingBoardIntent,
): string | undefined {
  const authority = (intent as { authority?: unknown }).authority;
  if (
    typeof authority !== 'object' ||
    authority === null ||
    (authority as Record<string, unknown>).product !== 'station' ||
    (authority as Record<string, unknown>).command !== 'session resume'
  ) {
    return undefined;
  }
  const subject = intent.subjectRefs?.[0];
  if (
    subject?.product !== 'station' ||
    subject.kind !== 'session' ||
    typeof subject.id !== 'string' ||
    subject.id.length === 0
  ) {
    return undefined;
  }
  return subject.id;
}

export function createOperatingStateRoutes(
  operatingStateService: OperatingStateService,
  deps: OperatingStateRouteDeps,
) {
  const app = new Hono<{ Variables: { cwd: string; slug: string } }>();
  const hostedTenantRegistry = loadHostedTenantRegistryFromEnvironment();
  const readAuthorityFor =
    deps.getSessionReadAuthority ??
    ((request: Request) =>
      sessionReadAuthorityFromRequest(
        getCachedUser().alias,
        getTenantRequestContext(request),
        hostedTenantRegistry,
      ));
  const hostedRequest = (request: Request) =>
    isHostedSessionReadAuthority(readAuthorityFor(request));
  const hostedNotFound = (c: Context) =>
    c.json({ success: false, error: 'Operating state not found' }, 404);

  app.use('*', async (c, next) => {
    const slug = c.req.param('slug') ?? '';
    const cwd = deps.getWorkspacePath(slug);
    if (!cwd) {
      return c.json(
        { success: false, error: `Project workspace not found: ${slug}` },
        404,
      );
    }
    c.set('cwd', cwd);
    c.set('slug', slug);
    await next();
  });

  app.get('/', async (c) => {
    // Operating state and its board task actions project global local state.
    // Hosted callers must not cause a read or an intent-resolution side effect.
    if (hostedRequest(c.req.raw)) return hostedNotFound(c);
    try {
      const data = operatingStateService.deriveOperatingState(
        c.get('cwd'),
        c.get('slug'),
      );
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/availability', async (c) => {
    if (hostedRequest(c.req.raw)) return hostedNotFound(c);
    return c.json({
      success: true,
      data: {
        hasBuilderRun: operatingStateService.hasBuilderRun(c.get('cwd')),
      },
    });
  });

  app.post('/intent', async (c) => {
    const requestAuthority = readAuthorityFor(c.req.raw);
    const hosted = isHostedSessionReadAuthority(requestAuthority);
    // A hosted request without attested tenant context cannot establish the
    // one narrow exception below; reject before even parsing its body.
    if (hosted && !requestAuthority.tenantExecutionContext) {
      return hostedNotFound(c);
    }
    let body: BoardIntentRequestBody;
    try {
      body = await c.req.json<BoardIntentRequestBody>();
    } catch {
      if (hosted) return hostedNotFound(c);
      return c.json({ success: false, error: 'Invalid JSON body' }, 400);
    }
    const intent = asIncomingBoardIntent(body.intent);
    if (!intent) {
      if (hosted) return hostedNotFound(c);
      return c.json(
        { success: false, error: "'intent' must be an object with {id, kind}" },
        400,
      );
    }
    // Hosted project/task state remains unavailable. Let only the exact
    // session-resume authority and subject shape reach the established binder,
    // which reconstructs fresh authority again at execution.
    if (hosted) {
      const threadId = sessionResumeSubjectId(intent);
      if (!threadId) return hostedNotFound(c);
      // Keep the HTTP result truthful and non-enumerating: malformed,
      // missing, and cross-tenant sessions never reach the generic board
      // executor, whose void execute contract cannot distinguish a no-op.
      const readable =
        await deps.intentBindingDeps.orchestrationService.readSession(
          threadId,
          requestAuthority,
        );
      if (!readable) return hostedNotFound(c);
    }
    // Strict boolean only — anything else (including a truthy non-boolean)
    // is treated as "no consent supplied", never coerced to true.
    const consent = body.consent === true ? true : undefined;

    try {
      const bindings = createStationHostIntentBindings(deps.intentBindingDeps);
      const data = await resolveAndExecuteStationBoardIntent(
        intent,
        consent,
        bindings,
      );
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
