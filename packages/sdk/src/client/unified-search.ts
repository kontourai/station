import {
  UNIFIED_SEARCH_V1,
  type UnifiedSearchOpenLocator,
  type UnifiedSearchOpenResolution,
  type UnifiedSearchRequest,
  type UnifiedSearchResponse,
} from '@kontourai/station-contracts/unified-search';
import {
  type ApiRequestScope,
  type ClientRequestOptions,
  isApiRequestScope,
  mutateJson,
} from './http';

export type UnifiedSearchRequestOptions = ClientRequestOptions & {
  requestScope: ApiRequestScope;
};

export class UnifiedSearchRequestError extends Error {
  readonly kind: 'unsupported' | 'unavailable';
  constructor(readonly status: number) {
    super('Unified search unavailable');
    this.kind =
      status === 404 || status === 405 ? 'unsupported' : 'unavailable';
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 4096;
function keys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}
const kinds = [
  'project',
  'task',
  'session',
  'message',
  'file',
  'output',
  'run',
  'evidence',
  'receipt',
  'contribution',
];
function scope(value: unknown) {
  return (
    record(value) &&
    keys(value, ['projectId', 'taskId', 'sessionId']) &&
    Object.values(value).every(text)
  );
}
function intent(value: unknown) {
  if (!record(value)) return false;
  if (value.kind === 'task')
    return (
      keys(value, ['kind', 'taskId', 'projectId']) &&
      text(value.taskId) &&
      text(value.projectId)
    );
  if (value.kind === 'session-message')
    return (
      keys(value, ['kind', 'sessionId', 'messageId', 'matchedEventId']) &&
      text(value.sessionId) &&
      text(value.messageId) &&
      (value.matchedEventId === undefined || text(value.matchedEventId))
    );
  if (value.kind === 'console-projection')
    return (
      keys(value, ['kind', 'projectionId', 'resourceId']) &&
      text(value.projectionId) &&
      text(value.resourceId)
    );
  return (
    value.kind === 'station-resource' &&
    keys(value, ['kind', 'resourceKind', 'resourceId', 'scope']) &&
    kinds.includes(String(value.resourceKind)) &&
    value.resourceKind !== 'task' &&
    value.resourceKind !== 'message' &&
    text(value.resourceId) &&
    (value.scope === undefined || scope(value.scope))
  );
}
function currentness(value: unknown) {
  if (!record(value) || !text(value.observedAt)) return false;
  if (['current', 'missing', 'external-live'].includes(String(value.state)))
    return keys(value, ['state', 'observedAt']);
  if (value.state === 'stale')
    return keys(value, ['state', 'observedAt', 'reason']) && text(value.reason);
  return (
    value.state === 'superseded' &&
    keys(value, ['state', 'observedAt', 'replacementId']) &&
    (value.replacementId === undefined || text(value.replacementId))
  );
}
const reasons = [
  'authorization-restricted',
  'continuation-invalid',
  'result-window',
  'source-partial',
  'source-stale',
  'source-unavailable',
  'aggregate-byte-limit',
  'provider-response-invalid',
  'provider-timeout-or-error',
  'search-cancelled',
];
const sourceStates = [
  'available',
  'stale',
  'partial',
  'restricted',
  'unavailable',
];
function resolution(value: unknown): value is UnifiedSearchOpenResolution {
  if (!record(value)) return false;
  if (value.state === 'not-found' || value.state === 'unavailable')
    return Object.keys(value).length === 1;
  if (
    value.state !== 'resolved' ||
    !record(value.target) ||
    Object.keys(value).length !== 2
  )
    return false;
  const target = value.target;
  if (target.kind === 'task')
    return (
      Object.keys(target).length === 3 &&
      text(target.projectId) &&
      text(target.taskId)
    );
  const keys =
    target.kind === 'session'
      ? ['kind', 'sessionId', 'projectId']
      : [
          'kind',
          'sessionId',
          'matchedEventId',
          'navigationMessageId',
          'projectId',
        ];
  return (
    (target.kind === 'session' || target.kind === 'session-message') &&
    Object.keys(target).every((key) => keys.includes(key)) &&
    text(target.sessionId) &&
    (target.projectId === undefined || text(target.projectId)) &&
    (target.kind === 'session' ||
      (text(target.matchedEventId) && text(target.navigationMessageId)))
  );
}
function response(value: unknown): value is UnifiedSearchResponse {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) => !['version', 'state', 'results', 'sources'].includes(key),
    ) ||
    value.version !== UNIFIED_SEARCH_V1 ||
    !['complete', 'partial', 'restricted', 'unavailable', 'stale'].includes(
      String(value.state),
    ) ||
    !Array.isArray(value.results) ||
    value.results.length > 64 ||
    !Array.isArray(value.sources) ||
    value.sources.length > 8
  )
    return false;
  const owner = (value: unknown) =>
    record(value) &&
    (value.kind === 'station'
      ? keys(value, ['kind', 'stationId', 'tenantId']) &&
        text(value.stationId) &&
        (value.tenantId === undefined || text(value.tenantId))
      : value.kind === 'console-projection' &&
        keys(value, ['kind', 'projectionId']) &&
        text(value.projectionId));
  return (
    value.results.every(
      (result) =>
        record(result) &&
        keys(result, [
          'version',
          'key',
          'providerId',
          'owner',
          'id',
          'kind',
          'scope',
          'title',
          'snippet',
          'matchedFields',
          'currentness',
          'relevance',
          'openIntent',
        ]) &&
        kinds.includes(String(result.kind)) &&
        (result.scope === undefined || scope(result.scope)) &&
        result.version === UNIFIED_SEARCH_V1 &&
        text(result.key) &&
        text(result.id) &&
        text(result.providerId) &&
        owner(result.owner) &&
        text(result.title) &&
        (result.snippet === undefined || text(result.snippet)) &&
        Array.isArray(result.matchedFields) &&
        result.matchedFields.length <= 6 &&
        result.matchedFields.every((field) =>
          ['id', 'title', 'description', 'snippet', 'label', 'path'].includes(
            String(field),
          ),
        ) &&
        currentness(result.currentness) &&
        typeof result.relevance === 'number' &&
        Number.isFinite(result.relevance) &&
        result.relevance >= 0 &&
        result.relevance <= 1 &&
        intent(result.openIntent),
    ) &&
    value.sources.every(
      (source) =>
        record(source) &&
        keys(source, [
          'providerId',
          'owner',
          'state',
          'reason',
          'continuation',
          'priorCondition',
        ]) &&
        text(source.providerId) &&
        owner(source.owner) &&
        sourceStates.includes(String(source.state)) &&
        (source.reason === undefined ||
          reasons.includes(String(source.reason))) &&
        (source.continuation === undefined || text(source.continuation)) &&
        (source.priorCondition === undefined ||
          (record(source.priorCondition) &&
            keys(source.priorCondition, ['state', 'reason']) &&
            sourceStates.includes(String(source.priorCondition.state)) &&
            (source.priorCondition.reason === undefined ||
              reasons
                .slice(0, 6)
                .includes(String(source.priorCondition.reason))))),
    )
  );
}
async function query<T>(
  apiBase: string,
  path: string,
  body: unknown,
  parse: (value: unknown) => value is T,
  options: UnifiedSearchRequestOptions,
): Promise<T> {
  let status = 0;
  try {
    if (
      !isApiRequestScope(options?.requestScope) ||
      options.requestScope.apiBase !== apiBase
    )
      throw new UnifiedSearchRequestError(0);
    // Capture intent before asynchronous credential resolution can yield.
    const captured = JSON.stringify(body);
    if (captured.length > 12 * 1024) throw new UnifiedSearchRequestError(0);
    const result = await mutateJson(
      `${apiBase}/api/search${path}`,
      'POST',
      { ...options, readOnly: true },
      JSON.parse(captured),
    );
    status = result.status;
    if (!result.ok) throw new UnifiedSearchRequestError(status);
    const wire: unknown = await result.json();
    if (
      !record(wire) ||
      wire.success !== true ||
      JSON.stringify(wire).length > 256 * 1024 ||
      !parse(wire.data)
    )
      throw new UnifiedSearchRequestError(status);
    return wire.data;
  } catch (error) {
    throw error instanceof UnifiedSearchRequestError
      ? error
      : new UnifiedSearchRequestError(status);
  }
}
/** Every caller must pass a host-captured scope; old servers are unsupported, never empty. */
export function searchStation(
  apiBase: string,
  request: UnifiedSearchRequest,
  options: UnifiedSearchRequestOptions,
) {
  return query(apiBase, '', request, response, options);
}
/** Resolve again immediately before navigation. Never derive an event id from an old anchor. */
export function resolveSearchOpen(
  apiBase: string,
  locator: UnifiedSearchOpenLocator,
  options: UnifiedSearchRequestOptions,
) {
  return query(apiBase, '/resolve-open', locator, resolution, options);
}
