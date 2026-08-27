/**
 * station#2228 landed `continue-on-error: true` on CI's artifact-upload
 * steps (a storage/quota failure is infrastructure, not a verdict), which
 * the repo-governance rule rejected outright because it forbade the string
 * anywhere in ci.yml. That left main failing its own completion gate, so
 * every branch cut from it inherited the failure.
 *
 * The rule is now scoped to VERDICT-BEARING steps. These pin both halves:
 * diagnostics stay exempt, and anything that could hide a real failure is
 * still blocked — by name.
 */
import { describe, expect, it } from 'vitest';
import { findVerdictBearingContinueOnError } from '../proof-family-lane.mjs';

const uploadStep = `
      - name: Upload bounded fast-feedback diagnostics
        if: always()
        uses: actions/upload-artifact@ea165f8d
        continue-on-error: true
        with:
          name: diagnostics
`;

const runStep = `
      - name: Run fast CI lane
        continue-on-error: true
        run: npm run ci:fast
`;

const usesStep = `
      - name: Dependency advisory floor
        continue-on-error: true
        uses: some/action@v1
`;

const cleanStep = `
      - name: Run fast CI lane
        run: npm run ci:fast
`;

describe('repo-governance continue-on-error scope', () => {
  it('exempts artifact-upload diagnostics', () => {
    expect(findVerdictBearingContinueOnError(uploadStep)).toEqual([]);
  });

  it('blocks a step that runs a command', () => {
    expect(findVerdictBearingContinueOnError(runStep)).toEqual([
      'Run fast CI lane',
    ]);
  });

  it('blocks a non-upload action step', () => {
    expect(findVerdictBearingContinueOnError(usesStep)).toEqual([
      'Dependency advisory floor',
    ]);
  });

  it('blocks an upload step that also runs a command', () => {
    const hybrid = `
      - name: Upload then verify
        uses: actions/upload-artifact@ea165f8d
        continue-on-error: true
        run: npm run verify
`;
    expect(findVerdictBearingContinueOnError(hybrid)).toEqual([
      'Upload then verify',
    ]);
  });

  it('reports nothing when no step opts out', () => {
    expect(findVerdictBearingContinueOnError(cleanStep)).toEqual([]);
  });

  it('names every offender when several steps opt out', () => {
    expect(findVerdictBearingContinueOnError(runStep + usesStep)).toEqual([
      'Run fast CI lane',
      'Dependency advisory floor',
    ]);
  });
});
