import {
  encodeTaskToolResultReference,
  isStationBasisId,
  MAX_TASK_REFERENCES_PER_TASK,
  parseStationTaskBasisKeptToolResult,
  type RelationGraphLink,
  type StationTaskBasisKeptToolResult,
  TaskToolResultReferenceInput,
  validateTaskReferenceInput,
} from '@kontourai/station-contracts';
import {
  type SafeToolResultProjection as SafeToolResult,
  SafeToolResultProjection,
} from '@kontourai/thread';
import { type ClientRequestOptions, getJson, mutateJson } from './http';

export class TaskToolResultRequestError extends Error {
  constructor(readonly status: number) {
    super('Tool result unavailable');
    this.name = 'TaskToolResultRequestError';
  }
}
type Envelope = { success: boolean; data?: unknown };
export type TaskToolResultProjection =
  | {
      id: string;
      state: 'available';
      ref: StationTaskBasisKeptToolResult['ref'];
      result: SafeToolResult;
    }
  | { state: 'unavailable' };
function exact(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
    ? (value as Record<string, unknown>)
    : null;
}
function safe(value: unknown, eventId?: string): SafeToolResult | null {
  const allowed = new Set([
    'resultId',
    'name',
    'terminalStatus',
    'authorityDecision',
    'correlations',
    'content',
    'truncated',
    'omittedParts',
    'omittedTextBytes',
    'omittedMetadataBytes',
  ]);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.has(key))
  )
    return null;
  const parsed = SafeToolResultProjection.safeParse(value);
  return parsed.success &&
    (eventId === undefined || parsed.data.resultId === eventId)
    ? parsed.data
    : null;
}
function resultRef(
  value: unknown,
  referenceId: string,
  resultId: string,
): StationTaskBasisKeptToolResult['ref'] | null {
  const parsed = parseStationTaskBasisKeptToolResult({
    referenceId,
    ref: value,
    kept: true,
    associatedAnswerReferenceIds: [],
  });
  return parsed?.ref.resultId === resultId ? parsed.ref : null;
}
async function unwrap<T>(
  response: Response,
  parse: (value: unknown) => T | null,
): Promise<T> {
  let body: Envelope | undefined;
  try {
    body = (await response.json()) as Envelope;
  } catch {
    throw new TaskToolResultRequestError(response.status);
  }
  const data =
    body?.success === true && body.data !== undefined ? parse(body.data) : null;
  if (!response.ok || !data)
    throw new TaskToolResultRequestError(response.status);
  return data;
}
async function protectedRead<T>(
  request: () => Promise<Response>,
  parse: (value: unknown) => T | null,
): Promise<T> {
  try {
    return await unwrap(await request(), parse);
  } catch (error) {
    if (error instanceof TaskToolResultRequestError) throw error;
    throw new TaskToolResultRequestError(0);
  }
}
export async function getSessionToolResult(
  apiBase: string,
  sessionId: string,
  eventId: string,
  options?: ClientRequestOptions,
): Promise<SafeToolResult> {
  return protectedRead(
    () =>
      getJson(
        `${apiBase}/api/orchestration/sessions/${encodeURIComponent(sessionId)}/tool-results/${encodeURIComponent(eventId)}`,
        options,
      ),
    (value) => {
      const item = exact(value, ['sessionId', 'eventId', 'result']);
      return item?.sessionId === sessionId && item.eventId === eventId
        ? safe(item.result, eventId)
        : null;
    },
  );
}
export type AttachTaskToolResultReferenceInput = Omit<
  TaskToolResultReferenceInput,
  'kind'
>;
function attachmentInput(
  input: AttachTaskToolResultReferenceInput,
): { sessionId: string; eventId: string; sourceSurface?: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (
    !keys.every((key) =>
      ['sessionId', 'eventId', 'sourceSurface'].includes(key),
    )
  )
    return null;
  const candidate = {
    kind: 'tool-result' as const,
    sessionId: input.sessionId,
    eventId: input.eventId,
    ...(input.sourceSurface === undefined
      ? {}
      : { sourceSurface: input.sourceSurface }),
  };
  return validateTaskReferenceInput(candidate).length === 0 ? candidate : null;
}
export async function attachTaskToolResultReference(
  apiBase: string,
  taskId: string,
  input: AttachTaskToolResultReferenceInput,
  options?: ClientRequestOptions,
): Promise<RelationGraphLink> {
  const validated = attachmentInput(input);
  if (!validated) return Promise.reject(new TaskToolResultRequestError(0));
  return protectedRead(
    () =>
      mutateJson(
        `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/references`,
        'POST',
        options,
        { ...validated, kind: 'tool-result' },
      ),
    (value) => {
      const link =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      const allowed = new Set([
        'id',
        'sourceType',
        'sourceId',
        'targetType',
        'targetId',
        'relationType',
        'confidence',
        'createdAt',
        'source',
        'clientOrigin',
      ]);
      if (!link || Object.keys(link).some((key) => !allowed.has(key)))
        return null;
      const id = link.id;
      if (
        typeof id !== 'string' ||
        !isStationBasisId(id) ||
        typeof link.createdAt !== 'string' ||
        link.createdAt.length > 128 ||
        !Number.isFinite(Date.parse(link.createdAt)) ||
        new Date(link.createdAt).toISOString() !== link.createdAt
      )
        return null;
      if (
        link.sourceType === 'task' &&
        link.sourceId === taskId &&
        link.targetType === 'tool_result' &&
        link.targetId ===
          encodeTaskToolResultReference(
            validated.sessionId,
            validated.eventId,
          ) &&
        link.relationType === 'references_tool_result' &&
        link.confidence === 1 &&
        link.source === 'user'
      )
        return {
          id,
          sourceType: 'task',
          sourceId: taskId,
          targetType: 'tool_result',
          targetId: link.targetId as string,
          relationType: 'references_tool_result',
          confidence: 1,
          createdAt: link.createdAt,
          source: 'user',
        };
      return null;
    },
  );
}
export async function getTaskToolResultReferences(
  apiBase: string,
  taskId: string,
  options?: ClientRequestOptions,
): Promise<TaskToolResultProjection[]> {
  return protectedRead(
    () =>
      getJson(
        `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/tool-result-references`,
        options,
      ),
    (value) => {
      if (!Array.isArray(value) || value.length > MAX_TASK_REFERENCES_PER_TASK)
        return null;
      const output: TaskToolResultProjection[] = [];
      let unavailableCount = 0;
      for (const item of value) {
        const available = exact(item, ['id', 'state', 'ref', 'result']);
        const unavailable = exact(item, ['state']);
        if (
          available?.state === 'available' &&
          typeof available.id === 'string' &&
          isStationBasisId(available.id)
        ) {
          const result = safe(available.result);
          const ref = result
            ? resultRef(available.ref, available.id, result.resultId)
            : null;
          if (!result || !ref) return null;
          output.push({ id: available.id, state: 'available', ref, result });
        } else if (unavailable?.state === 'unavailable') {
          unavailableCount += 1;
          if (unavailableCount > 1) return null;
          output.push({ state: 'unavailable' });
        } else return null;
      }
      return new Set(
        output
          .filter((item) => item.state === 'available')
          .map((item) => (item.state === 'available' ? item.id : '')),
      ).size === output.filter((item) => item.state === 'available').length
        ? output
        : null;
    },
  );
}
