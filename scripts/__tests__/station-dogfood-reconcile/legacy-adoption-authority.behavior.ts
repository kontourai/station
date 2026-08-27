import { writeFileSync } from 'node:fs';
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
  NOW,
  PREVIOUS,
} from './fixture.js';

export function registerLegacyAdoptionAuthority() {
  describe('station dogfood reconcile', () => {
    it('threads explicit wildcard authority only through legacy adoption health', () => {
      const fixture = createFixture({
        active: false,
        legacyActive: true,
        legacyHost: '0.0.0.0',
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

      expect(() =>
        adoptLegacyRuntime(
          fixture.config,
          { legacyPath, instanceState, legacyIdentity: LEGACY_IDENTITY },
          { run: fixture.run, now: () => NOW },
        ),
      ).toThrow('local service unit unhealthy: instance-host');
      expect(fixture.state().active).toBeNull();

      expect(
        adoptLegacyRuntime(
          fixture.config,
          {
            legacyPath,
            instanceState,
            legacyIdentity: LEGACY_IDENTITY,
            allowWildcardHost: true,
          },
          { run: fixture.run, now: () => NOW },
        ),
      ).toMatchObject({ action: 'adopted', sha: PREVIOUS });
      const healthCalls = fixture.calls.filter(
        (call) =>
          call.command === process.execPath &&
          String(call.args[0]).endsWith('station-dogfood-health.mjs'),
      );
      expect(healthCalls.at(-1)?.args).toContain('--allow-wildcard-host');
      const reconcileCallStart = fixture.calls.length;
      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({
        action: 'promoted',
        sha: CANDIDATE,
        previousSha: PREVIOUS,
      });
      const reconcileCalls = fixture.calls.slice(reconcileCallStart);
      expect(
        reconcileCalls.some(
          (call) =>
            call.command === './station' &&
            call.args[0] === 'start' &&
            call.args.includes('--force'),
        ),
      ).toBe(false);
      expect(
        reconcileCalls.some(
          (call) =>
            call.command === process.execPath &&
            String(call.args[0]).endsWith('station-dogfood-health.mjs') &&
            call.args.includes('--allow-wildcard-host'),
        ),
      ).toBe(true);
      expect(fixture.state().previous).not.toHaveProperty(
        'adoptedAllowWildcardHost',
      );
    });

    it('rejects wildcard authority outside an exact adopted runtime record', () => {
      const fixture = createFixture();
      const statePath = path.join(fixture.config.supportDir, 'state.json');
      const state = fixture.state();
      state.active.adoptedAllowWildcardHost = true;
      writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

      expect(() =>
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toThrow('active adopted wildcard authority is invalid');
      expect(fixture.runningSha).toBe(PREVIOUS);
    });

    it('strips adopted wildcard authority before immutable recovery starts', () => {
      const fixture = createFixture({
        active: false,
        legacyActive: true,
        legacyHost: '0.0.0.0',
      });
      const legacyPath = path.join(
        fixture.config.supportDir,
        'releases',
        PREVIOUS,
      );
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
          allowWildcardHost: true,
        },
        { run: fixture.run, now: () => NOW },
      );
      fixture.failListener('api');

      expect(
        reconcile(fixture.config, { run: fixture.run, now: () => NOW }),
      ).toMatchObject({ action: 'promoted', sha: CANDIDATE });
      expect(fixture.forceStartStates).toHaveLength(1);
      expect(fixture.forceStartStates[0]).toMatchObject({
        active: { sha: PREVIOUS },
      });
      expect(fixture.forceStartStates[0]).not.toHaveProperty(
        'active.runtimePath',
      );
      expect(fixture.forceStartStates[0]).not.toHaveProperty(
        'active.adoptedAt',
      );
      expect(fixture.forceStartStates[0]).not.toHaveProperty(
        'active.adoptedIdentity',
      );
      expect(fixture.forceStartStates[0]).not.toHaveProperty(
        'active.adoptedAllowWildcardHost',
      );
    });

    it.each([
      'git@github.com:kontourai/station-malware.git',
      'https://github.com/kontourai/station/extra',
      'https://attacker@github.com/kontourai/station.git',
      'ssh://git@github.com/evil/kontourai/station.git',
    ])('rejects legacy runtime lookalike origin %s', (legacyOrigin) => {
      const fixture = createFixture({
        active: false,
        legacyActive: true,
        legacyOrigin,
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
      expect(fixture.runningSha).toBe(PREVIOUS);
      expect(fixture.state().active).toBeNull();
    });
  });
}
