/** Versioned deployment registry for the first hosted Station boundary. */
export const HOSTED_TENANT_REGISTRY_SCHEMA_VERSION = 1 as const;
export const HOSTED_TENANT_REGISTRY_MAX_TENANTS = 128;

declare const tenantIdBrand: unique symbol;
const sessionReadAuthorityBrand: unique symbol = Symbol(
  'StationSessionReadAuthority',
);
declare const internalSessionReadScopeBrand: unique symbol;
export type TenantId = string & { readonly [tenantIdBrand]: 'TenantId' };

export interface TenantRegistryEntry {
  id: TenantId;
  /** Canonical exact DNS authority, including an explicit port when configured. */
  authority: string;
}

export interface HostedTenantRegistry {
  schemaVersion: typeof HOSTED_TENANT_REGISTRY_SCHEMA_VERSION;
  tenants: readonly TenantRegistryEntry[];
  /** Plain, serialization-safe projection for the UI ingress process. */
  authorityToTenant: Readonly<Record<string, TenantId>>;
}

export interface TenantRequestContext {
  readonly tenantId: TenantId;
}

/**
 * Server-owned tenant authority carried after ingress.  This is deliberately
 * distinct from the request-only context: a token, model option, tool input,
 * or public command payload cannot manufacture it.
 */
export interface TenantExecutionContext {
  readonly tenantId: TenantId;
  readonly source: 'request' | 'session' | 'operator';
}

/**
 * Required authority for every externally reachable session-derived read.
 *
 * The branded member deliberately prevents a route from treating a parsed
 * body or a collection of plain strings as authority. Construct it only with
 * `sessionReadAuthorityFromRequest`, which preserves request provenance.
 * Tenant context remains internal; it is never a public payload field.
 */
export interface SessionReadAuthority {
  readonly userId: string;
  readonly tenantExecutionContext: TenantExecutionContext | undefined;
  readonly mode: 'hosted' | 'personal';
  readonly [sessionReadAuthorityBrand]: 'SessionReadAuthority';
}

/**
 * Explicit token for process-wide, non-request aggregate reads. Public read
 * methods must require `SessionReadAuthority` instead of making it optional.
 */
export interface InternalSessionReadScope {
  readonly kind: 'internal-session-read-aggregate';
  readonly [internalSessionReadScopeBrand]: 'InternalSessionReadScope';
}

/**
 * A named, immutable scope for an intentionally aggregate internal operation.
 * It is distinct from request authority and cannot be manufactured from an
 * omitted request argument.
 */
export const INTERNAL_SESSION_READ_SCOPE: InternalSessionReadScope =
  Object.freeze({
    kind: 'internal-session-read-aggregate' as const,
  }) as InternalSessionReadScope;

/**
 * Mints request-scoped read authority from a server-verified request context
 * and the already-loaded deployment registry. The registry, not a caller
 * flag, determines whether hosted isolation is required. A missing context in
 * hosted mode intentionally remains representable so later policy can fail
 * closed without changing a public read signature back to optional.
 */
export function sessionReadAuthorityFromRequest(
  userId: string,
  requestContext: TenantRequestContext | undefined,
  hostedTenantRegistry: HostedTenantRegistry | undefined,
): SessionReadAuthority {
  const hosted = hostedTenantRegistry !== undefined;
  if (
    hosted &&
    requestContext &&
    !hostedTenantRegistry.tenants.some(
      (tenant) => tenant.id === requestContext.tenantId,
    )
  ) {
    throw new Error('Unknown hosted tenant read authority');
  }
  return Object.freeze({
    [sessionReadAuthorityBrand]: 'SessionReadAuthority' as const,
    userId,
    tenantExecutionContext: requestContext
      ? tenantExecutionContextFromRequest(requestContext)
      : undefined,
    mode: hosted ? 'hosted' : 'personal',
  }) as SessionReadAuthority;
}

/** Runtime guard paired with the opaque compile-time brand. */
export function isSessionReadAuthority(
  value: unknown,
): value is SessionReadAuthority {
  return (
    typeof value === 'object' &&
    value !== null &&
    sessionReadAuthorityBrand in value &&
    (value as Record<PropertyKey, unknown>)[sessionReadAuthorityBrand] ===
      'SessionReadAuthority'
  );
}

export function isHostedSessionReadAuthority(
  authority: SessionReadAuthority,
): boolean {
  return authority.mode === 'hosted';
}

