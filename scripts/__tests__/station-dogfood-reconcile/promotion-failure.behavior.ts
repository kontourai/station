import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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
  PREVIOUS,
} from './fixture.js';

export function registerPromotionFailures() {
  describe('station dogfood reconcile', () => {
    it('rejects a lookalike configured source origin before fetching it', () => {
      const fixture = createFixture({
        active: false,
        legacyActive: true,
        configOrigin: 'git@github.com:kontourai/station-malware.git',
      });
      const legacyPath = path.join(
        fixture.config.supportDir,
        'releases',
        PREVIOUS,
      );

      expect(() =>
        adoptLegacyRuntime(
          fixture.config,
          {
            legacyPath,
            legacyIdentity: LEGACY_IDENTITY,
            instanceState: path.join(
              legacyPath,
              '.station',
              'instances',
              'dogfood.json',
            ),
          },
          { run: fixture.run, now: () => NOW },
        ),
      ).toThrow('does not match configured GitHub repo kontourai/station');
      expect(
        fixture.calls.some(
          (call) => call.command === 'git' && call.args.includes('fetch'),
        ),
      ).toBe(false);
      expect(fixture.state().active).toBeNull();
    });

    it.each([
      ['pending', 'not completed/success'],
      ['absent', 'no CI push run exists'],
      ['wrong-sha', 'no CI push run exists'],
      ['pr-only', 'no CI push run exists'],
      ['wrong-workflow', 'no CI push run exists'],
    ] as const)(
      'fails closed for %s CI without touching the active release',
      (ci, message) => {
        const fixture = createFixture({ ci });

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
        expect(fixture.calls.some((call) => call.command === './station')).toBe(
          false,
        );
      },
    );

    it.each(['before', 'after'] as const)(
      'rejects a candidate dirty %s build',
      (dirty) => {
        const fixture = createFixture({ dirty });

        expect(() =>
          reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
        ).toThrow(
          dirty === 'before' ? 'dirty before build' : 'dirty after build',
        );

        expect(fixture.runningSha).toBe(PREVIOUS);
        expect(
          fixture.calls.some(
            (call) => call.command === './station' && call.args[0] === 'stop',
          ),
        ).toBe(false);
        expect(fixture.state().failedCandidates.at(-1)).toMatchObject({
          sha: CANDIDATE,
          phase: 'build',
        });
      },
    );

    it.each([
      [
        'dependency install',
        { installFailure: true },
        'dependency install failed',
      ],
      ['application build', { buildFailure: true }, 'build failed'],
    ] as const)(
      'never stops the active release when %s staging fails',
      (_label, failure, message) => {
        const fixture = createFixture(failure);

        expect(() =>
          reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
        ).toThrow(message);

        expect(fixture.runningSha).toBe(PREVIOUS);
        expect(
          fixture.calls.some(
            (call) => call.command === './station' && call.args[0] === 'stop',
          ),
        ).toBe(false);
        expect(fixture.state().reconciliation.failure).toMatchObject({
          phase: _label === 'dependency install' ? 'install' : 'build',
        });
      },
    );

    it.each([
      ['local health', { localFailure: true }],
      ['local provenance', { provenanceMismatch: true }],
      ['tailnet health', { tailnetFailure: true }],
    ] as const)(
      'rolls back the prior built release after %s failure',
      (_label, failure) => {
        const fixture = createFixture(failure);

        expect(() =>
          reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
        ).toThrow();

        expect(fixture.runningSha).toBe(PREVIOUS);
        expect(fixture.state().active).toMatchObject({ sha: PREVIOUS });
        expect(fixture.state().failedCandidates.at(-1)).toMatchObject({
          sha: CANDIDATE,
          phase: 'promotion',
        });
        const starts = fixture.calls.filter(
          (call) => call.command === './station' && call.args[0] === 'start',
        );
        expect(starts.map((call) => path.basename(call.cwd as string))).toEqual(
          [CANDIDATE, PREVIOUS],
        );
      },
    );

    it('records the immutable rollback runtime after an adopted candidate promotion fails', () => {
      const fixture = createFixture({
        tailnetFailure: true,
        tailnetRollbackFailure: true,
      });
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const state = fixture.state();
      const immutablePath = realpathSync(state.active.path);
      const runtimePath = path.join(fixture.config.repo, 'adopted-runtime');
      mkdirSync(path.join(runtimePath, '.station', 'instances'), {
        recursive: true,
      });
      copyFileSync(
        path.join(immutablePath, '.station', 'instances', 'dogfood.json'),
        path.join(runtimePath, '.station', 'instances', 'dogfood.json'),
      );
      state.active = {
        ...state.active,
        runtimePath,
        adoptedAt: new Date(NOW - 1_000).toISOString(),
        adoptedIdentity: LEGACY_IDENTITY,
      };
      writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow(/rollback .* also failed .*tailnet unavailable/);

      expect(fixture.runningSha).toBe(PREVIOUS);
      expect(fixture.state().active).toMatchObject({
        sha: PREVIOUS,
        path: immutablePath,
      });
      expect(fixture.state().active).not.toHaveProperty('runtimePath');
      expect(fixture.state().active).not.toHaveProperty('adoptedIdentity');
    });

    it('reports both the promotion and rollback failure without claiming a state swap', () => {
      const fixture = createFixture({
        localFailure: true,
        rollbackFailure: true,
      });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow(/promotion .* failed .* rollback .* also failed/);

      expect(fixture.state().active).toMatchObject({ sha: PREVIOUS });
    });

    it('starts an initial candidate without attempting to stop a missing active release', () => {
      const fixture = createFixture({ active: false });

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({
        action: 'promoted',
        previousSha: null,
      });
      expect(
        fixture.calls.some(
          (call) => call.command === './station' && call.args[0] === 'stop',
        ),
      ).toBe(false);
    });

    it('stops and records a failed first-install candidate without inventing an active release', () => {
      const fixture = createFixture({ active: false, tailnetFailure: true });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('tailnet unavailable');
      expect(fixture.runningSha).toBeNull();
      expect(fixture.state()).toMatchObject({
        active: null,
        previous: null,
        failedCandidates: [expect.objectContaining({ phase: 'promotion' })],
      });
    });

    it('prunes release worktrees older than the healthy active/previous pair', () => {
      const fixture = createFixture();
      const orphan = 'c'.repeat(40);
      mkdirSync(path.join(fixture.config.supportDir, 'releases', orphan), {
        recursive: true,
      });

      reconcile(fixture.config, { run: fixture.run, now: () => NOW });

      expect(
        fixture.calls.some(
          (call) =>
            call.command === 'git' &&
            call.args.includes('remove') &&
            call.args.at(-1)?.endsWith(orphan),
        ),
      ).toBe(true);
    });
  });
}
