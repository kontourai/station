import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IndependentReviewReceipt } from '@kontourai/station-contracts/review-evidence';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowRunService } from '../../flow/flow-run-service.js';
import { FlowReviewEvidenceAttachment } from '../flow-review-evidence-attachment.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('FlowReviewEvidenceAttachment', () => {
  it('attaches the immutable receipt as audit evidence without minting a verdict', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'station-review-flow-'));
    roots.push(cwd);
    await mkdir(join(cwd, '.flow', 'definitions'), { recursive: true });
    await writeFile(
      join(cwd, '.flow', 'definitions', 'review.json'),
      JSON.stringify({
        id: 'review',
        version: '1',
        steps: [{ id: 'inspect', next: null }],
        gates: {
          'review-gate': { step: 'inspect', expects: [] },
        },
      }),
      'utf8',
    );
    const receiptId = 'a'.repeat(64);
    const receiptPath = join(
      cwd,
      '.station',
      'review-evidence',
      'receipts',
      `${receiptId}.json`,
    );
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, '{}', 'utf8');

    const flowRuns = new FlowRunService();
    await flowRuns.startRun(cwd, { definition: 'review', runId: 'run-1' });
    const attachment = new FlowReviewEvidenceAttachment(flowRuns, () => cwd);
    const attached = await attachment.attach({
      projectSlug: 'station',
      runId: 'run-1',
      gate: 'review-gate',
      receipt: { receiptId } as IndependentReviewReceipt,
    });

    expect(attached.evidenceId).toBeTruthy();
    const run = await flowRuns.getRun(cwd, 'run-1');
    expect(run.manifest.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: attached.evidenceId,
          gate_id: 'review-gate',
          kind: 'custom',
          requested_kind: 'station.review-findings',
          status: 'unknown',
          producer: 'station.review-orchestration',
          authority_trace: receiptId,
        }),
      ]),
    );
    expect(run.state.status).not.toBe('completed');
  });
});
