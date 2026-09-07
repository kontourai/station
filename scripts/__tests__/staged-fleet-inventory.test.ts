import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import plan from '../../config/nightly-fleet-staging-plan.json' with {
  type: 'json',
};
import {
  admitFixedInventory,
  assertStaticPlan,
  contentDigest,
  createStageReceipt,
  parseVerifiedAttestation,
} from '../staged-fleet-inventory.mjs';

const roots: string[] = [];
const sourceSha = 'a'.repeat(40);
const planDigest = createHash('sha256')
  .update(`${JSON.stringify(plan, null, 2)}\n`)
  .digest('hex');
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);

function fixture() {
  const assetsDir = mkdtempSync(join(tmpdir(), 'station-portable-stage-'));
  roots.push(assetsDir);
  for (const name of plan.requiredArtifacts)
    writeFileSync(join(assetsDir, name), `${name}\n`);
  const input = {
    id: 'portable-server',
    sourceSha,
    workflowRunId: '12345',
    cohortId: `nightly-${sourceSha}-12345`,
    cohortPlanDigest: planDigest,
    platform: 'web-portable',
    variant: 'portable-server',
    stageState: 'STAGED',
    publicationState: 'NOT_PUBLISHED',
    installState: 'NOT_INSTALLED',
    updateState: 'NOT_UPDATED',
    platformSigningState: 'UNSUPPORTED',
    updaterSigningState: 'UNSUPPORTED',
    artifacts: plan.requiredArtifacts,
    checks: [
      {
        id: 'portable-manifest-and-checksum',
        result: 'PASSED',
        evidence: 'portable-build-check.json',
      },
    ],
    sbom: { state: 'GENERATED', artifact: 'portable-sbom.cdx.json' },
    attestation: { subjects: plan.requiredArtifacts },
  };
  const receipt = createStageReceipt(input, { assetsDir });
  const verification = receipt.attestation.subjects.map(
    (subject: { sha256: string }, _index: number) => [
      {
        verificationResult: {
          signature: {
            certificate: {
              subjectAlternativeName:
                'https://github.com/kontourai/station/.github/workflows/nightly-fleet-staging.yml@refs/heads/main',
              issuer: 'https://token.actions.githubusercontent.com',
              certificateIssuer: 'Fulcio',
              runInvocationURI:
                'https://github.com/kontourai/station/actions/runs/12345',
            },
          },
          statement: {
            subject: [{ digest: { sha256: subject.sha256 } }],
            predicate: {
              buildDefinition: {
                resolvedDependencies: [
                  {
                    uri: 'git+https://github.com/kontourai/station@refs/heads/main',
                    digest: { gitCommit: sourceSha },
                  },
                ],
              },
            },
          },
          verifiedTimestamps: [
            {
              timestamp: new Date().toISOString(),
              type: 'tlog',
              uri: 'https://rekor.sigstore.dev',
            },
          ],
        },
      },
    ],
  );
  verification.forEach((value: unknown, index: number) =>
    writeFileSync(
      join(assetsDir, `attestation-verify-${index}.json`),
      JSON.stringify(value),
    ),
  );
  return { assetsDir, receipt, verification };
}

describe('portable fixed staging inventory', () => {
  test('admits one fixed portable receipt with ordered proof mapping and no delivery claim', () => {
    const { assetsDir, receipt } = fixture();
    const admitted: any = admitFixedInventory(plan, receipt, {
      assetsDir,
      planDigest,
    });
    expect(admitted.requiredVariants).toEqual(['portable-server']);
    expect(admitted.requiredArtifacts).toEqual(plan.requiredArtifacts);
    expect(
      admitted.attestationVerification.subjects.map(
        (item: { name: string }) => item.name,
      ),
    ).toEqual(plan.requiredArtifacts);
    expect(admitted.aggregate).toMatchObject({
      state: 'STAGED_COMPLETE',
      publicationState: 'NOT_PUBLISHED',
      installState: 'NOT_INSTALLED',
      updateState: 'NOT_UPDATED',
    });
    expect(admitted.admissionContentDigest).toBe(
      contentDigest(admitted, ['admissionContentDigest']),
    );
  });

  test.each([
    ['missing variant', (value: any) => value.requiredVariants.pop()],
    [
      'extra variant',
      (value: any) => value.requiredVariants.push('windows-msi'),
    ],
    ['missing artifact', (value: any) => value.requiredArtifacts.pop()],
    [
      'extra artifact',
      (value: any) => value.requiredArtifacts.push('windows.msi'),
    ],
  ])('rejects static plan with %s', (_name, mutate) => {
    const value = structuredClone(plan);
    mutate(value);
    expect(() => assertStaticPlan(value, planDigest)).toThrow(/static plan/);
  });

  test('rejects an extra receipt artifact and an unsafe symlink before admission', () => {
    const { assetsDir, receipt } = fixture();
    receipt.artifacts.push({
      name: 'extra.bin',
      sha256: 'b'.repeat(64),
      size: 1,
    });
    expect(() =>
      admitFixedInventory(plan, receipt, { assetsDir, planDigest }),
    ).toThrow(/artifact path|content digest|subjects|fixed plan/);
    const second = fixture();
    rmSync(join(second.assetsDir, 'attestation-verify-0.json'));
    symlinkSync(
      'portable-build-check.json',
      join(second.assetsDir, 'attestation-verify-0.json'),
    );
    expect(() =>
      admitFixedInventory(plan, second.receipt, {
        assetsDir: second.assetsDir,
        planDigest,
      }),
    ).toThrow(/direct file/);
  });

  test('requires authenticated verifier fields, never an invented verified boolean', () => {
    const { receipt, verification } = fixture();
    expect(
      parseVerifiedAttestation(
        verification[0],
        receipt.attestation.subjects[0],
        sourceSha,
        '12345',
      ),
    ).toMatchObject({ sourceSha, authenticatedWorkflowRunId: '12345' });
    verification[0][0].verificationResult.signature.certificate.runInvocationURI =
      'https://github.com/kontourai/station/actions/runs/7';
    expect(() =>
      parseVerifiedAttestation(
        verification[0],
        receipt.attestation.subjects[0],
        sourceSha,
        '12345',
      ),
    ).toThrow(/exactly one/);
  });
});
