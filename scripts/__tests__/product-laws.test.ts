import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { ProductLawObservation } from '../lib/product-laws.mjs';
import {
  evaluateProductLawManifest,
  formatProductLawReport,
  loadProductLawManifest,
  MAX_PRODUCT_LAW_FILES,
  MAX_PRODUCT_LAWS,
  PRODUCT_LAW_OBSERVATION_TIMEOUT_MS,
  productLawDispositions,
  productLawObservationTimeoutMs,
  renderProductLawSection,
  validateProductLawManifest,
} from '../lib/product-laws.mjs';
import {
  observeLawTest,
  runProductLawGate,
  structuredLawObservationVerdict,
} from '../product-law-gate.mjs';

const rootDir = process.cwd();
const manifest = loadProductLawManifest({ rootDir });
type ObserveLawSpawnProcess = NonNullable<
  NonNullable<Parameters<typeof observeLawTest>[1]>['spawnProcess']
>;

function faulted(lawId: string, mutate: (law: any) => void) {
  const copy = structuredClone(manifest);
  const law = copy.laws.find(
    (candidate: { id: string }) => candidate.id === lawId,
  );
  if (!law) throw new Error(`missing fixture law ${lawId}`);
  mutate(law);
  return validateProductLawManifest(copy, { rootDir });
}

