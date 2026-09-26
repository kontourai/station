import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { CHANNEL_PORTS, RELEASE_RINGS } from '../channel-ports.mjs';
import {
  checkInstallScript,
  INSTALL_SCRIPT_PATH,
  renderInstallScript,
  syncInstallScript,
} from '../install-script-generated.mjs';

const root = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
type Ports = { serverPort: number; uiPort: number };
type Ring = { runtimeChannel: string; prerelease: boolean; launcher: string };
const ports = CHANNEL_PORTS as Record<string, Ports>;
const rings = RELEASE_RINGS as Record<string, Ring>;

function scratchCopy(): string {
  const path = join(makeTempDir('station-install-generated-'), 'install.sh');
  copyFileSync(INSTALL_SCRIPT_PATH, path);
  return path;
}

describe('install.sh generated blocks', () => {
  it('matches what the generator renders from its config sources', () => {
    expect(() => checkInstallScript()).not.toThrow();
  });

  it('embeds the checked-in signing-key table, assigned exactly once', () => {
    const config = JSON.parse(
      readFileSync(join(root, 'config/release-manifest-keys.json'), 'utf8'),
    );
    const script = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    const expectedLine = `PINNED_MANIFEST_SIGNING_KEYS='${JSON.stringify(config)}'`;
    // Exactly one assignment, and the verifier is its only reader: a second
    // assignment (or an env/default expansion) could silently replace it.
    const uses = script
      .split('\n')
      .filter((line) => line.includes('PINNED_MANIFEST_SIGNING_KEYS'))
      .filter((line) => !line.startsWith('# '));
    expect(uses).toHaveLength(2);
    expect(uses[0]).toBe(expectedLine);
    expect(uses[1]).toContain(' "$PINNED_MANIFEST_SIGNING_KEYS" ');
    expect(uses[1]).not.toMatch(/PINNED_MANIFEST_SIGNING_KEYS[:=-]/);
  });

  it('projects every installable ring and its channel ports into install.sh', () => {
    const script = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    expect(Object.keys(rings)).toEqual(['stable', 'preview', 'nightly']);
    for (const [ring, entry] of Object.entries(rings)) {
      const { serverPort, uiPort } = ports[entry.runtimeChannel];
      expect(script).toContain(
        [
          `    ${entry.runtimeChannel})`,
          `      runtime_release_channel=${ring}`,
          `      runtime_server_port=${serverPort}`,
          `      runtime_ui_port=${uiPort}`,
          `      runtime_launcher_name=${entry.launcher}`,
          '      ;;',
        ].join('\n'),
      );
    }
    expect(script).toContain(
      `RELEASE_RINGS_JSON='${JSON.stringify({
        stable: { runtimeChannel: 'stable', prerelease: false },
        preview: { runtimeChannel: 'beta', prerelease: true },
        nightly: { runtimeChannel: 'nightly', prerelease: true },
      })}'`,
    );
  });

  it.each([
    [
      'a hand-edited channel port',
      'runtime_server_port=38141',
      'runtime_server_port=38142',
    ],
    [
      'a hand-edited ring table',
      '"nightly":{"runtimeChannel":"nightly","prerelease":true}',
      '"nightly":{"runtimeChannel":"beta","prerelease":true}',
    ],
    [
      'a hand-edited signing key',
      'MCowBQYDK2VwAyEAH74uCwGmcJFftH+reVCJjJysQRRON2k0mTUoDBf14OM=',
      'MCowBQYDK2VwAyEAH74uCwGmcJFftH+reVCJjJysQRRON2k0mTUoDBf14OO=',
    ],
  ])('fails the check for %s, and --sync restores it', (_name, from, to) => {
    const path = scratchCopy();
    const pristine = readFileSync(path, 'utf8');
    expect(pristine.split(from)).toHaveLength(2);
    writeFileSync(path, pristine.replace(from, to));
    expect(() => checkInstallScript(path)).toThrow(
      /Generated install\.sh blocks are stale/,
    );
    syncInstallScript(path);
    expect(readFileSync(path, 'utf8')).toBe(pristine);
    expect(() => checkInstallScript(path)).not.toThrow();
  });

  it('refuses a script whose generated markers are missing or duplicated', () => {
    const pristine = readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
    expect(() =>
      renderInstallScript(
        pristine.replace('# END GENERATED CHANNEL CONSTANTS\n', ''),
      ),
    ).toThrow(/exactly one CHANNEL CONSTANTS block/);
    expect(() =>
      renderInstallScript(
        `${pristine}# BEGIN GENERATED PINNED MANIFEST SIGNING KEYS\n# END GENERATED PINNED MANIFEST SIGNING KEYS\n`,
      ),
    ).toThrow(/exactly one PINNED MANIFEST SIGNING KEYS block/);
  });
});
