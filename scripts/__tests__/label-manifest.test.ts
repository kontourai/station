import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  assertReconcileAuthority,
  EXPECTED_LABEL_NAMES,
  reconcilePlan,
  validateIssueLabelAxes,
  validateLabelManifest,
  validateLiveLabels,
} from '../label-manifest.mjs';

const manifest = JSON.parse(readFileSync('.github/labels.json', 'utf8'));

describe('label manifest', () => {
  test('pins all live labels plus the lifecycle and stage additions', () => {
    expect(manifest.labels).toHaveLength(28);
    expect(validateLabelManifest(manifest)).toEqual([]);
    expect(
      manifest.labels.map(({ name }: { name: string }) => name).sort(),
    ).toEqual([...EXPECTED_LABEL_NAMES].sort());
  });

  test('rejects missing, unexpected, drifted, and blank declarations', () => {
    expect(
      validateLabelManifest({
        ...manifest,
        labels: manifest.labels.slice(1),
      }).join('\n'),
    ).toContain('Missing labels: P1.');
    expect(
      validateLabelManifest({
        ...manifest,
        labels: [
          ...manifest.labels,
          { name: 'surprise', color: '000000', description: 'unexpected' },
        ],
      }).join('\n'),
    ).toContain('Unexpected labels: surprise.');
    expect(
      validateLabelManifest({
        ...manifest,
        labels: manifest.labels.map((label: { name: string }) =>
          label.name === 'P1' ? { ...label, color: 'bad' } : label,
        ),
      }).join('\n'),
    ).toContain("Label 'P1' needs a six-digit color.");
    expect(
      validateLabelManifest({
        ...manifest,
        labels: manifest.labels.map((label: { name: string }) =>
          label.name === 'P1' ? { ...label, description: ' ' } : label,
        ),
      }).join('\n'),
    ).toContain("Label 'P1' needs a nonblank description.");
  });

  test('rejects conflicting axes and retired vocabulary on issues', () => {
    expect(
      validateIssueLabelAxes([
        'P1',
        'P2',
        'needs:maintainer',
        'needs:reporter',
        'stage:source',
        'stage:stable',
        'needs:triage',
      ]),
    ).toEqual([
      "Retired label 'needs:triage' is not allowed.",
      'Conflicting priority labels: P1, P2.',
      'Conflicting lifecycle labels: needs:maintainer, needs:reporter.',
      'Conflicting stage labels: stage:source, stage:stable.',
    ]);
  });

  test('reconciliation can create or update but never silently deletes unexpected labels', () => {
    const plan = reconcilePlan(manifest.labels, [
      { ...manifest.labels[0], color: 'ffffff' },
      { name: 'unexpected', color: '000000', description: 'keep me' },
    ]);
    expect(plan.create).toHaveLength(27);
    expect(plan.update).toEqual([manifest.labels[0]]);
    expect(plan.unexpected).toEqual(['unexpected']);
  });

  test('reports live missing, unexpected, and presentation drift', () => {
    const live = manifest.labels
      .slice(1)
      .map((label: { name: string }) =>
        label.name === 'P2' ? { ...label, description: 'drifted' } : label,
      );
    live.push({ name: 'unexpected', color: '000000', description: 'surprise' });
    expect(validateLiveLabels(manifest.labels, live)).toEqual([
      'Missing live labels: P1.',
      'Unexpected live labels: unexpected.',
      "Live label 'P2' drifts from the manifest.",
    ]);
  });

  test('requires explicit write authorization and exact repository confirmation', () => {
    expect(() => assertReconcileAuthority(['--reconcile'])).toThrow(
      '--write-authorized',
    );
    expect(() =>
      assertReconcileAuthority([
        '--reconcile',
        '--write-authorized',
        '--repo=other/repo',
        '--confirm-repository=other/repo',
      ]),
    ).toThrow('kontourai/station');
    expect(() =>
      assertReconcileAuthority([
        '--reconcile',
        '--write-authorized',
        '--repo=kontourai/station',
        '--confirm-repository=kontourai/station',
      ]),
    ).not.toThrow();
  });
});
