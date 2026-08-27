import { describe, expect, test } from 'vitest';
import { deriveDefaultDeviceName } from '../core/deviceLabel';

const CHROME_BRANDS = [
  { brand: 'Not.A/Brand', version: '8' },
  { brand: 'Chromium', version: '125' },
  { brand: 'Google Chrome', version: '125' },
];

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const FIREFOX_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0';

describe('deriveDefaultDeviceName', () => {
  test('uses userAgentData high-entropy model when available (mobile)', async () => {
    const label = await deriveDefaultDeviceName({
      userAgentData: {
        brands: CHROME_BRANDS,
        mobile: true,
        platform: 'Android',
        getHighEntropyValues: async () => ({
          model: 'Pixel 8',
          platform: 'Android',
          brands: CHROME_BRANDS,
        }),
      },
    });
    expect(label).toBe('Pixel 8 · Chrome');
  });

  test('uses userAgentData high-entropy platform when model is empty (desktop)', async () => {
    const label = await deriveDefaultDeviceName({
      userAgentData: {
        brands: CHROME_BRANDS,
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: async () => ({
          model: '',
          platform: 'macOS',
          brands: CHROME_BRANDS,
        }),
      },
    });
    expect(label).toBe('Mac · Chrome');
  });

  test('falls back to low-entropy userAgentData fields when getHighEntropyValues rejects', async () => {
    const label = await deriveDefaultDeviceName({
      userAgentData: {
        brands: CHROME_BRANDS,
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: async () => {
          throw new Error('permission denied');
        },
      },
      userAgent: MAC_UA,
    });
    // getHighEntropyValues rejected, so the helper falls back to the
    // low-entropy userAgentData platform/brands rather than the UA string.
    expect(label).toBe('Windows · Chrome');
  });

  test('falls back to a UA-string parse when userAgentData is absent (Mac Chrome)', async () => {
    const label = await deriveDefaultDeviceName({ userAgent: MAC_UA });
    expect(label).toBe('Mac · Chrome');
  });

  test('falls back to a UA-string parse when userAgentData is absent (Android Chrome)', async () => {
    const label = await deriveDefaultDeviceName({ userAgent: ANDROID_UA });
    expect(label).toBe('Pixel 8 · Chrome');
  });

  test('falls back to a UA-string parse for non-Chromium browsers', async () => {
    const label = await deriveDefaultDeviceName({ userAgent: FIREFOX_MAC_UA });
    expect(label).toBe('Mac · Firefox');
  });

  test('falls back to "This browser" when nothing is available', async () => {
    expect(await deriveDefaultDeviceName(undefined)).toBe('This browser');
    expect(await deriveDefaultDeviceName({})).toBe('This browser');
  });

  test('prefers Chromium over a GREASE brand when no other usable brand is present', async () => {
    const brands = [
      { brand: 'Not.A/Brand', version: '8' },
      { brand: 'Chromium', version: '125' },
    ];
    const label = await deriveDefaultDeviceName({
      userAgentData: {
        brands,
        mobile: false,
        platform: 'macOS',
        getHighEntropyValues: async () => ({
          model: '',
          platform: 'macOS',
          brands,
        }),
      },
    });
    expect(label).toBe('Mac · Chromium');
  });

  test('never returns a GREASE brand string, even as the only fallback candidate', async () => {
    const greaseOnly = [{ brand: 'Not.A/Brand', version: '8' }];
    const label = await deriveDefaultDeviceName({
      userAgentData: {
        brands: greaseOnly,
        mobile: false,
        platform: undefined,
        getHighEntropyValues: async () => ({
          model: '',
          platform: undefined,
          brands: greaseOnly,
        }),
      },
      userAgent: MAC_UA,
    });
    // No usable brand and no usable platform at either userAgentData tier,
    // so this falls all the way through to the UA-string parse.
    expect(label).toBe('Mac · Chrome');
    expect(label).not.toContain('Not.A/Brand');
  });

  test('falls back to "This browser" for an unrecognized UA string', async () => {
    const label = await deriveDefaultDeviceName({
      userAgent:
        'Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/29.1.1',
    });
    expect(label).toBe('This browser');
  });
});

describe('native shell device naming (#browser-leak)', () => {
  it.each([
    'Station',
    'Station Beta',
    'Station Nightly',
    'Station Dev (pairing-worktree)',
  ])(
    'uses local %s identity instead of the WebView brand',
    async (hostAppName) => {
      // The Android shell reports itself as "Android WebView" through the UA
      // brands, which is an implementation detail the user should never see.
      const label = await deriveDefaultDeviceName({
        userAgentData: {
          platform: 'Android',
          brands: [{ brand: 'Android WebView', version: '140' }],
          getHighEntropyValues: async () => ({
            model: 'Pixel 10 Pro XL',
            platform: 'Android',
            brands: [{ brand: 'Android WebView', version: '140' }],
          }),
        },
        hostAppName,
      });
      expect(label).toBe(`Pixel 10 Pro XL · ${hostAppName}`);
    },
  );

  it('still reports the real browser when there is no host app', async () => {
    const label = await deriveDefaultDeviceName({
      userAgentData: {
        platform: 'macOS',
        brands: [{ brand: 'Google Chrome', version: '140' }],
      },
    });
    expect(label).toBe('Mac · Chrome');
  });

  it('falls back to "This device" natively and "This browser" on the web', async () => {
    expect(await deriveDefaultDeviceName({ hostAppName: 'Station' })).toBe(
      'This device',
    );
    expect(await deriveDefaultDeviceName({})).toBe('This browser');
  });

  it('uses the host app name when only a user-agent string is available', async () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 17; Pixel 10 Pro XL) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0 Mobile Safari/537.36';
    expect(await deriveDefaultDeviceName({ userAgent: ua })).toBe(
      'Pixel 10 Pro XL · Chrome',
    );
    expect(
      await deriveDefaultDeviceName({ userAgent: ua, hostAppName: 'Station' }),
    ).toBe('Pixel 10 Pro XL · Station');
  });
});
