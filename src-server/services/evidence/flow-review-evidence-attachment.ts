import { join } from 'node:path';
import type { FlowRunService } from '../flow/flow-run-service.js';
import type { ReviewEvidenceAttachment } from './review-evidence-module.js';

export class FlowReviewEvidenceAttachment implements ReviewEvidenceAttachment {
  constructor(
    private readonly flowRuns: FlowRunService,
    private readonly workspace: (projectSlug: string) => string | undefined,
  ) {}

  async attach(input: Parameters<ReviewEvidenceAttachment['attach']>[0]) {
    const cwd = this.workspace(input.projectSlug);
    if (!cwd) throw new Error('Review project workspace is unavailable.');
    const entry = await this.flowRuns.attachEvidence(cwd, input.runId, {
      gate: input.gate,
      file: join(
        '.station',
        'review-evidence',
        'receipts',
        `${input.receipt.receiptId}.json`,
      ),
      kind: 'station.review-findings',
      // Independent findings are review input, not a passing or failing gate
      // decision. Flow's canonical neutral evidence state is `unknown`.
      status: 'unknown',
      producer: 'station.review-orchestration',
    });
    return { evidenceId: entry.id };
  }
}
