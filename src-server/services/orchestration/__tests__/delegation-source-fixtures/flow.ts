import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRun } from '@kontourai/flow';
import type { fixture } from './source.js';

export async function createReportFlow(
  f: Pick<Awaited<ReturnType<typeof fixture>>, 'repo' | 'git'>,
  runId: string,
  steps: readonly { id: string; needs?: readonly string[] }[],
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
        steps.map(({ id }) => [
          id,
          {
            step: id,
            expects: [
              {
                id: 'optional',
                kind: 'trust.bundle',
                required: false,
                description: 'Optional controlled evidence',
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
