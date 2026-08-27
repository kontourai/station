import type {
  TaskDeclaredOutputKeepResult,
  TaskOutputCreateInput,
  TaskOutputRecord,
} from '@kontourai/station-contracts';
import { TASK_DECLARED_OUTPUT_KEEP_V1 } from '@kontourai/station-contracts/task-graph';
// The sibling, not the `../api-core` barrel that re-exports it: nothing under
// `client/**` may reach outside `client/`, because that is what lets this
// entry run in a CLI process and a browser alike (station#4011). Going
// through the barrel is the easy way to break it without noticing.
import { apiErrorMessage } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

type Envelope<T> = { success: boolean; data?: T; error?: string };
async function unwrap<T>(response: Response): Promise<T> {
  const body = (await response.json()) as Envelope<T>;
  if (!response.ok || !body.success || body.data === undefined)
    throw new Error(apiErrorMessage(body, `HTTP ${response.status}`));
  return body.data;
}
const path = (taskId: string, suffix = '') =>
  `/api/tasks/${encodeURIComponent(taskId)}/outputs${suffix}`;
const encoder = new TextEncoder();
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
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= max
  );
}
function taskOutput(value: unknown): TaskOutputRecord | undefined {
  const output = record(value);
  if (
    !output ||
    !exact(output, [
      'schemaVersion',
      'id',
      'taskId',
      'projectId',
      'title',
      'source',
      'materialization',
      'createdAt',
    ]) ||
    output.schemaVersion !== 1 ||
    !text(output.id, 240) ||
    !text(output.taskId, 240) ||
    !text(output.projectId, 240) ||
    !text(output.title, 240) ||
    !text(output.createdAt, 128)
  )
    return undefined;
  const source = record(output.source),
    materialization = record(output.materialization);
  if (
    !source ||
    !exact(source, ['kind', 'relativePath']) ||
    source.kind !== 'workspace-file' ||
    !text(source.relativePath, 4096) ||
    !materialization ||
    !exact(materialization, [
      'kind',
      'fileName',
      'mediaType',
      'byteLength',
      'digest',
      'contentAvailable',
    ]) ||
    materialization.kind !== 'snapshot' ||
    !text(materialization.fileName, 240) ||
    !text(materialization.mediaType, 160) ||
    !Number.isInteger(materialization.byteLength) ||
    (materialization.byteLength as number) < 0 ||
    (materialization.byteLength as number) > 5 * 1024 * 1024 ||
    !text(materialization.digest, 80) ||
    !/^sha256:[a-f0-9]{64}$/.test(materialization.digest) ||
    typeof materialization.contentAvailable !== 'boolean'
  )
    return undefined;
  return {
    schemaVersion: 1,
    id: output.id as string,
    taskId: output.taskId as string,
    projectId: output.projectId as string,
    title: output.title as string,
    source: { kind: 'workspace-file', relativePath: source.relativePath },
    materialization: {
      kind: 'snapshot',
      fileName: materialization.fileName as string,
      mediaType: materialization.mediaType as string,
      byteLength: materialization.byteLength as number,
      digest: materialization.digest as `sha256:${string}`,
      contentAvailable: materialization.contentAvailable,
    },
    createdAt: output.createdAt as string,
  };
}
function keepResult(value: unknown): TaskDeclaredOutputKeepResult | undefined {
  const result = record(value);
  if (
    !result ||
    result.version !== TASK_DECLARED_OUTPUT_KEEP_V1 ||
    result.status !== 'kept' ||
    (result.outcome !== 'kept' && result.outcome !== 'already-kept')
  )
    return undefined;
  if (
    result.kind === 'workspace-file' &&
    exact(result, ['version', 'status', 'kind', 'outcome', 'output'])
  ) {
    const output = taskOutput(result.output);
    return output
      ? {
          version: TASK_DECLARED_OUTPUT_KEEP_V1,
          status: 'kept',
          kind: 'workspace-file',
          outcome: result.outcome,
          output,
        }
      : undefined;
  }
  if (
    result.kind !== 'pull-request' ||
    !exact(result, ['version', 'status', 'kind', 'outcome', 'reference'])
  )
    return undefined;
  const reference = record(result.reference),
    repository = reference && record(reference.repository),
    provenance = reference && record(reference.provenance);
  if (
    !reference ||
    !repository ||
    !provenance ||
    !exact(reference, [
      'schemaVersion',
      'taskId',
      'provider',
      'host',
      'repository',
      'ref',
      'nativeId',
      'provenance',
      'keptAt',
    ]) ||
    reference.schemaVersion !== 1 ||
    !exact(repository, ['owner', 'name']) ||
    !exact(provenance, [
      'sessionId',
      'turnId',
      'toolCallId',
      'declarationId',
      'eventId',
    ]) ||
    !text(reference.taskId, 240) ||
    !text(reference.provider, 128) ||
    !text(reference.host, 512) ||
    !text(repository.owner, 256) ||
    !text(repository.name, 256) ||
    !text(reference.ref, 512) ||
    !text(reference.nativeId, 512) ||
    !text(reference.keptAt, 128) ||
    !text(provenance.sessionId, 1024) ||
    !text(provenance.turnId, 1024) ||
    !text(provenance.toolCallId, 1024) ||
    !text(provenance.declarationId, 1024) ||
    !text(provenance.eventId, 1024)
  )
    return undefined;
  return {
    version: TASK_DECLARED_OUTPUT_KEEP_V1,
    status: 'kept',
    kind: 'pull-request',
    outcome: result.outcome,
    reference: {
      schemaVersion: 1,
      taskId: reference.taskId,
      provider: reference.provider,
      host: reference.host,
      repository: { owner: repository.owner, name: repository.name },
      ref: reference.ref,
      nativeId: reference.nativeId,
      provenance: {
        sessionId: provenance.sessionId,
        turnId: provenance.turnId,
        toolCallId: provenance.toolCallId,
        declarationId: provenance.declarationId,
        eventId: provenance.eventId,
      },
      keptAt: reference.keptAt,
    },
  };
}

