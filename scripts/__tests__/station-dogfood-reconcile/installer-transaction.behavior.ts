import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  reconcile,
  rollbackInstall,
} from '../../station-dogfood-reconcile.mjs';
import { CANDIDATE, createFixture, NOW, OLDER, PREVIOUS } from './fixture.js';

export function registerInstallerTransactions() {
  describe('station dogfood reconcile', () => {
    it('rolls an installer transaction back to byte-identical prior state and process', () => {
      const fixture = createFixture();
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const snapshot = path.join(
        path.dirname(fixture.config.supportDir),
        'state.snapshot',
      );
      copyFileSync(statePath, snapshot);
      const before = readFileSync(snapshot);
      reconcile(fixture.config, { run: fixture.run, now: () => NOW });

      expect(
        rollbackInstall(
          fixture.config,
          { stateSnapshot: snapshot, stateExisted: true },
          { run: fixture.run, now: () => NOW + 1_000 },
        ),
      ).toMatchObject({ restored: true, activeSha: PREVIOUS });
      expect(readFileSync(statePath).equals(before)).toBe(true);
      expect(fixture.runningSha).toBe(PREVIOUS);
    });

    it('preserves the complete A/B rollback set while staging C until installer commit', () => {
      const fixture = createFixture();
      const releases = path.join(fixture.config.supportDir, 'releases');
      const olderPath = path.join(releases, OLDER);
      mkdirSync(path.join(olderPath, 'dist-server-dogfood'), {
        recursive: true,
      });
      writeFileSync(
        path.join(olderPath, 'dist-server-dogfood/station-build.json'),
        JSON.stringify({
          sha: OLDER,
          branch: 'main',
          builtAt: '2026-07-09T00:00:00.000Z',
        }),
      );
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const state = fixture.state();
      state.previous = { sha: OLDER, path: olderPath };
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      chmodSync(statePath, 0o600);
      const snapshot = path.join(
        path.dirname(fixture.config.supportDir),
        'ab.snapshot',
      );
      copyFileSync(statePath, snapshot);
      chmodSync(snapshot, 0o600);
      const before = readFileSync(snapshot);
      const beforeMode = statSync(snapshot).mode & 0o777;

      reconcile(fixture.config, {
        run: fixture.run,
        now: () => NOW,
        deferPrune: true,
      });
      expect(fixture.runningSha).toBe(CANDIDATE);
      expect(existsSync(path.join(releases, PREVIOUS))).toBe(true);
      expect(existsSync(olderPath)).toBe(true);

      rollbackInstall(
        fixture.config,
        { stateSnapshot: snapshot, stateExisted: true },
        { run: fixture.run, now: () => NOW + 1_000 },
      );

      expect(fixture.runningSha).toBe(PREVIOUS);
      expect(readFileSync(statePath).equals(before)).toBe(true);
      expect(statSync(statePath).mode & 0o777).toBe(beforeMode);
      expect(existsSync(path.join(releases, PREVIOUS))).toBe(true);
      expect(existsSync(olderPath)).toBe(true);
      expect(
        fixture.calls.filter(
          (call) =>
            call.command === './station' &&
            call.args[0] === 'start' &&
            path.basename(call.cwd as string) === PREVIOUS,
        ),
      ).toHaveLength(1);
    });

    it('never reuses snapshot B destructively when candidate B staging fails', () => {
      const fixture = createFixture({ installFailure: true });
      const releases = path.join(fixture.config.supportDir, 'releases');
      const snapshotB = path.join(releases, CANDIDATE);
      mkdirSync(path.join(snapshotB, 'dist-server-dogfood'), {
        recursive: true,
      });
      const manifest = path.join(
        snapshotB,
        'dist-server-dogfood/station-build.json',
      );
      const manifestBytes = Buffer.from(
        JSON.stringify({
          sha: CANDIDATE,
          branch: 'main',
          builtAt: '2026-07-09T00:00:00.000Z',
        }),
      );
      writeFileSync(manifest, manifestBytes);
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const state = fixture.state();
      state.previous = { sha: CANDIDATE, path: snapshotB };
      writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
      chmodSync(statePath, 0o600);
      const stateSnapshot = path.join(
        path.dirname(fixture.config.supportDir),
        'ab-build-failure.snapshot',
      );
      copyFileSync(statePath, stateSnapshot);
      chmodSync(stateSnapshot, 0o600);

      expect(() =>
        reconcile(fixture.config, {
          run: fixture.run,
          now: () => NOW,
          deferPrune: true,
        }),
      ).toThrow('dependency install failed');

      expect(fixture.runningSha).toBe(PREVIOUS);
      expect(existsSync(snapshotB)).toBe(true);
      expect(readFileSync(manifest).equals(manifestBytes)).toBe(true);
      expect(
        fixture.calls.some(
          (call) =>
            call.command === 'git' &&
            call.args.includes('remove') &&
            call.args.at(-1) === snapshotB,
        ),
      ).toBe(false);
      expect(
        readdirSync(releases).some((name) =>
          name.startsWith(`${CANDIDATE}--release-`),
        ),
      ).toBe(false);

      rollbackInstall(
        fixture.config,
        { stateSnapshot, stateExisted: true },
        { run: fixture.run, now: () => NOW + 1_000 },
      );
      expect(fixture.runningSha).toBe(PREVIOUS);
      expect(existsSync(snapshotB)).toBe(true);
      expect(readFileSync(manifest).equals(manifestBytes)).toBe(true);
    });

    it('unwinds a fresh installer transaction to no process and no state', () => {
      const fixture = createFixture({ active: false });
      reconcile(fixture.config, { run: fixture.run, now: () => NOW });
      expect(fixture.runningSha).toBe(CANDIDATE);

      expect(
        rollbackInstall(
          fixture.config,
          {
            stateSnapshot: path.join(
              path.dirname(fixture.config.supportDir),
              'unused.snapshot',
            ),
            stateExisted: false,
          },
          { run: fixture.run, now: () => NOW + 1_000 },
        ),
      ).toMatchObject({ restored: false, activeSha: null });
      expect(fixture.runningSha).toBeNull();
      expect(
        existsSync(path.join(fixture.config.supportDir, 'state.json')),
      ).toBe(false);
    });
  });
}
