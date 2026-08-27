import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { adoptLegacyRuntime, main } from '../../station-dogfood-reconcile.mjs';
import {
  CANDIDATE,
  createFixture,
  LEGACY_IDENTITY,
  NOW,
  OLDER,
  PREVIOUS,
} from './fixture.js';

export function registerLegacyAdoptionBoundary() {
  describe('station dogfood reconcile', () => {
    it('executes the real adopt CLI boundary and rejects a loaded canonical supervisor', async () => {
      const fixture = createFixture({ active: false, legacyActive: true });
      const legacyPath = path.join(
        fixture.config.supportDir,
        'releases',
        PREVIOUS,
      );
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const staleState = fixture.state();
      staleState.active = {
        sha: OLDER,
        path: path.join(fixture.config.supportDir, 'releases', OLDER),
      };
      writeFileSync(statePath, `${JSON.stringify(staleState)}\n`, {
        mode: 0o600,
      });
      const stateSnapshot = path.join(
        fixture.config.supportDir,
        'state.snapshot',
      );
      copyFileSync(statePath, stateSnapshot);
      chmodSync(stateSnapshot, 0o600);
      const configPath = path.join(fixture.config.supportDir, 'config.json');
      writeFileSync(configPath, `${JSON.stringify(fixture.config)}\n`, {
        mode: 0o600,
      });
      const legacyPlist = path.join(fixture.config.supportDir, 'legacy.plist');
      const legacyPlistSnapshot = path.join(
        fixture.config.supportDir,
        'legacy.plist.snapshot',
      );
      const legacyRunner = path.join(
        fixture.config.supportDir,
        'legacy-runner',
      );
      const legacyRunnerSnapshot = path.join(
        fixture.config.supportDir,
        'legacy-runner.snapshot',
      );
      writeFileSync(legacyPlist, 'legacy plist', { mode: 0o600 });
      copyFileSync(legacyPlist, legacyPlistSnapshot);
      writeFileSync(legacyRunner, '#!/bin/zsh\n', { mode: 0o700 });
      copyFileSync(legacyRunner, legacyRunnerSnapshot);
      let canonicalLoaded = true;
      const run = (command: string, args: string[], options?: unknown) => {
        if (command === 'plutil') {
          return {
            status: 0,
            stdout: JSON.stringify({
              Label: 'legacy.station-updater',
              ProgramArguments: [legacyRunner],
            }),
            stderr: '',
          };
        }
        if (command === 'launchctl') {
          if (args[1].endsWith('/legacy.station-updater')) {
            return {
              status: 0,
              stdout: `\n\tpath = ${legacyPlist}\n\n\tprogram = ${legacyRunner}\n`,
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
        }
        return fixture.run(command, args, options);
      };
      const args = [
        'adopt-legacy',
        `--config=${configPath}`,
        `--legacy-path=${legacyPath}`,
        `--instance-state=${path.join(legacyPath, '.station', 'instances', 'dogfood.json')}`,
        `--legacy-sha=${LEGACY_IDENTITY.sha}`,
        `--legacy-boot-id=${LEGACY_IDENTITY.bootId}`,
        `--legacy-instance-id=${LEGACY_IDENTITY.instanceId}`,
        `--inactive-canonical-state=${stateSnapshot}`,
        '--legacy-label=legacy.station-updater',
        `--legacy-plist=${legacyPlist}`,
        `--legacy-plist-snapshot=${legacyPlistSnapshot}`,
        `--legacy-runner=${legacyRunner}`,
        `--legacy-runner-snapshot=${legacyRunnerSnapshot}`,
      ];
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await expect(main(args, { run })).rejects.toThrow(
          'requires a loaded legacy updater and an unloaded canonical supervisor',
        );
        canonicalLoaded = false;
        await expect(main(args, { run })).resolves.toBeUndefined();
      } finally {
        log.mockRestore();
      }
      expect(fixture.state().active).toMatchObject({
        sha: PREVIOUS,
        runtimePath: realpathSync(legacyPath),
      });
    });

    it('replaces only byte-matched inactive canonical state before adopting legacy A', () => {
      const fixture = createFixture({ active: false, legacyActive: true });
      const legacyPath = path.join(
        fixture.config.supportDir,
        'releases',
        PREVIOUS,
      );
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const staleState = fixture.state();
      staleState.active = {
        sha: OLDER,
        path: path.join(fixture.config.supportDir, 'releases', OLDER),
      };
      staleState.failedCandidates = [{ sha: OLDER, reason: 'stale fixture' }];
      writeFileSync(statePath, `${JSON.stringify(staleState)}\n`, {
        mode: 0o600,
      });

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
          {
            run: fixture.run,
            now: () => NOW,
            proveMigrationAuthority: () => true,
          },
        ),
      ).toThrow('requires an exact pre-install snapshot');
      expect(fixture.state()).toEqual(staleState);

      const mismatchedSnapshot = structuredClone(staleState);
      mismatchedSnapshot.failedCandidates = [];
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
            inactiveCanonicalState: mismatchedSnapshot,
          },
          {
            run: fixture.run,
            now: () => NOW,
            proveMigrationAuthority: () => true,
          },
        ),
      ).toThrow('requires an exact pre-install snapshot');

      let authorityChecks = 0;
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
            inactiveCanonicalState: staleState,
          },
          {
            run: fixture.run,
            now: () => NOW,
            proveMigrationAuthority: () => ++authorityChecks === 1,
          },
        ),
      ).toThrow('migration authority changed before adoption commit');
      expect(fixture.state()).toEqual(staleState);

      expect(
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
            inactiveCanonicalState: staleState,
          },
          {
            run: fixture.run,
            now: () => NOW,
            proveMigrationAuthority: () => true,
          },
        ),
      ).toMatchObject({ action: 'adopted', sha: PREVIOUS });
      expect(fixture.runningSha).toBe(PREVIOUS);
      expect(fixture.state()).toMatchObject({
        active: { sha: PREVIOUS, runtimePath: realpathSync(legacyPath) },
        failedCandidates: staleState.failedCandidates,
      });
    });

    it('adopts a healthy inactive canonical record only when it aliases the exact legacy runtime', () => {
      const fixture = createFixture();
      const active = fixture.state().active;
      const adopt = (proveMigrationAuthority?: () => boolean) =>
        adoptLegacyRuntime(
          fixture.config,
          {
            legacyPath: active.path,
            legacyIdentity: LEGACY_IDENTITY,
            instanceState: path.join(
              active.path,
              '.station',
              'instances',
              'dogfood.json',
            ),
            inactiveCanonicalState: fixture.state(),
          },
          {
            run: fixture.run,
            now: () => NOW,
            proveMigrationAuthority,
          },
        );

      expect(() => adopt()).toThrow(
        'requires a loaded legacy updater and an unloaded canonical supervisor',
      );
      expect(adopt(() => true)).toMatchObject({
        action: 'adopted',
        sha: PREVIOUS,
        identity: LEGACY_IDENTITY,
      });
      expect(fixture.runningSha).toBe(PREVIOUS);
      expect(fixture.state().active).toMatchObject({
        sha: PREVIOUS,
        runtimePath: realpathSync(active.path),
        adoptedIdentity: LEGACY_IDENTITY,
      });
    });

    it.each(['path', 'sha', 'boot'] as const)(
      'rejects a healthy inactive canonical record when the legacy %s differs',
      (difference) => {
        const fixture = createFixture();
        const active = fixture.state().active;
        const legacyPath =
          difference === 'path'
            ? `${active.path}--release-11111111-1111-4111-8111-111111111111`
            : active.path;
        if (difference === 'path') {
          mkdirSync(path.join(legacyPath, '.station', 'instances'), {
            recursive: true,
          });
        }
        const legacyIdentity = {
          ...LEGACY_IDENTITY,
          ...(difference === 'sha' ? { sha: CANDIDATE } : {}),
          ...(difference === 'boot'
            ? { bootId: '99999999-1111-4111-8111-111111111111' }
            : {}),
        };

        expect(() =>
          adoptLegacyRuntime(
            fixture.config,
            {
              legacyPath,
              legacyIdentity,
              instanceState: path.join(
                legacyPath,
                '.station',
                'instances',
                'dogfood.json',
              ),
              inactiveCanonicalState: fixture.state(),
            },
            {
              run: fixture.run,
              now: () => NOW,
              proveMigrationAuthority: () => true,
            },
          ),
        ).toThrow('refuses to replace a healthy canonical release');
        expect(fixture.state().active).toEqual(active);
      },
    );
  });
}
