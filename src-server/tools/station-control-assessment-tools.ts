import { isStationBasisId } from '@kontourai/station-contracts/task-basis';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const identity = z.string().refine(isStationBasisId);
const target = { sessionId: identity, turnId: identity };
const path = (args: { sessionId: string; turnId: string }) =>
  `/api/orchestration/sessions/${encodeURIComponent(args.sessionId)}/turns/${encodeURIComponent(args.turnId)}/assessment`;

/** Frozen producer records only: Surface validates support; Station binds identity and CAS. */
export function registerAssessmentTools(registry: StationControlToolRegistry) {
  registry.tool(
    'get_answer_assessment_target',
    'Read the exact completed answer binding, required Surface claim profile and current assessment revision. Copy the binding/profile; never infer them from answer text. Personal mode only.',
    target,
    async (args) => jsonToolResult(await api(`${path(args)}/target`)),
  );
  registry.tool(
    'publish_answer_assessment',
    'Publish a frozen Surface trust bundle for one exact completed answer using its target binding/profile and expectedRevision. The server validates the claim and authorization. Tool success or Output existence is not semantic support. A conflict requires rereading the target. This replaces only the producer assessment; it does not Keep an answer in a Task.',
    {
      ...target,
      publicationId: identity,
      expectedAnswer: z.unknown(),
      bundle: z.unknown(),
      claimId: identity,
      expectedRevision: z.number().int().nonnegative(),
    },
    async ({ sessionId, turnId, ...input }) => {
      const body = JSON.stringify(input);
      if (Buffer.byteLength(body, 'utf8') > 1_048_576)
        return jsonToolResult({
          success: false,
          error: 'Assessment exceeds the publication bound',
        });
      return jsonToolResult(
        await api(path({ sessionId, turnId }), { method: 'PUT', body }),
      );
    },
  );
  registry.tool(
    'remove_answer_assessment',
    'Revoke the producer assessment for an exact answer using its current expectedRevision. This retains the historical answer and frozen artifact, and does not remove Task curation overrides. A conflict requires rereading the target.',
    { ...target, expectedRevision: z.number().int().positive() },
    async ({ sessionId, turnId, expectedRevision }) =>
      jsonToolResult(
        await api(path({ sessionId, turnId }), {
          method: 'DELETE',
          body: JSON.stringify({ expectedRevision }),
        }),
      ),
  );
}
