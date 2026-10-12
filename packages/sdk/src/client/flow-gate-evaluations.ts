import {
  type GateEvaluationReadProjection,
  parseGateEvaluationReadResult,
  parseGateEvaluationRef,
} from '@kontourai/flow/gate-evaluation-contract';
import {
  isStationBasisId,
  MAX_TASK_REFERENCES_PER_TASK,
} from '@kontourai/station-contracts';
import { envelopeError, type StationHttpError } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';

export class FlowGateEvaluationRequestError extends Error {
  readonly status: number;
  /**
   * The refusal's machine `code` and `Retry-After`, when Station answered
   * (#2708). The message stays generic on purpose: nothing the route sent
   * about protected content crosses this seam.
   */
  readonly code?: string;
  readonly retryAfterMs?: number;

  /** `0` when no response was observed; else the envelope helper's error. */
  constructor(answer: number | StationHttpError) {
    super('Gate evaluation unavailable');
    this.name = 'FlowGateEvaluationRequestError';
    this.status = typeof answer === 'number' ? answer : answer.status;
    if (typeof answer !== 'number') {
      if (answer.code !== undefined) this.code = answer.code;
      if (answer.retryAfterMs !== undefined)
        this.retryAfterMs = answer.retryAfterMs;
    }
  }
}

/** The observed answer, withholding everything the route said but its code. */
function answered(response: Response, body?: unknown): StationHttpError {
  return envelopeError(response, body, 'Gate evaluation unavailable', {
    message: 'Gate evaluation unavailable',
  });
}
export type FlowGateEvaluationProjection =
  | {
      referenceId: string;
      kept: true;
      evaluation: GateEvaluationReadProjection;
    }
  | { state: 'unavailable' };
type Envelope = { success: boolean; data?: unknown };
function exact(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actual = Object.keys(value).sort(),
    expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, i) => key === expected[i])
    ? (value as Record<string, unknown>)
    : null;
}
async function protectedRead<T>(
  request: () => Promise<Response>,
  parse: (value: unknown) => T | null,
) {
  try {
    const response = await request();
    // A refusal whose body is not JSON keeps its status (#2708).
    const body = (await readJsonBody(response)) as Envelope | undefined;
    const data =
      body?.success === true && body.data !== undefined
        ? parse(body.data)
        : null;
    if (!response.ok || !data)
      throw new FlowGateEvaluationRequestError(answered(response, body));
    return data;
  } catch (error) {
    throw error instanceof FlowGateEvaluationRequestError
      ? error
      : new FlowGateEvaluationRequestError(0);
  }
}
export async function getTaskFlowGateEvaluations(
  apiBase: string,
  taskId: string,
  options?: ClientRequestOptions,
): Promise<FlowGateEvaluationProjection[]> {
  return protectedRead(
    () =>
      getJson(
        `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/gate-evaluation-references`,
        options,
      ),
    (value) => {
      if (
        !Array.isArray(value) ||
        value.length > MAX_TASK_REFERENCES_PER_TASK + 1
      )
        return null;
      let sentinel = 0;
      const output: FlowGateEvaluationProjection[] = [];
      for (const item of value) {
        const available = exact(item, ['referenceId', 'kept', 'evaluation']);
        if (
          available?.kept === true &&
          typeof available.referenceId === 'string' &&
          isStationBasisId(available.referenceId)
        ) {
          const parsed = parseGateEvaluationReadResult({
            status: 'found',
            evaluation: available.evaluation,
          });
          if (parsed?.status !== 'found') return null;
          output.push({
            referenceId: available.referenceId,
            kept: true,
            evaluation: parsed.evaluation,
          });
        } else if (
          exact(item, ['state'])?.state === 'unavailable' &&
          ++sentinel === 1
        )
          output.push({ state: 'unavailable' });
        else return null;
      }
      return output;
    },
  );
}

/** Reads one Flow-owned receipt through the project console capability. */
export async function getProjectFlowGateEvaluation(
  apiBase: string,
  projectSlug: string,
  ref: { runId: string; gateId: string; evaluationId: string },
  options?: ClientRequestOptions,
): Promise<GateEvaluationReadProjection> {
  const parsedRef = parseGateEvaluationRef(ref);
  if (!projectSlug || !parsedRef) throw new FlowGateEvaluationRequestError(0);
  // The caller can mutate its object while the transport is suspended. Keep
  // the request identity immutable across both awaits and refuse a receipt
  // whose self-described tuple differs from the URL we issued.
  const requestedProjectSlug = projectSlug;
  const requestedRef = {
    runId: parsedRef.runId,
    gateId: parsedRef.gateId,
    evaluationId: parsedRef.evaluationId,
  };
  return protectedRead(
    () =>
      getJson(
        `${apiBase}/api/projects/${encodeURIComponent(requestedProjectSlug)}/flow/runs/${encodeURIComponent(requestedRef.runId)}/gates/${encodeURIComponent(requestedRef.gateId)}/evaluations/${encodeURIComponent(requestedRef.evaluationId)}`,
        options,
      ),
    (value) => {
      const result = parseGateEvaluationReadResult({
        status: 'found',
        evaluation: value,
      });
      return result?.status === 'found' &&
        result.evaluation.ref.runId === requestedRef.runId &&
        result.evaluation.ref.gateId === requestedRef.gateId &&
        result.evaluation.ref.evaluationId === requestedRef.evaluationId
        ? result.evaluation
        : null;
    },
  );
}
export type AttachTaskFlowGateEvaluationInput = {
  ref: { runId: string; gateId: string; evaluationId: string };
  sourceSurface?: string;
};
export async function attachTaskFlowGateEvaluation(
  apiBase: string,
  taskId: string,
  input: AttachTaskFlowGateEvaluationInput,
  options?: ClientRequestOptions,
) {
  if (
    !input ||
    typeof input !== 'object' ||
    Object.keys(input).some(
      (key) => key !== 'ref' && key !== 'sourceSurface',
    ) ||
    !parseGateEvaluationRef(input.ref)
  )
    throw new FlowGateEvaluationRequestError(0);
  return protectedRead(
    () =>
      mutateJson(
        `${apiBase}/api/tasks/${encodeURIComponent(taskId)}/references`,
        'POST',
        options,
        { kind: 'gate-evaluation', ...input },
      ),
    (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null,
  );
}
