import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRun } from '@kontourai/flow';
import type { fixture } from './source.js';

export async function createReportFlow(
  f: Pick<Awaited<ReturnType<typeof fixture>>, 'repo' | 'git'>,
  runId: string,
  steps: readonly {
    id: string;
    needs?: readonly string[];
    requiredEvidence?: boolean;
    routeBack?: string;
  }[],
) {
  const definitionPath = join(f.repo, 'report-flow.json');
  writeFileSync(
    definitionPath,
    JSON.stringify({
      id: 'report-http',
      version: '1',
      execution: { mode: 'multi-cursor', claim_contract_version: '1' },
      steps: steps.map(({ id, needs }) => ({
        id,
        next: null,
        mutable_resources: [],
        ...(needs ? { needs } : {}),
      })),
      gates: Object.fromEntries(
        steps.map(({ id, requiredEvidence, routeBack }) => [
          id,
          {
            step: id,
            ...(routeBack
              ? {
                  on_route_back: { missing_evidence: routeBack },
                  route_back_policy: { max_attempts: 1, on_exceeded: 'block' },
                }
              : {}),
            expects: [
              {
                id: 'optional',
                kind: 'trust.bundle',
                required: requiredEvidence ?? false,
                description: 'Controlled evidence requirement',
                bundle_claim: { claimType: 'fixture.optional' },
              },
            ],
          },
        ]),
      ),
    }),
  );
  writeFileSync(join(f.repo, '.gitignore'), '.kontourai/\n');
  await f.git('add', 'report-flow.json', '.gitignore');
  await f.git('commit', '-qm', 'controlled public Flow topology');
  await startRun(definitionPath, { cwd: f.repo, runId });
  return { runId, steps: Object.fromEntries(steps.map(({ id }) => [id, id])) };
}