describe('executable product-law manifest', () => {
  test('declares one bounded behavior and fault observation in each initial family', () => {
    expect(validateProductLawManifest(manifest, { rootDir })).toEqual([]);
    expect(manifest.laws).toHaveLength(MAX_PRODUCT_LAWS);
    expect(
      new Set(
        manifest.laws.flatMap((law: any) => [
          law.observation.testFile,
          law.faultInjection.testFile,
        ]),
      ).size,
    ).toBeLessThanOrEqual(MAX_PRODUCT_LAW_FILES);
    expect(renderProductLawSection(manifest)).toBe(
      readFileSync(resolve(rootDir, 'docs/reference/product-laws.md'), 'utf8'),
    );
    const reference = readFileSync(
      resolve(rootDir, 'docs/reference/product-laws.md'),
      'utf8',
    );
    for (const law of manifest.laws) {
      expect(reference).toContain(law.id);
      expect(reference).toContain(law.observation.selector);
      expect(reference).toContain(law.faultInjection.selector);
    }
  });

  test('fails closed for malformed declarations, including an absent behavioral fault injection', () => {
    expect(
      faulted('station.queue-dispatch.ordered-drain', (law) => {
        law.observation.selector = '';
      }),
    ).toContain(
      'product law station.queue-dispatch.ordered-drain has an empty observation selector',
    );
    expect(
      faulted('station.queue-dispatch.ordered-drain', (law) => {
        law.observation.selector = 'a selector that is absent from its test';
      }),
    ).toContain(
      'product law station.queue-dispatch.ordered-drain observation selector is absent from src-ui/src/hooks/orchestration/__tests__/queueDrain.test.ts',
    );
    expect(
      faulted('station.lifecycle-completion.gate-derived', (law) => {
        law.faultInjection = { kind: 'not-verified' };
      }),
    ).toContain(
      'product law station.lifecycle-completion.gate-derived has no executable faultInjection vitest-file observation',
    );
    expect(
      faulted('station.approvals.actionable-resolution', (law) => {
        law.remediationOwner = '';
      }),
    ).toContain(
      'product law station.approvals.actionable-resolution is missing remediationOwner',
    );
    expect(
      faulted('station.home-role.recovery-floor', (law) => {
        law.observation.testFile =
          'src-ui/src/views/home/__tests__/missing.test.tsx';
      }),
    ).toContain(
      'product law station.home-role.recovery-floor observation testFile does not exist: src-ui/src/views/home/__tests__/missing.test.tsx',
    );
    const duplicate = structuredClone(manifest);
    duplicate.laws[4].id = duplicate.laws[0].id;
    expect(validateProductLawManifest(duplicate, { rootDir })).toContain(
      'product law station.queue-dispatch.ordered-drain is duplicated',
    );
  });

  test('records each law from its own behavior and fault-injection result', async () => {
    const calls: ProductLawObservation[] = [];
    const pass = await evaluateProductLawManifest(manifest, {
      observeLawTest: async (observation: ProductLawObservation) => {
        calls.push(observation);
        return { status: 'PASS' };
      },
    });
    expect(calls).toHaveLength(manifest.laws.length * 2);
    expect(calls.filter((call) => call.phase === 'behavior')).toHaveLength(
      manifest.laws.length,
    );
    expect(
      calls.filter((call) => call.phase === 'fault-injection'),
    ).toHaveLength(manifest.laws.length);
    expect(pass.status).toBe('PASS');

    const failure = await evaluateProductLawManifest(manifest, {
      observeLawTest: async (observation: ProductLawObservation) =>
        observation.lawId === 'station.approvals.actionable-resolution' &&
        observation.phase === 'fault-injection'
          ? { status: 'FAIL' }
          : { status: 'PASS' },
    });
    expect(
      failure.observations.find(
        (observation) =>
          observation.id === 'station.approvals.actionable-resolution',
      ),
    ).toMatchObject({
      status: 'FAIL',
      behavior: { status: 'PASS' },
      faultInjection: { status: 'FAIL' },
    });
    expect(
      failure.observations.filter(
        (observation) =>
          observation.id !== 'station.approvals.actionable-resolution',
      ),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'PASS' })]),
    );
    expect(formatProductLawReport(failure)).toContain(
      '[product-laws] FAIL station.approvals.actionable-resolution behavior=PASS fault-injection=FAIL',
    );
    expect(formatProductLawReport(failure)).toContain(
      'overall=FAIL failed=1 infrastructureErrors=0',
    );

    const unavailable = await evaluateProductLawManifest(manifest, {
      observeLawTest: async (observation: ProductLawObservation) =>
        observation.lawId === 'station.release-stage.inventory-truth'
          ? { status: 'NOT_VERIFIED' }
          : { status: 'PASS' },
    });
    expect(
      unavailable.observations.find(
        (observation) =>
          observation.id === 'station.release-stage.inventory-truth',
      ),
    ).toMatchObject({ status: 'NOT_VERIFIED' });
  });

  test('dispositions every owned behavior/work-area change to its law ID', () => {
    expect(
      productLawDispositions(manifest, [
        'src-ui/src/hooks/orchestration/queueDrain.ts',
        'src-server/services/approvals/approval-inbox.ts',
      ]),
    ).toEqual([
      'station.queue-dispatch.ordered-drain',
      'station.approvals.actionable-resolution',
    ]);
    expect(productLawDispositions(manifest, ['README.md'])).toEqual([]);
  });

  test('accepts only one structured passing result for the exact named test', () => {
    const selector = 'exact observable behavior';
    expect(
      structuredLawObservationVerdict(
        {
          testResults: [
            { assertionResults: [{ title: selector, status: 'passed' }] },
          ],
        },
        selector,
      ),
    ).toEqual({ status: 'PASS' });
    expect(
      structuredLawObservationVerdict(
        {
          testResults: [
            { assertionResults: [{ title: selector, status: 'skipped' }] },
          ],
        },
        selector,
      ),
    ).toMatchObject({ status: 'NOT_VERIFIED' });
    expect(
      structuredLawObservationVerdict(
        {
          testResults: [
            { assertionResults: [{ title: selector, status: 'passed' }] },
            { assertionResults: [{ title: selector, status: 'passed' }] },
          ],
        },
        selector,
      ),
    ).toMatchObject({ status: 'NOT_VERIFIED' });
  });

  test('a failed observation carries the assertion failure text so CI is diagnosable', () => {
    const selector = 'exact observable behavior';
    expect(
      structuredLawObservationVerdict(
        {
          testResults: [
            {
              assertionResults: [
                {
                  title: selector,
                  status: 'failed',
                  failureMessages: [
                    'AssertionError: expected pass to be route-back',
                  ],
                },
              ],
            },
          ],
        },
        selector,
      ),
    ).toEqual({
      status: 'FAIL',
      reason: 'AssertionError: expected pass to be route-back',
    });
    // A failed result with no messages still fails, without inventing text.
    expect(
      structuredLawObservationVerdict(
        {
          testResults: [
            { assertionResults: [{ title: selector, status: 'failed' }] },
          ],
        },
        selector,
      ),
    ).toEqual({ status: 'FAIL' });
  });

  test('classifies a tiny env-configured observation timeout as infrastructure, while law failures remain failed', async () => {
    const child = new EventEmitter() as EventEmitter & {
      signals: string[];
      kill: (signal: string) => boolean;
    };
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      if (signal === 'SIGTERM')
        queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    const spawnProcess = (() => child) as unknown as ObserveLawSpawnProcess;
    let observed = false;
    const result = await runProductLawGate({
      rootDir,
      env: { PRODUCT_LAW_OBSERVATION_TIMEOUT_MS: '1' },
      observe: async (observation) => {
        if (observed) return { status: 'PASS' };
        observed = true;
        return observeLawTest(observation, {
          rootDir,
          spawnProcess,
          killGraceMs: 1,
        });
      },
    });
    expect(child.signals).toEqual(['SIGTERM']);
    expect(result.errors).toEqual([
      'product-law observations are INFRASTRUCTURE_ERROR',
    ]);
    expect(result.report).toMatchObject({ status: 'INFRASTRUCTURE_ERROR' });
    const formatted = formatProductLawReport(result.report!);
    expect(formatted).toContain('timed out after 1ms');
    expect(formatted).toContain(
      'overall=INFRASTRUCTURE_ERROR failed=0 infrastructureErrors=1',
    );

    const failing = await evaluateProductLawManifest(manifest, {
      observeLawTest: async () => ({ status: 'FAIL' }),
    });
    expect(failing.status).toBe('FAIL');
  });

  test('uses only a positive finite environment timeout override', () => {
    expect(
      productLawObservationTimeoutMs({
        PRODUCT_LAW_OBSERVATION_TIMEOUT_MS: '2.5',
      }),
    ).toBe(2.5);
    for (const invalid of ['', 'garbage', '-1', 'Infinity'])
      expect(
        productLawObservationTimeoutMs({
          PRODUCT_LAW_OBSERVATION_TIMEOUT_MS: invalid,
        }),
      ).toBe(PRODUCT_LAW_OBSERVATION_TIMEOUT_MS);
  });
});

describe('productLawGateExitCode (station#4132)', () => {
  test('maps every failing status to its contract exit code', async () => {
    const { productLawGateExitCode } = await import('../product-law-gate.mjs');
    const { PRODUCT_LAW_TIMEOUT_EXIT_CODE } = await import(
      '../lib/product-laws.mjs'
    );
    expect(productLawGateExitCode('INFRASTRUCTURE_ERROR')).toBe(
      PRODUCT_LAW_TIMEOUT_EXIT_CODE,
    );
    expect(productLawGateExitCode('NOT_VERIFIED')).toBe(2);
    expect(productLawGateExitCode('FAILED')).toBe(1);
    expect(productLawGateExitCode(undefined)).toBe(1);
  });
});
