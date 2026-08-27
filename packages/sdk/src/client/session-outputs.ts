import type {
  SessionOutputInspection,
  SessionOutputItem,
  SessionOutputsPage,
} from '@kontourai/station-contracts/session-outputs';
import { SESSION_OUTPUTS_V1 } from '@kontourai/station-contracts/session-outputs';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

const SHA256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
export class SessionOutputsRequestError extends Error {
  constructor(readonly status: number) {
    super('Session outputs unavailable');
  }
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}
function text(value: unknown, max: number, min = 1): value is string {
  return (
    typeof value === 'string' &&
    value.length >= min &&
    encoder.encode(value).byteLength <= max
  );
}
function int(value: unknown, min: number, max: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}
function output(value: unknown): SessionOutputItem | undefined {
  const item = record(value);
  if (
    !item ||
    (!exact(item, [
      'ref',
      'turnId',
      'toolCallId',
      'declaredAt',
      'descriptor',
    ]) &&
      !exact(item, [
        'ref',
        'turnId',
        'toolCallId',
        'declaredAt',
        'label',
        'descriptor',
      ]))
  )
    return undefined;
  const ref = record(item.ref),
    descriptor = record(item.descriptor);
  if (
    !ref ||
    !descriptor ||
    !exact(ref, ['sessionId', 'eventId']) ||
    !text(ref.sessionId, 1024) ||
    !text(ref.eventId, 1024) ||
    !text(item.turnId, 1024) ||
    !text(item.toolCallId, 1024) ||
    !text(item.declaredAt, 128) ||
    (item.label !== undefined && !text(item.label, 240))
  )
    return undefined;
  const common = {
    ref: { sessionId: ref.sessionId, eventId: ref.eventId },
    turnId: item.turnId,
    toolCallId: item.toolCallId,
    declaredAt: item.declaredAt,
    ...(typeof item.label === 'string' ? { label: item.label } : {}),
  };
  if (descriptor.kind === 'workspace-file') {
    if (
      (!exact(descriptor, ['kind', 'relativePath', 'digest', 'length']) &&
        !exact(descriptor, [
          'kind',
          'relativePath',
          'digest',
          'length',
          'mediaType',
        ])) ||
      !text(descriptor.relativePath, 4096) ||
      !text(descriptor.digest, 64) ||
      !SHA256.test(descriptor.digest) ||
      !int(descriptor.length, 0, 5 * 1024 * 1024) ||
      (descriptor.mediaType !== undefined && !text(descriptor.mediaType, 160))
    )
      return undefined;
    return {
      ...common,
      descriptor: {
        kind: 'workspace-file',
        relativePath: descriptor.relativePath,
        digest: descriptor.digest,
        length: descriptor.length,
        ...(typeof descriptor.mediaType === 'string'
          ? { mediaType: descriptor.mediaType }
          : {}),
      },
    };
  }
  const repo = record(descriptor.repository);
  if (
    descriptor.kind !== 'pull-request' ||
    !exact(descriptor, [
      'kind',
      'provider',
      'host',
      'repository',
      'ref',
      'nativeId',
      'liveExternal',
    ]) ||
    !repo ||
    !exact(repo, ['owner', 'name']) ||
    descriptor.liveExternal !== true ||
    !text(descriptor.provider, 128) ||
    !text(descriptor.host, 512) ||
    !text(descriptor.ref, 512) ||
    !text(descriptor.nativeId, 512) ||
    !text(repo.owner, 256) ||
    !text(repo.name, 256)
  )
    return undefined;
  return {
    ...common,
    descriptor: {
      kind: 'pull-request',
      provider: descriptor.provider,
      host: descriptor.host,
      repository: { owner: repo.owner, name: repo.name },
      ref: descriptor.ref,
      nativeId: descriptor.nativeId,
      liveExternal: true,
    },
  };
}
function page(
  value: unknown,
  sessionId: string,
): SessionOutputsPage | undefined {
  const page = record(value);
  if (
    !page ||
    (!exact(page, ['version', 'items', 'partial']) &&
      !exact(page, ['version', 'items', 'partial', 'cursor'])) ||
    page.version !== SESSION_OUTPUTS_V1 ||
    !Array.isArray(page.items) ||
    page.items.length > 50 ||
    typeof page.partial !== 'boolean' ||
    (page.cursor !== undefined && !text(page.cursor, 1024))
  )
    return undefined;
  const items = page.items.map(output);
  if (
    items.some((item) => !item) ||
    items.some((item) => item?.ref.sessionId !== sessionId)
  )
    return undefined;
  return {
    version: SESSION_OUTPUTS_V1,
    items: items as SessionOutputItem[],
    partial: page.partial,
    ...(typeof page.cursor === 'string' ? { cursor: page.cursor } : {}),
  };
}
function inspection(
  value: unknown,
  sessionId: string,
  eventId: string,
): SessionOutputInspection | undefined {
  const result = record(value),
    item = result && output(result.item);
  if (
    !result ||
    !item ||
    result.version !== SESSION_OUTPUTS_V1 ||
    item.ref.sessionId !== sessionId ||
    item.ref.eventId !== eventId
  )
    return undefined;
  if (result.kind === 'metadata' && exact(result, ['version', 'item', 'kind']))
    return { version: SESSION_OUTPUTS_V1, item, kind: 'metadata' };
  if (
    result.kind === 'text' &&
    exact(result, ['version', 'item', 'kind', 'text']) &&
    text(result.text, 512 * 1024, 0)
  )
    return {
      version: SESSION_OUTPUTS_V1,
      item,
      kind: 'text',
      text: result.text,
    };
  if (
    result.kind === 'image' &&
    exact(result, [
      'version',
      'item',
      'kind',
      'mediaType',
      'data',
      'width',
      'height',
    ]) &&
    (result.mediaType === 'image/png' || result.mediaType === 'image/jpeg') &&
    text(result.data, 8 * 1024 * 1024, 0) &&
    int(result.width, 1, 8192) &&
    int(result.height, 1, 8192) &&
    result.width * result.height <= 16_000_000
  )
    return {
      version: SESSION_OUTPUTS_V1,
      item,
      kind: 'image',
      mediaType: result.mediaType,
      data: result.data,
      width: result.width,
      height: result.height,
    };
  return undefined;
}
async function unwrap<T>(
  response: Response,
  parse: (value: unknown) => T | undefined,
): Promise<T> {
  try {
    const body = record(await response.json());
    const parsed = body?.success === true ? parse(body.data) : undefined;
    if (response.ok && parsed) return parsed;
  } catch {
    /* normalized below */
  }
  throw new SessionOutputsRequestError(response.status);
}
export async function listSessionOutputs(
  apiBase: string,
  sessionId: string,
  options?: ClientRequestOptions & { cursor?: string; limit?: number },
): Promise<SessionOutputsPage> {
  const query = new URLSearchParams();
  if (options?.cursor) query.set('cursor', options.cursor);
  if (options?.limit !== undefined) query.set('limit', String(options.limit));
  try {
    return await unwrap(
      await getJson(
        `${apiBase}/api/orchestration/sessions/${encodeURIComponent(sessionId)}/outputs${query.size ? `?${query}` : ''}`,
        options,
      ),
      (value) => page(value, sessionId),
    );
  } catch (error) {
    throw error instanceof SessionOutputsRequestError
      ? error
      : new SessionOutputsRequestError(0);
  }
}
export async function inspectSessionOutput(
  apiBase: string,
  sessionId: string,
  eventId: string,
  options?: ClientRequestOptions,
): Promise<SessionOutputInspection> {
  try {
    return await unwrap(
      await mutateJson(
        `${apiBase}/api/orchestration/sessions/${encodeURIComponent(sessionId)}/outputs/${encodeURIComponent(eventId)}/inspect`,
        'POST',
        options,
        {},
      ),
      (value) => inspection(value, sessionId, eventId),
    );
  } catch (error) {
    throw error instanceof SessionOutputsRequestError
      ? error
      : new SessionOutputsRequestError(0);
  }
}
