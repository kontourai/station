import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { stageIosLaunchScreen } from '../lib/ios-launch-screen.mjs';

const makeTempDir = trackTempDirs();

test.each([
  ['io.kontourai.station', 'stable'],
  ['io.kontourai.station.dev.instance', 'dev'],
  ['io.kontourai.station.beta', 'beta'],
  ['io.kontourai.station.nightly', 'nightly'],
])(
  'regenerated %s stages its exact channel launch mark',
  (identifier, channel) => {
    const root = makeTempDir('station-ios-launch-');
    const apple = join(root, 'src-desktop/gen/apple');
    mkdirSync(apple, { recursive: true });
    mkdirSync(join(root, 'src-ui/public'), { recursive: true });
    mkdirSync(join(root, 'scripts/templates/ios'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/templates/ios/LaunchScreen.storyboard'),
      'reviewed-storyboard',
    );
    writeFileSync(join(root, 'src-ui/public/favicon.png'), 'stable-artwork');
    for (const variant of ['dev', 'beta', 'nightly'])
      writeFileSync(
        join(root, `src-ui/public/favicon-${variant}.png`),
        `${variant}-artwork`,
      );
    writeFileSync(
      join(apple, 'project.yml'),
      `settingGroups:\n  app:\n    base:\n      PRODUCT_BUNDLE_IDENTIFIER: io.kontourai.station\ntargets:\n  station_iOS:\n    settings:\n      base:\n        PRODUCT_BUNDLE_IDENTIFIER: ${identifier}\n`,
    );
    stageIosLaunchScreen(root);
    expect(
      readFileSync(
        join(apple, 'Assets.xcassets/StationLaunchLogo.imageset/logo.png'),
        'utf8',
      ),
    ).toBe(`${channel}-artwork`);
    expect(readFileSync(join(apple, 'LaunchScreen.storyboard'), 'utf8')).toBe(
      'reviewed-storyboard',
    );
    const background = JSON.parse(
      readFileSync(
        join(
          apple,
          'Assets.xcassets/StationLaunchBackground.colorset/Contents.json',
        ),
        'utf8',
      ),
    );
    expect(background.colors).toHaveLength(2);
    expect(background.colors[1].appearances).toEqual([
      { appearance: 'luminosity', value: 'dark' },
    ]);
  },
);

test('unknown generated app identity cannot silently ship Stable launch artwork', () => {
  const root = makeTempDir('station-ios-launch-refusal-');
  const apple = join(root, 'src-desktop/gen/apple');
  mkdirSync(apple, { recursive: true });
  writeFileSync(
    join(apple, 'project.yml'),
    'settingGroups:\n  app:\n    base:\n      PRODUCT_BUNDLE_IDENTIFIER: io.example.other\n',
  );
  expect(() => stageIosLaunchScreen(root)).toThrow(
    'Unknown generated iOS Station identity',
  );
});
