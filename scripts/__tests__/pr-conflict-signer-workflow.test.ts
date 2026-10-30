import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { expect, test } from 'vitest';

test('diagnostic workflow isolates signing from candidate source and cannot write statuses', () => {
  const caller = load(
    readFileSync('.github/workflows/pr-conflict-signer-diagnostic.yml', 'utf8'),
  ) as any;
  const signer = load(
    readFileSync('.github/workflows/pr-conflict-admission.yml', 'utf8'),
  ) as any;
  expect(Object.keys(caller.on)).toEqual(['workflow_dispatch']);
  expect(Object.keys(caller.on.workflow_dispatch.inputs)).toEqual(['pr']);
  expect(caller.permissions).toEqual({});
  expect(Object.keys(caller.jobs)).toEqual(['sign']);
  expect(caller.jobs.sign.if).toBe("github.ref == 'refs/heads/main'");
  expect(caller.jobs.sign.uses).toBe(
    './.github/workflows/pr-conflict-admission.yml',
  );
  expect(caller.jobs.sign.permissions).toEqual({
    contents: 'read',
    'pull-requests': 'read',
    attestations: 'write',
    'id-token': 'write',
  });
  expect(Object.keys(signer.on)).toEqual(['workflow_call']);
  expect(Object.keys(signer.on.workflow_call.inputs)).toEqual(['pr']);
  expect(signer.permissions).toEqual({});
  expect(Object.keys(signer.jobs)).toEqual(['diagnostic']);
  const job = signer.jobs.diagnostic;
  expect(job.permissions).toEqual(caller.jobs.sign.permissions);
  const checkout = job.steps.find((step: any) =>
    String(step.uses).startsWith('actions/checkout@'),
  );
  expect(checkout.with).toEqual({
    ref: '${{ github.workflow_sha }}',
    'persist-credentials': false,
  });
  expect(job.steps.map((step: any) => step.name).filter(Boolean)).toEqual([
    'Create nonqualifying diagnostic receipt',
    'Attest diagnostic receipt',
    'Upload diagnostic receipt',
  ]);
  expect(job.steps.at(-1).with.name).toBe(
    'conflict-signer-diagnostic-${{ github.run_id }}-${{ github.run_attempt }}',
  );
  expect(
    job.steps
      .filter((step: any) => step.uses)
      .every((step: any) => /@[a-f0-9]{40}$/.test(step.uses)),
  ).toBe(true);
});
