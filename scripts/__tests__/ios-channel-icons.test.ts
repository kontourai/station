import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import {
  applyIosChannelIcons,
  assertOpaqueIosPngs,
  catalogFilenames,
  channelSetDigest,
  IOS_APP_ICON_CATALOG,
  SHIPPED_IOS_APP_ICON,
  translucentIosPngs,
  verifyIosChannelIcons,
  verifyShippedIosAppIcon,
} from '../ios-channel-icons.mjs';
import { IOS_TESTFLIGHT_CHANNELS } from '../ios-testflight-channel.mjs';

const root = resolve(import.meta.dirname, '../..');
const catalog = resolve(root, IOS_APP_ICON_CATALOG);
const committedFilenames = catalogFilenames(catalog);
const iosChannels = ['stable', 'beta', 'nightly'] as const;

function setDir(channel: (typeof iosChannels)[number], base = root) {
  return join(base, 'src-desktop', IOS_TESTFLIGHT_CHANNELS[channel].iosIconSet);
}

/**
 * A generated-project fixture: the real Contents.json, template PNGs with
 * distinct bytes per name (as `tauri ios init` leaves them), and a nightly
 * set whose bytes differ from the template.
 */
function fixture({ setBytes = (name: string) => `nightly:${name}` } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'station-ios-icons-'));
  const fixtureCatalog = join(base, IOS_APP_ICON_CATALOG);
  mkdirSync(fixtureCatalog, { recursive: true });
  writeFileSync(
    join(fixtureCatalog, 'Contents.json'),
    readFileSync(join(catalog, 'Contents.json')),
  );
  for (const name of committedFilenames)
    writeFileSync(join(fixtureCatalog, name), `template:${name}`);
  const nightly = setDir('nightly', base);
  mkdirSync(nightly, { recursive: true });
  for (const name of committedFilenames)
    writeFileSync(join(nightly, name), setBytes(name));
  return { base, catalog: fixtureCatalog, nightly };
}

