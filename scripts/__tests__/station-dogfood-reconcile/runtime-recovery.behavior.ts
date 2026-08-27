import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { reconcile, validateConfig } from '../../station-dogfood-reconcile.mjs';
import {
  CANDIDATE,
  createFixture,
  fixtureRoot,
  NOW,
  PREVIOUS,
} from './fixture.js';

export function registerRuntimeRecovery() {
  describe('station dogfood reconcile', () => {
    it('recovers an unhealthy current release from its recorded build', () => {
      const fixture = createFixture({ currentUnhealthy: true });

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'recovered', sha: CANDIDATE });
      expect(fixture.runningSha).toBe(CANDIDATE);
      expect(fixture.state().health).toMatchObject({
        status: 'ready',
        sha: CANDIDATE,
      });
      expect(fixture.state().recoveryHistory.at(-1)).toMatchObject({
        failedChecks: ['api'],
        outcome: 'recovered',
        sender: 'unknown',
        sha: CANDIDATE,
      });
      expect(
        fixture.calls.filter(
          (call) => call.command === './station' && call.args[0] === 'build',
        ),
      ).toHaveLength(0);
      const lifecycleCalls = fixture.calls.filter(
        (call) => call.command === './station',
      );
      expect(lifecycleCalls).toHaveLength(1);
      expect(lifecycleCalls[0].args).toEqual(
        expect.arrayContaining([
          'start',
          '--force',
          '--stop-intent=recovery',
          '--rotate-log-on-restart',
        ]),
      );
    });

    it('includes the full invocation probe in the exact 60-second recovery budget', () => {
      const fixture = createFixture({ currentUnhealthy: true });
      const times = [
        NOW,
        NOW,
        NOW + 3_000,
        NOW + 3_000,
        NOW + 10_000,
        NOW + 20_000,
        NOW + 30_000,
      ];
      const clock = () => times.shift() ?? NOW + 30_000;

      expect(
        reconcile(fixture.config, { run: fixture.run, now: clock }),
      ).toMatchObject({
        action: 'recovered',
        sha: CANDIDATE,
      });
      expect(fixture.state().recoveryHistory.at(-1)).toMatchObject({
        durationMs: expect.any(Number),
        intervalAllowanceMs: 15_000,
        preDetectionDurationMs: 3_000,
        postDetectionDurationMs: 27_000,
        worstCaseEndToEndMs: 45_000,
        budgetMs: 60_000,
        withinBudget: true,
      });
      expect(fixture.state().recoveryHistory.at(-1).detectedAt).not.toBe(
        fixture.state().recoveryHistory.at(-1).recoveredAt,
      );
    });

    it('keeps an authenticated recovered release ready when the SLA is exceeded', () => {
      const fixture = createFixture({ currentUnhealthy: true });
      const times = [
        NOW,
        NOW,
        NOW + 3_000,
        NOW + 3_000,
        NOW + 10_000,
        NOW + 20_000,
        NOW + 45_001,
        NOW + 45_001,
      ];
      const clock = () => times.shift() ?? NOW + 45_001;

      expect(
        reconcile(fixture.config, { run: fixture.run, now: clock }),
      ).toMatchObject({ action: 'recovered', sha: CANDIDATE });
      expect(fixture.state().health).toMatchObject({
        status: 'ready',
        sha: CANDIDATE,
        source: 'recovery',
      });
      expect(fixture.state().recoveryHistory.at(-1)).toMatchObject({
        outcome: 'recovered',
        withinBudget: false,
        budgetExceededByMs: 1,
        preDetectionDurationMs: 3_000,
        postDetectionDurationMs: 42_001,
        worstCaseEndToEndMs: 60_001,
        budgetMs: 60_000,
        stageDurationsMs: {
          detection: 3_000,
          lifecycleRestart: 7_000,
          localVerification: 10_000,
          tailnetVerification: 25_001,
        },
      });

      const stopCount = fixture.calls.filter(
        (call) => call.command === './station' && call.args[0] === 'stop',
      ).length;
      expect(
        reconcile(fixture.config, {
          run: fixture.run,
          now: () => NOW + 45_001,
        }),
      ).toMatchObject({ action: 'current', sha: CANDIDATE });
      expect(
        fixture.calls.filter(
          (call) => call.command === './station' && call.args[0] === 'stop',
        ),
      ).toHaveLength(stopCount);
    });

    it('correlates an unexpected observed signal before writing the later recovery intent', () => {
      const fixture = createFixture({ currentUnhealthy: true });
      mkdirSync(fixture.config.logDir, { recursive: true, mode: 0o700 });
      chmodSync(fixture.config.logDir, 0o700);
      writeFileSync(
        path.join(fixture.config.logDir, 'station-lifecycle.jsonl'),
        `${JSON.stringify({
          version: 1,
          type: 'shutdown_observed',
          instanceId: 'dogfood',
          sha: CANDIDATE,
          bootId: '11111111-1111-4111-8111-111111111111',
          pid: 1001,
          timestamp: new Date(NOW - 1_000).toISOString(),
          reason: 'SIGTERM',
          sender: 'unknown',
        })}\n`,
        { mode: 0o600 },
      );

      reconcile(fixture.config, { run: fixture.run, now: () => NOW });
      expect(fixture.state().recoveryHistory.at(-1).exit).toMatchObject({
        classification: 'unexpected_signal',
        signal: 'SIGTERM',
        sender: 'unknown',
      });
    });

    it.each(['api', 'terminal', 'voice', 'ui'] as const)(
      'treats a missing %s listener as an unavailable service unit and recovers the exact active SHA',
      (failedListener) => {
        const fixture = createFixture({ current: true, failedListener });

        expect(
          reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
        ).toMatchObject({ action: 'recovered', sha: CANDIDATE });
        expect(fixture.runningSha).toBe(CANDIDATE);
        expect(fixture.state().health).toMatchObject({
          status: 'ready',
          sha: CANDIDATE,
        });
        expect(fixture.state().recoveryHistory.at(-1)).toMatchObject({
          failedChecks: [failedListener],
          outcome: 'recovered',
          sender: 'unknown',
          sha: CANDIDATE,
        });
        expect(
          fixture.calls.filter(
            (call) => call.command === './station' && call.args[0] === 'start',
          ),
        ).toHaveLength(1);
      },
    );

    it('persists a bounded failed recovery receipt without claiming readiness', () => {
      const fixture = createFixture({
        current: true,
        failedListener: 'voice',
        recoveryFailure: true,
        recoveryHistoryLength: 25,
      });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('voice');
      expect(fixture.state().health).toMatchObject({
        status: 'unavailable',
        sha: CANDIDATE,
      });
      expect(fixture.state().recoveryHistory).toHaveLength(20);
      expect(fixture.state().recoveryHistory.at(-1)).toMatchObject({
        failedChecks: ['voice'],
        outcome: 'failed',
        sender: 'unknown',
        sha: CANDIDATE,
      });
    });

    it('fails closed in the single force-start when managed stop proof fails', () => {
      const fixture = createFixture({
        currentUnhealthy: true,
        stopFailure: true,
      });
      mkdirSync(fixture.config.logDir, { recursive: true, mode: 0o700 });
      chmodSync(fixture.config.logDir, 0o700);
      const runtimeLog = path.join(
        fixture.config.logDir,
        'station-runtime.log',
      );
      const evidence = `${'x'.repeat(10 * 1024 * 1024)}\nlive writer evidence\n`;
      writeFileSync(runtimeLog, evidence, { mode: 0o600 });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('managed process still running');
      expect(readFileSync(runtimeLog, 'utf8')).toBe(evidence);
      expect(existsSync(`${runtimeLog}.previous`)).toBe(false);
      expect(
        fixture.calls.filter(
          (call) => call.command === './station' && call.args[0] === 'start',
        ),
      ).toHaveLength(1);
      expect(fixture.state().health.status).toBe('unavailable');
    });

    it('rotates an oversized secured runtime log only while recovering and retains the previous evidence', () => {
      const fixture = createFixture({ currentUnhealthy: true });
      mkdirSync(fixture.config.logDir, { recursive: true, mode: 0o700 });
      chmodSync(fixture.config.logDir, 0o700);
      const runtimeLog = path.join(
        fixture.config.logDir,
        'station-runtime.log',
      );
      writeFileSync(
        runtimeLog,
        `${'x'.repeat(10 * 1024 * 1024)}\nretained SIGTERM evidence\n`,
        { mode: 0o600 },
      );

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'recovered', sha: CANDIDATE });

      const previous = `${runtimeLog}.previous`;
      expect(readFileSync(previous, 'utf8')).toContain(
        'retained SIGTERM evidence',
      );
      expect(statSync(previous).mode & 0o777).toBe(0o600);
      expect(statSync(runtimeLog).mode & 0o777).toBe(0o600);
      expect(statSync(runtimeLog).size).toBe(0);
    });

    it('checks healthy local listeners every tick without polling remote promotion more than every five minutes', () => {
      const fixture = createFixture({ current: true });
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const state = fixture.state();
      state.lastRemoteCheckAt = new Date(NOW - 60_000).toISOString();
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      chmodSync(statePath, 0o600);

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'current', sha: CANDIDATE });
      expect(
        fixture.calls.some(
          (call) => call.command === 'git' && call.args.includes('fetch'),
        ),
      ).toBe(false);
      expect(fixture.calls.some((call) => call.command === 'gh')).toBe(false);
      expect(fixture.statusChecks).toBeGreaterThanOrEqual(3);
      expect(fixture.calls.some((call) => call.command === './station')).toBe(
        false,
      );
    });

    it('does not restart a healthy current release for a tailnet-only outage', () => {
      const fixture = createFixture({ current: true, tailnetFailure: true });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('tailnet unavailable');
      expect(fixture.runningSha).toBe(CANDIDATE);
      expect(fixture.calls.some((call) => call.command === './station')).toBe(
        false,
      );
      expect(fixture.state().health).toMatchObject({
        status: 'unavailable',
        source: 'tailnet-health',
        failedChecks: ['tailnet'],
      });
    });

    it('overwrites locally ready recovery health when tailnet verification fails', () => {
      const fixture = createFixture({
        current: true,
        currentUnhealthy: true,
        tailnetFailure: true,
      });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('tailnet unavailable');
      expect(fixture.state().health).toMatchObject({
        status: 'unavailable',
        source: 'local-health',
        failedChecks: expect.arrayContaining(['tailnet']),
      });
      expect(fixture.state().recoveryHistory.at(-1)).toMatchObject({
        outcome: 'failed',
        failedChecks: expect.arrayContaining(['tailnet']),
      });
    });

    it('recovers the recorded active release before a pending candidate CI check', () => {
      const fixture = createFixture({
        currentUnhealthy: true,
        ci: 'pending',
      });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('not completed/success');
      const startIndex = fixture.calls.findIndex(
        (call) => call.command === './station' && call.args[0] === 'start',
      );
      const ghIndex = fixture.calls.findIndex((call) => call.command === 'gh');
      const fetchIndex = fixture.calls.findIndex(
        (call) => call.command === 'git' && call.args.includes('fetch'),
      );
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(startIndex).toBeLessThan(fetchIndex);
      expect(startIndex).toBeLessThan(ghIndex);
      expect(fixture.runningSha).toBe(CANDIDATE);
      expect(fixture.state().health).toMatchObject({
        status: 'ready',
        sha: CANDIDATE,
      });
      expect(fixture.state().recoveryHistory.at(-1)).toMatchObject({
        outcome: 'recovered',
        sha: CANDIDATE,
      });
    });

    it('rejects STATION_HOME aliases into managed state', () => {
      const root = fixtureRoot();
      const support = path.join(root, 'support');
      const aliasedHome = path.join(root, 'home-alias');
      mkdirSync(path.join(support, 'data'), { recursive: true });
      symlinkSync(path.join(support, 'data'), aliasedHome);

      expect(() =>
        validateConfig({
          repo: path.join(root, 'repo'),
          githubRepo: 'kontourai/station',
          instance: 'dogfood',
          stationHome: aliasedHome,
          supportDir: support,
          logDir: path.join(root, 'logs'),
          serverPort: 3141,
          uiPort: 3000,
          tailnetUrl: 'https://station.example.ts.net',
        }),
      ).toThrow('STATION_HOME must be external');
    });

    it.each([
      [{ serverPort: 65_534 }, 'at most 65532'],
      [{ uiPort: 3142 }, 'must all be distinct'],
      [{ uiPort: 3143 }, 'must all be distinct'],
      [{ instance: 'default' }, 'dedicated non-default name'],
    ])('rejects unsafe four-port reservations', (override, message) => {
      const fixture = createFixture({ active: false });
      expect(() => validateConfig({ ...fixture.config, ...override })).toThrow(
        message,
      );
    });

    it('rejects a recorded release with a mismatched build manifest before fetch', () => {
      const fixture = createFixture();
      const manifest = path.join(
        fixture.config.supportDir,
        'releases',
        PREVIOUS,
        'dist-server-dogfood/station-build.json',
      );
      writeFileSync(
        manifest,
        JSON.stringify({
          sha: CANDIDATE,
          branch: 'main',
          builtAt: '2026-07-10T00:00:00.000Z',
        }),
      );

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('build manifest is missing or does not match');
      expect(
        fixture.calls.some(
          (call) => call.command === 'git' && call.args.includes('fetch'),
        ),
      ).toBe(false);
    });

    it('rejects a symlinked recorded release before starting it', () => {
      const fixture = createFixture();
      const release = path.join(
        fixture.config.supportDir,
        'releases',
        PREVIOUS,
      );
      const outside = path.join(
        path.dirname(fixture.config.supportDir),
        'outside',
      );
      rmSync(release, { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, release);

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('must be a real directory, not a symlink');
    });
  });
}
