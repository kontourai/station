import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type Job = {
  outputs?: Record<string, unknown>;
  steps?: Step[];
};
type Workflow = {
  on?: Record<string, any>;
  jobs?: Record<string, Job>;
};

function workflow(name: string): Workflow {
  return load(
    readFileSync(resolve(root, '.github/workflows', name), 'utf8'),
  ) as Workflow;
}

function namedStep(job: Job, name: string): Step {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing workflow step: ${name}`);
  return step;
}

describe('one-revision native promotion contract', () => {
  test('binds Nightly test, Android, and desktop to one validated main SHA', () => {
    const nightly = workflow('nightly.yml');
    expect(nightly.on?.workflow_dispatch?.inputs?.source_sha).toMatchObject({
      required: false,
    });
    const gate = nightly.jobs?.['test-gate'];
    const android = nightly.jobs?.nightly;
    const desktop = nightly.jobs?.['nightly-desktop'];
    expect(gate?.outputs?.source_sha).toBe(
      '$' + '{{ steps.source.outputs.sha }}',
    );
    const source = namedStep(
      gate ?? {},
      'Bind every Nightly leg to one main revision',
    );
    expect(source.run).toContain('git merge-base --is-ancestor');
    expect(source.run).toContain('40 lowercase hexadecimal');
    for (const job of [android, desktop]) {
      const checkout = job?.steps?.find((step) =>
        step.uses?.includes('actions/checkout'),
      );
      expect(checkout?.with?.ref).toBe(
        '$' + '{{ needs.test-gate.outputs.source_sha }}',
      );
    }
  });

  test('makes stable TestFlight publication and provider receipt fail closed', () => {
    const release = workflow('release.yml');
    const ios = release.jobs?.['ios-device'] ?? {};
    const importMaterial = namedStep(
      ios,
      'Import protected Apple signing and store material',
    );
    for (const required of [
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER_ID',
      'APPLE_API_PRIVATE_KEY',
    ]) {
      expect(importMaterial.run).toContain(required);
    }
    const upload = namedStep(ios, 'Upload to TestFlight');
    expect(upload.id).toBe('testflight_upload');
    expect(upload.with?.['wait-for-processing']).toBe('true');
    expect((upload as any).if).toBeUndefined();
    expect(
      ios.steps?.some((step) => step.name === 'Note skipped TestFlight upload'),
    ).toBe(false);

    const preflight = namedStep(ios, 'Verify App Store Connect app authority');
    const receipt = namedStep(
      ios,
      'Record the processed TestFlight build receipt',
    );
    const retain = namedStep(ios, 'Retain TestFlight provider receipts');
    expect(preflight.run).toContain('app-preflight');
    expect(receipt.run).toContain('build-receipt');
    expect(receipt.run).toContain('needs.preflight.outputs.sha');
    expect(retain.with?.name).toBe('station-ios-testflight-receipts');
  });
});
