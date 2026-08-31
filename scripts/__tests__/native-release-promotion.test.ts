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
    const caller = release.jobs?.['ios-device'] ?? {};
    const nightly = workflow('nightly.yml');
    const nightlyCaller = nightly.jobs?.['nightly-ios'] ?? {};
    const delivery = workflow('testflight-delivery.yml');
    const ios = delivery.jobs?.deliver ?? {};
    expect(
      namedStep(ios, 'Import protected signing material bound to this channel'),
    ).toBeDefined();
    for (const required of [
      'APPLE_API_KEY_ID',
      'APPLE_API_ISSUER_ID',
      'APPLE_API_PRIVATE_KEY',
    ]) {
      expect(
        readFileSync(
          resolve(root, '.github/workflows/testflight-delivery.yml'),
          'utf8',
        ),
      ).toContain(required);
    }
    const upload = namedStep(
      ios,
      'Upload a previously unobserved IPA to TestFlight',
    );
    expect(upload.with?.['wait-for-processing']).toBe('true');
    expect((upload as any).if).toContain(
      "steps.reconcile.outputs.upload == 'true'",
    );
    expect(
      ios.steps?.some((step) => step.name === 'Note skipped TestFlight upload'),
    ).toBe(false);

    const preflight = namedStep(
      ios,
      'Verify App Store Connect app authority before signing',
    );
    const receipt = namedStep(
      ios,
      'Record processed provider receipt and attach the channel group',
    );
    const retain = ios.steps?.find((step) =>
      step.uses?.includes('upload-artifact'),
    );
    expect(preflight.run).toContain('app-preflight');
    expect(receipt.run).toContain('build-receipt');
    expect(receipt.run).toContain('inputs.source_sha');
    expect(retain?.with?.name).toContain(
      'station-$' + '{{ inputs.channel }}-ios-testflight',
    );
    expect((caller as any).uses).toBe(
      './.github/workflows/testflight-delivery.yml',
    );
    expect((nightlyCaller as any).uses).toBe(
      './.github/workflows/testflight-delivery.yml',
    );
    for (const input of [
      'update_feed_url',
      'update_provider_origin',
      'update_action_url',
      'update_action_kind',
      'update_action_origins',
    ]) {
      expect(delivery.on?.workflow_call?.inputs?.[input]?.required).toBe(false);
      expect((caller as any).with?.[input]).toBeDefined();
      expect((nightlyCaller as any).with?.[input]).toBeDefined();
    }
  });

  test('keeps TestFlight authoritative when no custom feed is configured', () => {
    const release = workflow('release.yml');
    const delivery = workflow('testflight-delivery.yml');
    const ios = delivery.jobs?.deliver ?? {};
    const required = namedStep(
      ios,
      'Fail closed on channel-owned secrets and exact iOS identity',
    );
    const authority = namedStep(ios, 'Resolve optional custom iOS update feed');
    expect(required.run).not.toContain('VITE_NATIVE_APP_UPDATE_FEED_URL');
    expect(required.run).not.toContain('NATIVE_APP_UPDATE_ACTION_URL');
    expect(authority.run).toContain('write-authority-receipt');
    expect(authority.run).toContain('testflight-update-authority.json');
    expect(authority.run).toContain('--platform ios');

    const iosDependencies = ios.steps?.findIndex(
      (step) => step.run === 'npm run dependencies:ci',
    );
    const iosAuthority = ios.steps?.findIndex(
      (step) => step.name === 'Resolve optional custom iOS update feed',
    );
    expect(iosDependencies).toBeGreaterThanOrEqual(0);
    expect(iosAuthority).toBeGreaterThan(iosDependencies ?? -1);

    const android = release.jobs?.android ?? {};
    const androidDependencies = android.steps?.findIndex(
      (step) =>
        step.name ===
        'Install dependencies before resolving the native update feed',
    );
    const androidAuthority = android.steps?.findIndex(
      (step) => step.name === 'Resolve native update feed contract',
    );
    expect(androidDependencies).toBeGreaterThanOrEqual(0);
    expect(androidAuthority).toBeGreaterThan(androidDependencies ?? -1);
  });
});
