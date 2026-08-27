import { copyFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  adoptLegacyRuntime,
  createLegacyMigrationProof,
  reconcile,
} from '../../station-dogfood-reconcile.mjs';
import {
  CANDIDATE,
  createFixture,
  fixtureRoot,
  LEGACY_IDENTITY,
  NOW,
  PREVIOUS,
} from './fixture.js';

export function registerLegacyAdoption() {
  describe('station dogfood reconcile', () => {
    it('adopts an exact legacy child with an immutable rollback A before promoting B', () => {
      const fixture = createFixture({ active: false, legacyActive: true });
      const legacyPath = path.join(
        fixture.config.supportDir,
        'releases',
        PREVIOUS,
      );
      const instanceState = path.join(
        legacyPath,
        '.station',
        'instances',
        'dogfood.json',
      );

      const adopted = adoptLegacyRuntime(
        fixture.config,
        { legacyPath, instanceState, legacyIdentity: LEGACY_IDENTITY },
        { run: fixture.run, now: () => NOW },
      );
      expect(adopted).toMatchObject({ action: 'adopted', sha: PREVIOUS });
      expect(adopted.rollbackPath).not.toBe(legacyPath);
      expect(fixture.runningSha).toBe(PREVIOUS);
      const adoptedState = fixture.state().active;
      expect(fixture.state().active).toMatchObject({
        sha: PREVIOUS,
        runtimePath: realpathSync(legacyPath),
      });
      expect(fixture.state().health).toMatchObject({
        status: 'ready',
        sha: PREVIOUS,
      });

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({
        action: 'promoted',
        sha: CANDIDATE,
        previousSha: PREVIOUS,
      });
      const promotionStop = fixture.calls.find(
        (call) =>
          call.command === './station' &&
          call.args[0] === 'stop' &&
          call.args.includes('--stop-intent=promotion'),
      );
      expect(promotionStop?.cwd).toBe(adoptedState.runtimePath);
      expect(fixture.state().previous).toMatchObject({
        sha: PREVIOUS,
        path: adoptedState.path,
      });
      expect(fixture.state().previous.runtimePath).toBeUndefined();
    });

    it('adopts the proven running build when the legacy worktree HEAD has advanced', () => {
      const fixture = createFixture({
        active: false,
        legacyActive: true,
        legacyHeadSha: CANDIDATE,
      });
      const legacyPath = path.join(
        fixture.config.supportDir,
        'releases',
        PREVIOUS,
      );
      const instanceState = path.join(
        legacyPath,
        '.station',
        'instances',
        'dogfood.json',
      );

      expect(
        adoptLegacyRuntime(
          fixture.config,
          { legacyPath, instanceState, legacyIdentity: LEGACY_IDENTITY },
          { run: fixture.run, now: () => NOW },
        ),
      ).toMatchObject({ action: 'adopted', sha: PREVIOUS });
      expect(
        fixture.calls.some(
          (call) =>
            call.command === 'git' &&
            call.args.join(' ') ===
              `-C ${fixture.config.repo} fetch --prune origin +refs/heads/main:refs/remotes/origin/main`,
        ),
      ).toBe(true);
      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({
        action: 'promoted',
        sha: CANDIDATE,
        previousSha: PREVIOUS,
      });
    });

    it('refuses adoption when legacy boot identity changes during rollback preparation', () => {
      const fixture = createFixture({
        active: false,
        legacyActive: true,
        legacyIdentityChangesDuringBuild: true,
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
            instanceState: path.join(
              legacyPath,
              '.station',
              'instances',
              'dogfood.json',
            ),
            legacyIdentity: LEGACY_IDENTITY,
          },
          { run: fixture.run, now: () => NOW },
        ),
      ).toThrow('legacy runtime identity changed before adoption commit');
      expect(fixture.state().active).toBeNull();
      expect(fixture.state().health).toBeUndefined();
    });

    it.each([
      [undefined, 'requires an exact preflight runtime identity'],
      [
        {
          ...LEGACY_IDENTITY,
          bootId: '22222222-2222-4222-8222-222222222222',
        },
        'legacy runtime identity changed after preflight',
      ],
      [{ ...LEGACY_IDENTITY, sha: CANDIDATE }, 'local service unit unhealthy'],
    ])(
      'rejects missing or changed preflight identity %#',
      (legacyIdentity, message) => {
        const fixture = createFixture({ active: false, legacyActive: true });
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
              instanceState: path.join(
                legacyPath,
                '.station',
                'instances',
                'dogfood.json',
              ),
              legacyIdentity,
            },
            { run: fixture.run, now: () => NOW },
          ),
        ).toThrow(message);
        expect(fixture.state().active).toBeNull();
      },
    );

    it.each([
      ['fetch', 'fetch'],
      ['missing', 'cat-file'],
      ['unreachable', 'merge-base'],
    ] as const)(
      'rejects a %s proven commit before adopting it',
      (legacyCommit, command) => {
        const fixture = createFixture({
          active: false,
          legacyActive: true,
          legacyCommit,
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
              instanceState: path.join(
                legacyPath,
                '.station',
                'instances',
                'dogfood.json',
              ),
              legacyIdentity: LEGACY_IDENTITY,
            },
            { run: fixture.run, now: () => NOW },
          ),
        ).toThrow(command);
        expect(fixture.state().active).toBeNull();
      },
    );

    it('binds stale replacement authority to the captured loaded legacy contract', () => {
      const root = fixtureRoot();
      const plist = path.join(root, 'legacy.plist');
      const runner = path.join(root, 'legacy-runner.zsh');
      const runnerSnapshot = path.join(root, 'legacy-runner.snapshot');
      writeFileSync(plist, 'captured plist', { mode: 0o600 });
      writeFileSync(runner, '#!/bin/zsh\n', { mode: 0o700 });
      copyFileSync(runner, runnerSnapshot);
      let legacyLoaded = true;
      let canonicalLoaded = false;
      const run = (command: string, args: string[]) => {
        if (command === 'plutil') {
          return {
            status: 0,
            stdout: JSON.stringify({
              Label: 'legacy.station-updater',
              ProgramArguments: [runner],
            }),
            stderr: '',
          };
        }
        const label = args[1];
        if (label.endsWith('/legacy.station-updater')) {
          return {
            status: legacyLoaded ? 0 : 113,
            stdout: legacyLoaded
              ? `\n\tpath = ${plist}\n\n\tprogram = ${runner}\n`
              : '',
            stderr: '',
          };
        }
        return canonicalLoaded
          ? { status: 0, stdout: '', stderr: '' }
          : {
              status: 113,
              stdout: '',
              stderr: 'Could not find service',
            };
      };
      const prove = createLegacyMigrationProof(
        {
          legacyLabel: 'legacy.station-updater',
          legacyPlist: plist,
          legacyPlistSnapshot: plist,
          legacyRunner: runner,
          legacyRunnerSnapshot: runnerSnapshot,
        },
        run,
      );

      expect(prove()).toBe(true);
      canonicalLoaded = true;
      expect(prove()).toBe(false);
      canonicalLoaded = false;
      legacyLoaded = false;
      expect(prove()).toBe(false);
      legacyLoaded = true;
      writeFileSync(runner, '#!/bin/zsh\necho changed\n', { mode: 0o700 });
      expect(prove()).toBe(false);
    });
  });
}
