import { describe, expect, test } from 'vitest';
import {
  assertDeterministicBaseline,
  compareTransferEvidence,
} from '../orchestration-transfer-budget.mjs';

const base = {
  schemaVersion: 1,
  subjectSha: 'a'.repeat(40),
  baseSha: 'a'.repeat(40),
  dirty: false,
  fixtureDigest: 'fixture',
  toolDigest: 'b'.repeat(64),
  node: 'v24',
  platform: 'darwin',
  arch: 'arm64',
  phases: ['external-engine', 'station-native'].flatMap((scenario) =>
    ['initialEventWindow', 'snapshot', 'live', 'shortReplay', 'fallback'].map(
      (name) => ({
        scenario,
        name,
        wireBytes: 1,
        decodedBytes: 1,
        frames: 1,
        contentEncoding: 'identity',
        compressionRatio: null,
        complete: true,
      }),
    ),
  ),
};
base.fixtureDigest = 'a'.repeat(64);
const policy = Object.fromEntries(
  base.phases.map((phase) => [
    phase.name,
    { wireBytes: 2, decodedBytes: 2, frames: 2 },
  ]),
);

describe('orchestration transfer budget comparator', () => {
  test('fails closed for malformed and over-budget candidate evidence', () => {
    expect(() =>
      compareTransferEvidence(
        { ...base, baseSha: base.subjectSha, dirty: true },
        base,
        policy,
        { candidateSha: base.subjectSha, baseSha: base.subjectSha },
      ),
    ).toThrow('not a clean');
    const candidate = structuredClone({ ...base, baseSha: base.subjectSha });
    candidate.phases[2].wireBytes = 3;
    expect(() =>
      compareTransferEvidence(candidate, base, policy, {
        candidateSha: base.subjectSha,
        baseSha: base.subjectSha,
      }),
    ).toThrow('WIRE_BUDGET_EXCEEDED_external-engine_live');
  });

  test('requires an exact matching main baseline', () => {
    expect(() =>
      compareTransferEvidence(
        { ...base, baseSha: 'b'.repeat(40) },
        base,
        policy,
        { candidateSha: base.subjectSha, baseSha: base.subjectSha },
      ),
    ).toThrow('matching exact candidate/base SHAs');
  });

  test('requires both baseline captures to agree exactly', () => {
    const baselineB = structuredClone({ ...base, baseSha: base.subjectSha });
    baselineB.phases[7].decodedBytes = 2;
    expect(() => assertDeterministicBaseline(base, baselineB)).toThrow(
      'baseline A/B measurement disagreement',
    );
  });
});
