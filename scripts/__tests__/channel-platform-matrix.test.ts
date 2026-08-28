import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ANDROID_CHANNEL_IDENTITY,
  applyAndroidChannelIcons,
} from '../apply-android-channel-icons.mjs';
import {
  devPairingDeepLinkScheme,
  pairingSchemeForChannel,
  readChannelPlatformMatrix,
} from '../channel-platform-matrix.mjs';

const root = resolve(import.meta.dirname, '../..');
const matrix = JSON.parse(
  readFileSync(resolve(root, 'config/channel-platform-matrix.json'), 'utf8'),
).channels;
const ports = JSON.parse(
  readFileSync(resolve(root, 'config/channel-ports.json'), 'utf8'),
).channels;

const digest = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

describe('cross-platform release channel matrix', () => {
  test('aligns desktop and Android names, identifiers, homes, ports, and icon sources', () => {
    for (const channel of ['stable', 'beta', 'nightly']) {
      const entry = matrix[channel];
      expect(entry.desktopIdentifier).toBe(entry.androidIdentifier);
      expect(entry.runtimeDirectory).toBe(
        `instances/${ports[channel].instanceDirectory}`,
      );
      expect(entry.serverPort).toBe(ports[channel].serverPort);
      expect(entry.uiPort).toBe(ports[channel].uiPort);
      expect(entry.pairingDeepLinkScheme).toBe(`station-${channel}`);
      expect(entry.desktopIconSource).toMatch(
        `src-desktop/icons${channel === 'stable' ? '' : `/${channel}`}`,
      );
      expect(entry.androidIconSource).toBe(
        `src-desktop/icons/${channel}/android`,
      );
    }
  });

  test('wires the Beta and Nightly desktop overlays to the matrix on every desktop OS', () => {
    for (const channel of ['beta', 'nightly']) {
      const config = JSON.parse(
        readFileSync(
          resolve(root, 'src-desktop', `tauri.${channel}.conf.json`),
          'utf8',
        ),
      );
      expect(config.productName).toBe(matrix[channel].appName);
      expect(config.identifier).toBe(matrix[channel].desktopIdentifier);
      expect(config.bundle.icon).toEqual(
        expect.arrayContaining([
          `icons/${channel}/icon.icns`,
          `icons/${channel}/icon.ico`,
        ]),
      );
      expect(config.plugins['deep-link'].desktop.schemes).toEqual([
        matrix[channel].pairingDeepLinkScheme,
      ]);
    }
  });

  test('binds every release Tauri registration and generated native consumer to the matrix', () => {
    const authority = readChannelPlatformMatrix();
    for (const channel of ['stable', 'beta', 'nightly']) {
      const file =
        channel === 'stable' ? 'tauri.conf.json' : `tauri.${channel}.conf.json`;
      const config = JSON.parse(
        readFileSync(resolve(root, 'src-desktop', file), 'utf8'),
      );
      const scheme = pairingSchemeForChannel(authority, channel);
      expect(config.plugins['deep-link'].desktop.schemes).toEqual([scheme]);
      expect(config.plugins['deep-link'].mobile[0].scheme).toEqual([scheme]);
    }
    const generatedTs = readFileSync(
      resolve(
        root,
        'packages/connect/src/core/pairingDeepLinkChannels.generated.ts',
      ),
      'utf8',
    );
    const generatedRust = readFileSync(
      resolve(root, 'src-desktop/src/pairing_deep_link_channels_generated.rs'),
      'utf8',
    );
    for (const channel of ['stable', 'beta', 'nightly']) {
      expect(generatedTs).toContain(
        pairingSchemeForChannel(authority, channel),
      );
      expect(generatedRust).toContain(
        pairingSchemeForChannel(authority, channel),
      );
    }
    expect(devPairingDeepLinkScheme('Dev.Release.7')).toBe(
      'station-dev-dev-release-7',
    );
  });

  test('keeps every shipped channel icon visually distinct', () => {
    const icon = (channel: string) =>
      resolve(
        root,
        matrix[channel].androidIconSource,
        'mipmap-xxxhdpi/ic_launcher.png',
      );
    expect(
      new Set(
        ['stable', 'beta', 'nightly'].map((channel) => digest(icon(channel))),
      ).size,
    ).toBe(3);
    expect(digest(icon('development'))).not.toBe(digest(icon('stable')));
  });

  test('applies each channel identity to main and debug so source-set precedence cannot mask it', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'station-channel-icons-'));
    for (const [channel, identity] of Object.entries(
      ANDROID_CHANNEL_IDENTITY,
    )) {
      const source = join(
        fixture,
        'src-desktop/icons',
        channel,
        'android/mipmap-mdpi',
      );
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, 'ic_launcher.png'), channel);

      for (const sourceSet of ['main', 'debug']) {
        const values = join(
          fixture,
          'src-desktop/gen/android/app/src',
          sourceSet,
          'res/values',
        );
        mkdirSync(values, { recursive: true });
        if (sourceSet === 'main') {
          writeFileSync(
            join(values, 'strings.xml'),
            '<resources><string name="app_name">Station</string><string name="main_activity_title">Station</string></resources>',
          );
        }
        const night = join(
          fixture,
          'src-desktop/gen/android/app/src',
          sourceSet,
          'res/values-night',
        );
        mkdirSync(night, { recursive: true });
        writeFileSync(
          join(night, 'themes.xml'),
          '<resources><style name="Theme.station"><item name="unrelated_generated_night_value">preserve</item></style></resources>',
        );
      }

      applyAndroidChannelIcons(channel, { root: fixture });
      for (const sourceSet of ['main', 'debug']) {
        const resources = join(
          fixture,
          'src-desktop/gen/android/app/src',
          sourceSet,
          'res',
        );
        expect(
          readFileSync(join(resources, 'mipmap-mdpi/ic_launcher.png'), 'utf8'),
        ).toBe(channel);
        if (channel !== 'stable') {
          expect(
            readFileSync(
              join(resources, 'mipmap-mdpi/ic_launcher.png'),
              'utf8',
            ),
          ).not.toBe('stable');
        }
        expect(
          readFileSync(join(resources, 'values/strings.xml'), 'utf8'),
        ).toContain(`>${identity.appName}<`);
        expect(
          readFileSync(
            join(resources, 'values/ic_launcher_background.xml'),
            'utf8',
          ),
        ).toContain(identity.accent);
        for (const qualifier of ['values-v31', 'values-night-v31']) {
          const splash = readFileSync(
            join(resources, qualifier, 'station_channel_splash.xml'),
            'utf8',
          );
          expect(splash).toContain('@mipmap/ic_launcher');
          expect(splash).toContain('@color/station_splash_background');
          expect(splash).toContain('@color/station_channel_accent');
          expect(splash).not.toContain('windowSplashScreenIconBackground');
        }
        expect(
          readFileSync(join(resources, 'values-night/themes.xml'), 'utf8'),
        ).toContain('unrelated_generated_night_value">preserve');
      }
    }
  });

  test('keeps iOS publication gated until each identifier has signing and store ownership', () => {
    expect(matrix.stable.iosStatus).toBe('release-enabled');
    for (const channel of ['development', 'beta', 'nightly']) {
      expect(matrix[channel].iosStatus).toMatch(/^gated:/);
    }
  });
});
