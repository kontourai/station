import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  type HostedTenantRegistry,
  parseHostedTenantRegistry,
  type TenantExecutionContext,
  type TenantRequestContext,
  tenantExecutionContextFromRequest,
} from '@kontourai/station-contracts/tenancy';
import {
  tenantExecutionContextAttributes,
  tenantExecutionContextOutcomes,
} from '../../telemetry/metrics.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_TENANT_HEADER,
  isTrustedInternalApiToken,
} from '../../utils/internal-api-token.js';

export const HOSTED_TENANT_REGISTRY_FILE_ENV =
  'STATION_HOSTED_TENANT_REGISTRY_FILE';

/** Whether this process is configured as a hosted tenant-isolated runtime. */
export function isHostedTenantExecutionRequired(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment[HOSTED_TENANT_REGISTRY_FILE_ENV] !== undefined;
}

const contexts = new WeakMap<Request, TenantRequestContext>();
const executionContexts = new AsyncLocalStorage<TenantExecutionContext>();

/** Reads immutable deployment configuration once during runtime boot. */
export function loadHostedTenantRegistryFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): HostedTenantRegistry | undefined {
  const file = environment[HOSTED_TENANT_REGISTRY_FILE_ENV];
  if (file === undefined) return undefined;
  if (!file || file !== file.trim() || !isAbsolute(file)) {
    throw new Error(
      `${HOSTED_TENANT_REGISTRY_FILE_ENV} must name a regular file`,
    );
  }
  let raw: string;
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not regular');
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `${HOSTED_TENANT_REGISTRY_FILE_ENV} must name a readable regular file`,
    );
  }
  try {
    return parseHostedTenantRegistry(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Invalid hosted tenant registry: ${error instanceof Error ? error.message : 'invalid JSON'}`,
    );
  }
}

/** Getter-only request context; only the verified ingress middleware writes it. */
export function getTenantRequestContext(
  request: Request,
): TenantRequestContext | undefined {
  return contexts.get(request);
}

/** Convert trusted execution authority into the sole internal tenant header. */
export function internalTenantHeaderForExecutionContext(
  context: TenantExecutionContext | undefined,
): Record<string, string> {
  return context ? { [INTERNAL_TENANT_HEADER]: context.tenantId } : {};
}

export function tenantExecutionContextForRequest(
  request: Request,
): TenantExecutionContext | undefined {
  const context = getTenantRequestContext(request);
  return context ? tenantExecutionContextFromRequest(context) : undefined;
}

/** Current host-owned execution authority, scoped to one async call chain. */
export function currentTenantExecutionContext():
  | TenantExecutionContext
  | undefined {
  return executionContexts.getStore();
}

/** Capture the single-operator deployment boundary and still reject later hosted or request-scoped execution. */
export function createPersonalRuntimeRequestGuard(): (
  request: Request,
) => boolean {
  const personalAtConstruction = !isHostedTenantExecutionRequired();
  return (request) =>
    personalAtConstruction &&
    !isHostedTenantExecutionRequired() &&
    getTenantRequestContext(request) === undefined &&
    currentTenantExecutionContext() === undefined;
}

export function withTenantExecutionContext<T>(
  context: TenantExecutionContext | undefined,
  operation: () => T,
): T {
  return context === undefined
    ? operation()
    : executionContexts.run(context, operation);
}

export function createHostedTenantMiddleware(
  registry: HostedTenantRegistry,
  options: { bypass?: (request: Request) => boolean } = {},
) {
  return async (
    c: {
      env: unknown;
      req: { raw: Request; header: (name: string) => string | undefined };
      json: (value: unknown, status: number) => Response;
    },
    next: () => Promise<void>,
  ): Promise<Response | undefined> => {
    if (options.bypass?.(c.req.raw)) {
      await next();
      return undefined;
    }
    const tenantId = c.req.header(INTERNAL_TENANT_HEADER);
    const token = c.req.header(INTERNAL_API_TOKEN_HEADER);
    const tenant = registry.tenants.find((entry) => entry.id === tenantId);
    if (
      !isLoopbackEnvironment(c.env) ||
      !isTrustedInternalApiToken(token) ||
      !tenantId ||
      tenantId.length > 64 ||
      !tenant
    ) {
      tenantExecutionContextOutcomes.add(
        1,
        tenantExecutionContextAttributes({
          operation: 'bind',
          source: 'none',
          outcome: 'rejected',
          reason: !tenantId ? 'missing' : 'unknown',
        }),
      );
      return c.json({ error: { code: 'tenant_context_required' } }, 421);
    }
    const requestContext = Object.freeze({ tenantId: tenant.id });
    contexts.set(c.req.raw, requestContext);
    tenantExecutionContextOutcomes.add(
      1,
      tenantExecutionContextAttributes({
        operation: 'bind',
        source: 'request',
        outcome: 'accepted',
        reason: 'none',
      }),
    );
    await withTenantExecutionContext(
      tenantExecutionContextFromRequest(requestContext),
      next,
    );
    return undefined;
  };
}

function isLoopbackEnvironment(environment: unknown): boolean {
  if (!environment || typeof environment !== 'object') return false;
  const incoming = (
    environment as { incoming?: { socket?: { remoteAddress?: unknown } } }
  ).incoming;
  const address = incoming?.socket?.remoteAddress;
  if (typeof address !== 'string') return false;
  const normalized = address.trim().toLowerCase();
  return (
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('::ffff:127.')
  );
}
