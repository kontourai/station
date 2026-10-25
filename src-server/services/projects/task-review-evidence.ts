import { realpath } from 'node:fs/promises';
import { parseGateEvaluationReadResult } from '@kontourai/flow/gate-evaluation-contract';
import type {
  TaskReviewEvidence,
  TaskReviewEvidenceInput,
} from '@kontourai/station-contracts/task-review';
import { execGit } from '../../utils/git-exec.js';
import { readProjectRepository } from './git-read-repository.js';

/** Missing commits and unavailable gate owners leave claims, never a passing chip. */
export async function verifyTaskReviewEvidence(input: {
  workspace: string | undefined;
  evidence: TaskReviewEvidenceInput;
  authorize(): boolean;
  readGate(
    ref: NonNullable<TaskReviewEvidenceInput['gateRefs']>[number],
  ): Promise<unknown>;
}): Promise<TaskReviewEvidence> {
  let commitVerified = false;
  if (input.workspace && input.evidence.commit && input.authorize()) {
    try {
      const workspace = await realpath(input.workspace);
      const result = await readProjectRepository(
        workspace,
        workspace,
        { timeoutMs: 5000 },
        async (repository) => {
          await execGit(
            [
              ...repository.repoArgs,
              'cat-file',
              '-e',
              `${input.evidence.commit}^{commit}`,
            ],
            {
              cwd: workspace,
              timeout: 5000,
              maxBuffer: 64 * 1024,
              assertCurrent: () => {
                if (!input.authorize()) throw new Error('Task binding changed');
              },
            },
          );
          return true;
        },
      );
      commitVerified = result.ok && result.value;
    } catch {
      commitVerified = false;
    }
  }
  const refs = new Map(
    (input.evidence.gateRefs ?? []).map(
      (ref) =>
        [
          JSON.stringify([ref.runId, ref.gateId, ref.evaluationId]),
          ref,
        ] as const,
    ),
  );
  let gateVerified = refs.size > 0 && !!input.workspace;
  for (const ref of refs.values()) {
    try {
      const result = input.authorize()
        ? parseGateEvaluationReadResult(await input.readGate(ref))
        : undefined;
      if (
        result?.status !== 'found' ||
        result.evaluation.originalVerdict !== 'pass' ||
        result.evaluation.currentStanding !== 'current' ||
        result.evaluation.ref.runId !== ref.runId ||
        result.evaluation.ref.gateId !== ref.gateId ||
        result.evaluation.ref.evaluationId !== ref.evaluationId
      )
        gateVerified = false;
    } catch {
      gateVerified = false;
    }
  }
  const current = input.authorize();
  return {
    ...input.evidence,
    commitVerified: current && commitVerified,
    gateVerified: current && gateVerified,
  };
}