describe('iOS channel icon sets', () => {
  it.each(iosChannels)(
    'commits a %s set carrying every file the catalog Contents.json references',
    (channel) => {
      const dir = setDir(channel);
      const files = readdirSync(dir)
        .filter((name) => name.endsWith('.png'))
        .sort();
      expect(files).toEqual(committedFilenames);
      for (const name of files)
        expect(readFileSync(join(dir, name)).length).toBeGreaterThan(0);
    },
  );

  it.each(iosChannels)(
    'commits a fully opaque %s set (CgBI premultiplication is lossless only at alpha 255)',
    (channel) => {
      expect(translucentIosPngs(setDir(channel))).toEqual([]);
      expect(() => assertOpaqueIosPngs(setDir(channel))).not.toThrow();
    },
  );

  it('names every PNG in a set that carries any alpha below 255', () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-ios-alpha-'));
    const opaque = new PNG({ width: 2, height: 2 });
    opaque.data.fill(255);
    writeFileSync(join(dir, 'AppIcon-20x20@1x.png'), PNG.sync.write(opaque));
    const translucent = new PNG({ width: 2, height: 2 });
    translucent.data.fill(255);
    translucent.data[3 * 4 + 3] = 254; // one corner pixel, one step off
    writeFileSync(join(dir, 'AppIcon-512@2x.png'), PNG.sync.write(translucent));
    expect(translucentIosPngs(dir)).toEqual(['AppIcon-512@2x.png']);
    expect(() => assertOpaqueIosPngs(dir)).toThrow(
      /AppIcon-512@2x\.png in .* alpha below 255/,
    );
  });

  it('binds the overlay iosIconSet to the channel-platform matrix authority', () => {
    const matrix = JSON.parse(
      readFileSync(
        resolve(root, 'config/channel-platform-matrix.json'),
        'utf8',
      ),
    ).channels;
    for (const channel of iosChannels) {
      expect(`src-desktop/${IOS_TESTFLIGHT_CHANNELS[channel].iosIconSet}`).toBe(
        matrix[channel].iosIconSource,
      );
    }
  });

  it('keeps the committed gen/apple catalog equal to the stable set and distinct from beta and nightly', () => {
    expect(verifyIosChannelIcons('stable')).toMatchObject({
      iconSet: 'icons/stable/ios',
      iconSetFiles: committedFilenames,
      catalogMatchesChannelSet: true,
    });
    expect(() => verifyIosChannelIcons('beta')).toThrow(/does not match/);
    expect(() => verifyIosChannelIcons('nightly')).toThrow(/does not match/);
    expect(
      new Set(iosChannels.map((channel) => channelSetDigest(setDir(channel))))
        .size,
    ).toBe(3);
  });

  it('applies the channel set over every template PNG and verify derives the match', () => {
    const { base, catalog: fixtureCatalog, nightly } = fixture();
    expect(() => verifyIosChannelIcons('nightly', { root: base })).toThrow(
      /does not match/,
    );
    const applied = applyIosChannelIcons('nightly', { root: base });
    expect(applied.files).toEqual(committedFilenames);
    for (const name of committedFilenames) {
      expect(readFileSync(join(fixtureCatalog, name), 'utf8')).toBe(
        `nightly:${name}`,
      );
    }
    const receipt = verifyIosChannelIcons('nightly', { root: base });
    expect(receipt).toEqual({
      iconSet: 'icons/nightly/ios',
      iconSetFiles: committedFilenames,
      iconSetSha256: channelSetDigest(nightly),
      catalogMatchesChannelSet: true,
    });
    expect(receipt.iconSetSha256).toMatch(/^[0-9a-f]{64}$/);
    // Apply is bound to a fresh init: a catalog that already holds the set
    // is indistinguishable from a set that IS the template, so it is refused
    // rather than accepted, and the catalog is left as it was.
    expect(() => applyIosChannelIcons('nightly', { root: base })).toThrow(
      /byte-identical to what the catalog already holds/,
    );
    expect(verifyIosChannelIcons('nightly', { root: base })).toEqual(receipt);
  });

  it('fails closed when the set shares even one file with the template', () => {
    const { base } = fixture({
      setBytes: (name) =>
        name === 'AppIcon-512@2x.png' ? `template:${name}` : `nightly:${name}`,
    });
    expect(() => applyIosChannelIcons('nightly', { root: base })).toThrow(
      /AppIcon-512@2x\.png in .* byte-identical to what the catalog already holds/,
    );
  });

  it('fails closed when the set lacks a referenced file, leaving the catalog untouched', () => {
    const { base, catalog: fixtureCatalog, nightly } = fixture();
    const victim = committedFilenames[committedFilenames.length - 1];
    unlinkSync(join(nightly, victim));
    expect(() => applyIosChannelIcons('nightly', { root: base })).toThrow(
      new RegExp(`lacks ${victim.replace(/[.@]/g, '\\$&')}`),
    );
    for (const name of committedFilenames)
      expect(readFileSync(join(fixtureCatalog, name), 'utf8')).toBe(
        `template:${name}`,
      );
  });

  it('fails closed when the committed set IS the template default', () => {
    const { base, catalog: fixtureCatalog } = fixture({
      setBytes: (name) => `template:${name}`,
    });
    expect(() => applyIosChannelIcons('nightly', { root: base })).toThrow(
      /byte-identical to what the catalog already holds/,
    );
    expect(
      readFileSync(join(fixtureCatalog, committedFilenames[0]), 'utf8'),
    ).toBe(`template:${committedFilenames[0]}`);
  });

  it('verify reports the first catalog file that drifts from the set', () => {
    const { base, catalog: fixtureCatalog } = fixture();
    applyIosChannelIcons('nightly', { root: base });
    writeFileSync(join(fixtureCatalog, 'AppIcon-512@2x.png'), 'template:stale');
    expect(() => verifyIosChannelIcons('nightly', { root: base })).toThrow(
      /AppIcon-512@2x\.png/,
    );
  });
});

