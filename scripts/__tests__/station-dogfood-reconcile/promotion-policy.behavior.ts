import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  adoptLegacyRuntime,
  reconcile,
} from '../../station-dogfood-reconcile.mjs';
import {
  CANDIDATE,
  createFixture,
  LEGACY_IDENTITY,
  MAX_WAIVER_EXPIRY,
  NOW,
  OVERLONG_WAIVER_EXPIRY,
  PREVIOUS,
  WAIVER_SUNSET_MS,
} from './fixture.js';

export function registerPromotionPolicy() {
  describe('station dogfood reconcile', () => {
    it('publishes locally proven candidate health before tailnet readiness', () => {
      const fixture = createFixture({ tailnetRequiresStateHealth: true });

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'promoted', sha: CANDIDATE });
      expect(fixture.state().health).toMatchObject({
        status: 'ready',
        sha: CANDIDATE,
      });
    });

    it('gives the aggregate local ownership probe a loaded-host budget', () => {
      const fixture = createFixture({ minimumHealthTimeoutMs: 10_000 });

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'promoted', sha: CANDIDATE });
      const healthCalls = fixture.calls.filter(
        (call) =>
          call.command === process.execPath &&
          call.args[0]?.endsWith('station-dogfood-health.mjs'),
      );
      expect(healthCalls.length).toBeGreaterThan(0);
      expect(
        healthCalls.every((call) => call.args.includes('--timeout-ms=10000')),
      ).toBe(true);
    });

    it('publishes locally proven current health before tailnet readiness', () => {
      const fixture = createFixture({
        current: true,
        tailnetRequiresStateHealth: true,
      });

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'current', sha: CANDIDATE });
      expect(fixture.state().health).toMatchObject({
        status: 'ready',
        sha: CANDIDATE,
      });
    });

    it('keeps a healthy active release ready when a different candidate CI is pending', () => {
      const fixture = createFixture({
        ci: 'pending',
        tailnetRequiresStateHealth: true,
      });
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const staleState = fixture.state();
      staleState.health = { status: 'unavailable', sha: PREVIOUS };
      writeFileSync(statePath, JSON.stringify(staleState));

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('not completed/success');

      expect(fixture.state().health).toMatchObject({
        status: 'ready',
        sha: PREVIOUS,
      });
      const tailnetReady = fixture.calls.findIndex(
        (call) =>
          call.command === 'curl' &&
          call.args.at(-1) ===
            `${fixture.config.tailnetUrl}/api/system/readiness`,
      );
      const candidateCi = fixture.calls.findIndex(
        (call) => call.command === 'gh',
      );
      expect(tailnetReady).toBeGreaterThanOrEqual(0);
      expect(candidateCi).toBeGreaterThan(tailnetReady);
    });

    it('publishes locally proven recovery health before tailnet readiness', () => {
      const fixture = createFixture({
        current: true,
        currentUnhealthy: true,
        tailnetRequiresStateHealth: true,
      });

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'recovered', sha: CANDIDATE });
      expect(fixture.state().health).toMatchObject({
        status: 'ready',
        sha: CANDIDATE,
      });
    });

    it('verifies tailnet provenance through the public UI identity route when API identity requires authentication', () => {
      const fixture = createFixture({ protectedApiIdentity: true });

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'promoted', sha: CANDIDATE });
      const tailnetCalls = fixture.calls.filter(
        (call) =>
          call.command === 'curl' && call.args.at(-1)?.startsWith('https://'),
      );
      expect(tailnetCalls.map((call) => call.args.at(-1))).toContain(
        `${fixture.config.tailnetUrl}/__station/identity`,
      );
      expect(tailnetCalls.map((call) => call.args.at(-1))).not.toContain(
        `${fixture.config.tailnetUrl}/api/system/identity`,
      );
      expect(tailnetCalls[0]?.args).toEqual([
        '--disable',
        '--proto',
        '=https',
        '--noproxy',
        '*',
        '--max-redirs',
        '0',
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '5',
        `${fixture.config.tailnetUrl}/__station/identity`,
      ]);
    });

    it('rejects a tailnet identity wrapper whose backend readiness is unavailable', () => {
      const fixture = createFixture({ tailnetReadinessFailure: true });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('tailnet readiness unavailable');

      const tailnetRoutes = fixture.calls
        .filter(
          (call) =>
            call.command === 'curl' && call.args.at(-1)?.startsWith('https://'),
        )
        .map((call) => call.args.at(-1));
      expect(tailnetRoutes).toContain(
        `${fixture.config.tailnetUrl}/__station/identity`,
      );
      expect(tailnetRoutes).toContain(
        `${fixture.config.tailnetUrl}/api/system/readiness`,
      );
      expect(fixture.runningSha).toBe(PREVIOUS);
    });

    it('promotes only the exact CI-green origin/main SHA after staging a detached clean release', () => {
      const fixture = createFixture();

      const outcome = reconcile(fixture.config, {
        run: fixture.run,
        now: () => NOW,
      });

      expect(outcome).toMatchObject({
        action: 'promoted',
        sha: CANDIDATE,
        previousSha: PREVIOUS,
        ci: { id: 42 },
      });
      expect(fixture.runningSha).toBe(CANDIDATE);
      expect(fixture.state().active).toMatchObject({ sha: CANDIDATE });
      expect(fixture.state().previous).toMatchObject({ sha: PREVIOUS });
      expect(fixture.state().reconciliation).toMatchObject({
        desired: { sha: CANDIDATE },
        source: { sha: CANDIDATE },
        built: { sha: CANDIDATE, complete: true },
        running: { sha: CANDIDATE },
        phase: 'ready',
        failure: null,
      });
      const gh = fixture.calls.find((call) => call.command === 'gh');
      expect(gh?.args).toEqual(
        expect.arrayContaining([
          '--workflow',
          'CI',
          '--event',
          'push',
          '--branch',
          'main',
        ]),
      );
      const starts = fixture.calls.filter(
        (call) => call.command === './station' && call.args[0] === 'start',
      );
      expect(starts).toHaveLength(1);
      expect(starts[0].args).toEqual(
        expect.arrayContaining([
          '--host=127.0.0.1',
          `--base=${fixture.config.stationHome}`,
          '--instance=dogfood',
        ]),
      );
      expect(starts[0].env?.STATION_HOME).toBe(fixture.config.stationHome);
    });

    it('records a proven zero-step billing failure as infrastructure-waived, never success', () => {
      const fixture = createFixture({ ci: 'failed', billing: 'valid' });
      const expiry = MAX_WAIVER_EXPIRY;

      const outcome = reconcile(fixture.config, {
        run: fixture.run,
        now: () => NOW,
        env: { STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT: expiry },
      });

      expect(outcome).toMatchObject({
        action: 'promoted',
        ci: {
          id: 42,
          outcome: 'infrastructure-waived',
          waiver: {
            sha: CANDIDATE,
            runId: 42,
            failedJobs: [{ id: 91, name: 'Test' }],
            expiresAt: expiry,
          },
        },
      });
      expect(fixture.state().active.ci).toEqual(outcome.ci);
      expect(fixture.calls.filter((call) => call.command === 'gh')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            args: expect.arrayContaining(['run', 'view', '42']),
          }),
          expect.objectContaining({
            args: expect.arrayContaining([
              'api',
              'repos/kontourai/station/check-runs/91/annotations',
            ]),
          }),
        ]),
      );
    });

    // Both sides of the waiver sunset, pinned unconditionally against an
    // injected clock. The installer-level companion
    // (`billing-policy` in cutover-matrix.behavior.ts) can only exercise
    // whichever era the real wall clock is in, because the installer validates
    // the expiry in a subprocess with no clock seam; these two tests are what
    // keep the unreachable era covered at every point in time.
    it('grants the maximum-expiry waiver while the clock is before the sunset', () => {
      const fixture = createFixture({ ci: 'failed', billing: 'valid' });

      expect(
        reconcile(fixture.config, {
          run: fixture.run,
          now: () => WAIVER_SUNSET_MS - 1_000,
          env: {
            STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT: MAX_WAIVER_EXPIRY,
          },
        }),
      ).toMatchObject({
        action: 'promoted',
        ci: {
          outcome: 'infrastructure-waived',
          waiver: { sha: CANDIDATE, expiresAt: MAX_WAIVER_EXPIRY },
        },
      });
      expect(fixture.runningSha).toBe(CANDIDATE);
    });

    it.each([
      ['at the sunset instant', 0],
      ['an hour after the sunset', 60 * 60 * 1_000],
    ] as const)(
      'fails closed on the same maximum-expiry waiver %s',
      (_label, offsetMs) => {
        const fixture = createFixture({ ci: 'failed', billing: 'valid' });

        expect(() =>
          reconcile(fixture.config, {
            run: fixture.run,
            now: () => WAIVER_SUNSET_MS + offsetMs,
            env: {
              STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT: MAX_WAIVER_EXPIRY,
            },
          }),
        ).toThrow('billing waiver policy is missing, expired, or exceeds');
        expect(fixture.runningSha).toBe(PREVIOUS);
      },
    );

    it.each([
      ['steps', 'zero-step failed jobs'],
      ['nonbilling', 'exact billing/spending-limit annotation'],
      ['missing-annotation', 'exact billing/spending-limit annotation'],
      ['extra-annotation', 'exact billing/spending-limit annotation'],
      ['duplicate-run', 'exactly one non-success CI push run'],
      ['cancelled-job', 'zero-step failed jobs'],
      ['no-failed', 'at least one proven failed job'],
      ['malformed-jobs', 'invalid JSON while checking billing-failed jobs'],
      [
        'malformed-annotations',
        'invalid JSON while checking billing annotations',
      ],
    ] as const)(
      'rejects billing waiver evidence with %s',
      (billing, message) => {
        const fixture = createFixture({ ci: 'failed', billing });
        expect(() =>
          reconcile(fixture.config, {
            run: fixture.run,
            now: () => NOW,
            env: {
              STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT: MAX_WAIVER_EXPIRY,
            },
          }),
        ).toThrow(message);
        expect(fixture.runningSha).toBe(PREVIOUS);
      },
    );

    it('rejects a mismatched healthy wildcard alias using its persisted adoption authority', () => {
      const fixture = createFixture({ legacyHost: '0.0.0.0' });
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const state = fixture.state();
      state.active.runtimePath = realpathSync(state.active.path);
      state.active.adoptedIdentity = LEGACY_IDENTITY;
      state.active.adoptedAllowWildcardHost = true;
      writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

      expect(() =>
        adoptLegacyRuntime(
          fixture.config,
          {
            legacyPath: state.active.path,
            legacyIdentity: {
              ...LEGACY_IDENTITY,
              bootId: '99999999-1111-4111-8111-111111111111',
            },
            instanceState: path.join(
              state.active.path,
              '.station',
              'instances',
              'dogfood.json',
            ),
            inactiveCanonicalState: state,
          },
          {
            run: fixture.run,
            now: () => NOW,
            proveMigrationAuthority: () => true,
          },
        ),
      ).toThrow('refuses to replace a healthy canonical release');
      expect(
        fixture.calls.some(
          (call) =>
            call.command === process.execPath &&
            call.args.includes('--allow-wildcard-host'),
        ),
      ).toBe(true);
    });

    // Labelled rather than interpolating the expiry, so the derived
    // `OVERLONG_WAIVER_EXPIRY` date never reaches the checked-in
    // scenario-names.json manifest: a policy revision should not have to
    // regenerate that gate.
    it.each([
      ['missing', undefined],
      ['already expired', '2026-07-01T00:00:00.000Z'],
      ['one millisecond past the maximum', OVERLONG_WAIVER_EXPIRY],
    ] as const)('rejects a %s billing waiver policy', (_label, expiry) => {
      const fixture = createFixture({ ci: 'failed', billing: 'valid' });
      expect(() =>
        reconcile(fixture.config, {
          run: fixture.run,
          now: () => NOW,
          env: expiry
            ? { STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT: expiry }
            : {},
        }),
      ).toThrow('billing waiver policy is missing, expired, or exceeds');
      expect(fixture.runningSha).toBe(PREVIOUS);
    });

    it.each([
      ['pending', 'status=in_progress'],
      ['cancelled', 'conclusion=cancelled'],
      ['malformed', 'invalid JSON while checking the exact CI run'],
    ] as const)('never waives a %s provider run', (ci, message) => {
      const fixture = createFixture({ ci, billing: 'valid' });
      expect(() =>
        reconcile(fixture.config, {
          run: fixture.run,
          now: () => NOW,
          env: {
            STATION_DOGFOOD_CI_BILLING_WAIVER_EXPIRES_AT: MAX_WAIVER_EXPIRY,
          },
        }),
      ).toThrow(message);
    });

    it('resumes an immutable built candidate without reinstalling or rebuilding', () => {
      const fixture = createFixture({ stagedCandidate: true });

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'promoted', sha: CANDIDATE });
      expect(fixture.runningSha).toBe(CANDIDATE);
      expect(fixture.calls.some((call) => call.command === 'npm')).toBe(false);
      expect(
        fixture.calls.some(
          (call) => call.command === './station' && call.args[0] === 'build',
        ),
      ).toBe(false);
    });

    it('stages while the old running copy serves, then resumes promotion', () => {
      const fixture = createFixture();

      expect(
        reconcile(fixture.config, {
          run: fixture.run,
          now: () => NOW,
          stageOnly: true,
        }),
      ).toMatchObject({
        action: 'staged',
        sha: CANDIDATE,
        runningSha: PREVIOUS,
      });
      expect(fixture.runningSha).toBe(PREVIOUS);
      expect(
        fixture.calls.some(
          (call) => call.command === './station' && call.args[0] === 'stop',
        ),
      ).toBe(false);

      const callCount = fixture.calls.length;
      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'promoted', sha: CANDIDATE });
      expect(
        fixture.calls.slice(callCount).some((call) => call.command === 'npm'),
      ).toBe(false);
    });

    it.each(['source-resolved', 'staging'] as const)(
      'immediately resumes an interrupted %s stage despite a fresh remote poll timestamp',
      (phase) => {
        const fixture = createFixture();
        const statePath = path.join(fixture.config.supportDir, 'state.json');
        const state = fixture.state();
        state.lastRemoteCheckAt = new Date(NOW).toISOString();
        state.reconciliation = {
          desired: { sha: CANDIDATE },
          source: { sha: CANDIDATE, repo: fixture.config.repo },
          built:
            phase === 'staging'
              ? {
                  sha: CANDIDATE,
                  path: path.join(
                    fixture.config.supportDir,
                    'releases',
                    CANDIDATE,
                  ),
                  complete: false,
                }
              : null,
          running: { sha: PREVIOUS },
          phase,
          updatedAt: new Date(NOW).toISOString(),
          failure: null,
        };
        writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

        expect(
          reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
        ).toMatchObject({ action: 'promoted', sha: CANDIDATE });
        expect(
          fixture.calls.some(
            (call) => call.command === 'git' && call.args.includes('fetch'),
          ),
        ).toBe(true);
      },
    );
  });
}
