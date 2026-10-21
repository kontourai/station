/** Bounded initial external-client surface; this grants no execution takeover. */
export const STATION_CONTROL_EXTERNAL_CLIENT_TOOLS = [
  'read_conversation',
  'board_read',
  'board_pin',
] as const;

export type StationControlExternalClientTool =
  (typeof STATION_CONTROL_EXTERNAL_CLIENT_TOOLS)[number];

export function isStationControlExternalClientTool(
  value: unknown,
): value is StationControlExternalClientTool {
  return STATION_CONTROL_EXTERNAL_CLIENT_TOOLS.some((name) => name === value);
}

export interface StationControlExternalClientRequest {
  sessionId: string;
  allowedTools: readonly StationControlExternalClientTool[];
  ttlSeconds: number;
}

/** The configuration contains a scoped secret; never print it in diagnostics. */
export interface StationControlExternalClientLease {
  leaseId: string;
  sessionId: string;
  project: { id: string; slug: string };
  allowedTools: readonly StationControlExternalClientTool[];
  expiresAt: string;
  /** Recorded context/revocation group, not evidence that an engine is active. */
  lifetime: 'process-and-session-bound';
  config: { url: string; headers: { Authorization: string } };
}

/** Untrusted response parsing for clients that persist the returned secret. */
export function parseStationControlExternalClientLease(
  value: unknown,
): StationControlExternalClientLease | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.leaseId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(v.leaseId) ||
    typeof v.sessionId !== 'string' ||
    !v.sessionId ||
    typeof v.expiresAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.expiresAt) ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    v.lifetime !== 'process-and-session-bound' ||
    !Array.isArray(v.allowedTools) ||
    !v.allowedTools.length ||
    new Set(v.allowedTools).size !== v.allowedTools.length ||
    !v.allowedTools.every(isStationControlExternalClientTool)
  )
    return undefined;
  if (
    !v.project ||
    typeof v.project !== 'object' ||
    Array.isArray(v.project) ||
    !v.config ||
    typeof v.config !== 'object' ||
    Array.isArray(v.config)
  )
    return undefined;
  const project = v.project as Record<string, unknown>;
  const config = v.config as Record<string, unknown>;
  if (
    typeof project.id !== 'string' ||
    !project.id ||
    typeof project.slug !== 'string' ||
    !project.slug ||
    typeof config.url !== 'string' ||
    !config.headers ||
    typeof config.headers !== 'object' ||
    Array.isArray(config.headers)
  )
    return undefined;
  const headers = config.headers as Record<string, unknown>;
  if (
    typeof headers.Authorization !== 'string' ||
    !/^Bearer [A-Za-z0-9_-]{43}$/.test(headers.Authorization) ||
    Object.keys(headers).some((key) => key !== 'Authorization')
  )
    return undefined;
  return {
    leaseId: v.leaseId,
    sessionId: v.sessionId,
    expiresAt: v.expiresAt,
    lifetime: v.lifetime,
    project: { id: project.id, slug: project.slug },
    allowedTools: v.allowedTools,
    config: {
      url: config.url,
      headers: { Authorization: headers.Authorization },
    },
  };
}