describe.skipIf(process.platform !== 'darwin')(
  'shipped iOS app icon pixel comparison (macOS: xcrun pngcrush + sips)',
  () => {
    const cgbi = (source: string, destination: string) =>
      execFileSync(
        'xcrun',
        ['--sdk', 'iphoneos', 'pngcrush', '-iphone', '-q', source, destination],
        { stdio: 'pipe', windowsHide: true },
      );

    it('accepts the channel icon after Apple CgBI re-encoding and rejects another channel', () => {
      const app = mkdtempSync(join(tmpdir(), 'station-ios-app-'));
      cgbi(
        join(setDir('nightly'), SHIPPED_IOS_APP_ICON.setFile),
        join(app, SHIPPED_IOS_APP_ICON.bundleFile),
      );
      const shipped = readFileSync(join(app, SHIPPED_IOS_APP_ICON.bundleFile));
      // Bytes never match after re-encoding; the check must be pixel-level.
      expect(shipped.subarray(0, 40).includes('CgBI')).toBe(true);
      expect(
        shipped.equals(
          readFileSync(join(setDir('nightly'), SHIPPED_IOS_APP_ICON.setFile)),
        ),
      ).toBe(false);

      expect(verifyShippedIosAppIcon('nightly', { appDir: app })).toMatchObject(
        {
          shippedIcon: 'AppIcon60x60@2x.png',
          shippedIconPixelsMatchChannelSet: true,
        },
      );
      expect(() => verifyShippedIosAppIcon('stable', { appDir: app })).toThrow(
        /pixels differ/,
      );
      expect(() => verifyShippedIosAppIcon('beta', { appDir: app })).toThrow(
        /pixels differ/,
      );
    });

    it('fails closed when the bundle ships no icon', () => {
      const app = mkdtempSync(join(tmpdir(), 'station-ios-app-empty-'));
      expect(() => verifyShippedIosAppIcon('nightly', { appDir: app })).toThrow(
        /ships no app icon/,
      );
    });
  },
);

describe('TestFlight delivery applies and verifies the channel icon set', () => {
  const source = readFileSync(
    resolve(root, '.github/workflows/testflight-delivery.yml'),
    'utf8',
  );
  const workflow = load(source) as {
    jobs: Record<
      string,
      { steps: Array<{ name?: string; run?: string; uses?: string }> }
    >;
  };
  const steps = workflow.jobs.deliver.steps;
  const named = (name: string) => {
    const step = steps.find((candidate) => candidate.name === name);
    if (!step?.run) throw new Error(`missing step ${name}`);
    return step;
  };
  const apply = `node ../scripts/ios-channel-icons.mjs apply '\${{ inputs.channel }}'`;
  const verify = `node scripts/ios-channel-icons.mjs verify '\${{ inputs.channel }}' --app "$app" --receipt provider-receipts/channel-icon-receipt.json`;

  it('applies the set immediately after EVERY tauri ios init and before the build', () => {
    const inits = steps.filter((step) =>
      step.run?.includes('npx tauri ios init'),
    );
    expect(inits.length).toBe(2);
    for (const step of inits) {
      const run = step.run as string;
      const init = run.indexOf('npx tauri ios init');
      const applied = run.indexOf(apply, init);
      expect(
        applied,
        `${step.name} must apply the set after init`,
      ).toBeGreaterThan(init);
      // Nothing between init and apply: the next command after init IS apply.
      const between = run
        .slice(init, applied)
        .split('\n')
        .slice(1)
        .filter((line) => line.trim() && !line.trim().startsWith('#'));
      expect(between).toEqual([]);
    }
    const build = steps.findIndex((step) =>
      step.run?.includes('npx tauri ios build'),
    );
    const lastInit = steps.lastIndexOf(inits[inits.length - 1]);
    expect(lastInit).toBeLessThan(build);
    expect(source.match(/ios-channel-icons\.mjs apply/g)).toHaveLength(2);
  });

  it('derives the receipt from a fail-closed comparison instead of recording a digest', () => {
    const run = named('Verify IPA identity, profile and package contents')
      .run as string;
    expect(run).toContain(verify);
    expect(run.indexOf(verify)).toBeGreaterThan(run.indexOf('unzip -q "$ipa"'));
    expect(run.indexOf(verify)).toBeLessThan(run.indexOf('cp "$ipa"'));
    expect(source).not.toContain('test -s "$generated_icon"');
    expect(source).not.toContain('generatedAssetSha256');
    const overlay = named('Generate the exact channel identity overlay')
      .run as string;
    expect(overlay).toContain(
      'iosTestFlightChannel(process.argv[1]).iosIconSet',
    );
    expect(overlay).toContain('test -d "src-desktop/$icon_set"');
  });

  it('refuses to upload a staged receipt whose derived fields are absent', () => {
    const bind = workflow.jobs.upload.steps.find(
      (step) =>
        step.name === 'Bind the staged IPA and receipts to this exact source',
    );
    expect(bind?.run).toContain('value.catalogMatchesChannelSet!==true');
    expect(bind?.run).toContain(
      'value.shippedIconPixelsMatchChannelSet!==true',
    );
    expect(bind?.run).toContain('value.iconSetSha256');
  });
});