/** Strict persistence parser; malformed session state never becomes authority. */
export function parseTenantExecutionContext(
  value: unknown,
): TenantExecutionContext | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tenantId', 'source'])) {
    return undefined;
  }
  if (
    typeof value.tenantId !== 'string' ||
    (value.source !== 'request' &&
      value.source !== 'session' &&
      value.source !== 'operator')
  ) {
    return undefined;
  }
  try {
    return Object.freeze({
      tenantId: tenantId(value.tenantId),
      source: value.source,
    });
  } catch {
    return undefined;
  }
}

/** Create execution authority only from the context installed by ingress. */
export function tenantExecutionContextFromRequest(
  context: TenantRequestContext,
): TenantExecutionContext {
  return Object.freeze({ tenantId: context.tenantId, source: 'request' });
}

/**
 * Preserve an existing server-owned binding across session continuation or
 * recovery.  The new provenance states that the authority came from the
 * session record, never from a new command payload.
 */
export function tenantExecutionContextFromSession(
  context: TenantExecutionContext,
): TenantExecutionContext {
  return Object.freeze({ tenantId: context.tenantId, source: 'session' });
}

/** Explicit operator binding is valid only for a registry tenant. */
export function tenantExecutionContextFromOperator(
  registry: HostedTenantRegistry,
  value: string,
): TenantExecutionContext {
  const tenant = registry.tenants.find((entry) => entry.id === value);
  if (!tenant) throw new Error('Unknown hosted tenant execution context');
  return Object.freeze({ tenantId: tenant.id, source: 'operator' });
}

const TENANT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function tenantId(value: string): TenantId {
  if (!TENANT_ID_PATTERN.test(value)) {
    throw new Error('Invalid hosted tenant ID');
  }
  return value as TenantId;
}

/**
 * Canonicalizes a DNS authority without applying URL semantics. Explicit
 * ports remain explicit and therefore differ from an authority without one.
 */
export function canonicalTenantAuthority(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 320 ||
    /[/?#@[\]\\,\s*]/.test(value) ||
    value.includes('://')
  ) {
    throw new Error('Invalid hosted tenant authority');
  }
  const colon = value.indexOf(':');
  if (colon !== value.lastIndexOf(':')) {
    throw new Error('Invalid hosted tenant authority');
  }
  const host = (colon < 0 ? value : value.slice(0, colon)).toLowerCase();
  const port = colon < 0 ? undefined : value.slice(colon + 1);
  if (
    !host ||
    host.length > 253 ||
    host.endsWith('.') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    !host.split('.').every((label) => DNS_LABEL_PATTERN.test(label))
  ) {
    throw new Error('Invalid hosted tenant authority');
  }
  if (port !== undefined) {
    if (
      !/^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/.test(
        port,
      )
    ) {
      throw new Error('Invalid hosted tenant authority');
    }
    return `${host}:${port}`;
  }
  return host;
}

/** Strict parser for untrusted JSON deployment input. */
export function parseHostedTenantRegistry(
  input: unknown,
): HostedTenantRegistry {
  if (!isRecord(input) || !hasOnlyKeys(input, ['schemaVersion', 'tenants'])) {
    throw new Error('Invalid hosted tenant registry');
  }
  if (
    input.schemaVersion !== HOSTED_TENANT_REGISTRY_SCHEMA_VERSION ||
    !Array.isArray(input.tenants) ||
    input.tenants.length === 0 ||
    input.tenants.length > HOSTED_TENANT_REGISTRY_MAX_TENANTS
  ) {
    throw new Error('Invalid hosted tenant registry');
  }
  const ids = new Set<string>();
  const authorities = new Set<string>();
  const entries: TenantRegistryEntry[] = [];
  const authorityToTenant: Record<string, TenantId> = Object.create(null);
  for (const rawEntry of input.tenants) {
    if (
      !isRecord(rawEntry) ||
      !hasOnlyKeys(rawEntry, ['id', 'authority']) ||
      typeof rawEntry.id !== 'string' ||
      typeof rawEntry.authority !== 'string'
    ) {
      throw new Error('Invalid hosted tenant registry');
    }
    const id = tenantId(rawEntry.id);
    const authority = canonicalTenantAuthority(rawEntry.authority);
    if (ids.has(id) || authorities.has(authority)) {
      throw new Error('Duplicate hosted tenant registry entry');
    }
    ids.add(id);
    authorities.add(authority);
    entries.push(Object.freeze({ id, authority }));
    authorityToTenant[authority] = id;
  }
  return Object.freeze({
    schemaVersion: HOSTED_TENANT_REGISTRY_SCHEMA_VERSION,
    tenants: Object.freeze(entries),
    authorityToTenant: Object.freeze(authorityToTenant),
  });
}

export function resolveHostedTenant(
  registry: HostedTenantRegistry,
  authority: string,
): TenantId | undefined {
  return registry.authorityToTenant[canonicalTenantAuthority(authority)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}