export async function listTaskOutputs(
  apiBase: string,
  taskId: string,
  options?: ClientRequestOptions,
): Promise<TaskOutputRecord[]> {
  return unwrap(await getJson(`${apiBase}${path(taskId)}`, options));
}
export async function getTaskOutput(
  apiBase: string,
  taskId: string,
  outputId: string,
  options?: ClientRequestOptions,
): Promise<TaskOutputRecord> {
  return unwrap(
    await getJson(
      `${apiBase}${path(taskId, `/${encodeURIComponent(outputId)}`)}`,
      options,
    ),
  );
}
export async function createTaskOutputClient(
  apiBase: string,
  taskId: string,
  input: TaskOutputCreateInput,
  options?: ClientRequestOptions,
): Promise<TaskOutputRecord> {
  return unwrap(
    await mutateJson(`${apiBase}${path(taskId)}`, 'POST', options, input),
  );
}
/** Promote one server-declared candidate; callers never send path or bytes. */
export async function keepDeclaredTaskOutput(
  apiBase: string,
  taskId: string,
  sessionId: string,
  eventId: string,
  input: { operationId: string },
  options?: ClientRequestOptions,
): Promise<TaskDeclaredOutputKeepResult> {
  const response = await mutateJson(
    `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/declared-outputs/${encodeURIComponent(sessionId)}/${encodeURIComponent(eventId)}/keep`,
    'POST',
    options,
    input,
  );
  const body = (await response.json()) as Envelope<unknown>;
  const parsed =
    response.ok && body.success ? keepResult(body.data) : undefined;
  if (!parsed)
    throw new Error(apiErrorMessage(body, `HTTP ${response.status}`));
  return parsed;
}
export async function deleteTaskOutputClient(
  apiBase: string,
  taskId: string,
  outputId: string,
  options?: ClientRequestOptions,
): Promise<void> {
  await unwrap<{ deleted: boolean }>(
    await mutateJson(
      `${apiBase}${path(taskId, `/${encodeURIComponent(outputId)}`)}`,
      'DELETE',
      options,
      {},
    ),
  );
}
export type TaskOutputContent = {
  bytes: Uint8Array;
  mediaType: string;
  fileName: string | null;
  etag: string | null;
  safePreview: 'image/png' | null;
};

export async function downloadTaskOutputContent(
  apiBase: string,
  taskId: string,
  outputId: string,
  options?: ClientRequestOptions,
): Promise<TaskOutputContent> {
  const response = await getJson(
    `${apiBase}${path(taskId, `/${encodeURIComponent(outputId)}/content`)}`,
    options,
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mediaType:
      response.headers.get('content-type') ?? 'application/octet-stream',
    fileName:
      response.headers
        .get('content-disposition')
        ?.match(/filename="?([^";]+)"?/)?.[1] ?? null,
    etag: response.headers.get('etag'),
    safePreview:
      response.headers.get('x-station-safe-preview') === 'image/png'
        ? 'image/png'
        : null,
  };
}
