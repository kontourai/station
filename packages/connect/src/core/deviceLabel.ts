/**
 * Pure helpers that derive a friendly default device-name label for the
 * pairing UI's device-name field (e.g. "Mac · Chrome", "Pixel 8 · Chrome").
 * The field always stays user-editable — this only supplies the starting
 * value. Preference order: `navigator.userAgentData` high-entropy values
 * (model/platform), then `userAgentData`'s low-entropy platform/brands, then
 * a `navigator.userAgent` string parse, then the "This browser" fallback.
 */

export interface UADataBrand {
  brand: string;
  version: string;
}

/** Minimal shape of the experimental `NavigatorUAData` interface we read. */
export interface NavigatorUAData {
  brands?: readonly UADataBrand[];
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?(hints: readonly string[]): Promise<{
    model?: string;
    platform?: string;
    platformVersion?: string;
    brands?: readonly UADataBrand[];
  }>;
}

export interface DeviceNameSource {
  userAgentData?: NavigatorUAData;
  userAgent?: string;
  /**
   * Name of the native shell hosting this UI, when it is not a browser.
   *
   * Inside the desktop/mobile shells the UI runs in a WebView, so the browser
   * brand is an implementation detail the user should never be shown — the
   * Android app was defaulting its own pairing request to
   * "Pixel 10 Pro XL · Android WebView". When set, this replaces the browser
   * brand, giving "Pixel 10 Pro XL · Station".
   */
  hostAppName?: string;
}

const FALLBACK_DEVICE_NAME = 'This browser';
const FALLBACK_NATIVE_DEVICE_NAME = 'This device';
const GREASED_BRAND_PATTERN = /not.?a.?brand/i;

function shortenBrandName(brand: string): string {
  if (/Google Chrome/i.test(brand)) return 'Chrome';
  if (/Microsoft Edge/i.test(brand)) return 'Edge';
  if (/Opera/i.test(brand)) return 'Opera';
  if (/Brave/i.test(brand)) return 'Brave';
  return brand;
}

function pickBrandName(
  brands: readonly UADataBrand[] | undefined,
): string | undefined {
  if (!brands || brands.length === 0) return undefined;
  // GREASE ("Not.A/Brand"-style) entries never identify a real browser, so
  // they're excluded from every tier of the pick — including the fallback,
  // which previously only re-checked for "not Chromium" and could leak a
  // GREASE string when it was the only non-Chromium entry present.
  const usable = brands.filter(
    (entry) => entry.brand && !GREASED_BRAND_PATTERN.test(entry.brand),
  );
  if (usable.length === 0) return undefined;
  const candidate =
    usable.find((entry) => entry.brand !== 'Chromium') ?? usable[0];
  return candidate ? shortenBrandName(candidate.brand) : undefined;
}

function shortenPlatformName(platform: string | undefined): string | undefined {
  const normalized = platform?.trim();
  if (!normalized) return undefined;
  if (/^mac/i.test(normalized)) return 'Mac';
  if (/^win/i.test(normalized)) return 'Windows';
  if (/chrome ?os/i.test(normalized)) return 'Chromebook';
  if (/^linux/i.test(normalized)) return 'Linux';
  if (/^android/i.test(normalized)) return 'Android';
  return normalized;
}

function joinLabelAndBrand(
  label: string | undefined,
  brand: string | undefined,
): string | undefined {
  if (label && brand) return `${label} · ${brand}`;
  return label ?? brand;
}

function parseUserAgentString(userAgent: string, hostAppName?: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent) || /\bOpera\b/.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : undefined;

  const androidModelMatch = userAgent.match(/Android\s[\d.]+;\s*([^)]+)\)/);
  const androidModel = androidModelMatch?.[1]
    ?.replace(/\s*Build\/.*$/, '')
    .trim();
  const platform =
    androidModel && androidModel.length > 0
      ? androidModel
      : /iPhone/.test(userAgent)
        ? 'iPhone'
        : /iPad/.test(userAgent)
          ? 'iPad'
          : /Macintosh/.test(userAgent)
            ? 'Mac'
            : /Windows/.test(userAgent)
              ? 'Windows'
              : /CrOS/.test(userAgent)
                ? 'Chromebook'
                : /Android/.test(userAgent)
                  ? 'Android'
                  : /Linux/.test(userAgent)
                    ? 'Linux'
                    : undefined;

  return (
    joinLabelAndBrand(platform, hostAppName ?? browser) ??
    (hostAppName ? FALLBACK_NATIVE_DEVICE_NAME : FALLBACK_DEVICE_NAME)
  );
}

/**
 * Derives a default device-name label from the caller's environment. Never
 * throws — any failure reading high-entropy Client Hints falls back to the
 * next tier down to "This browser".
 */
export async function deriveDefaultDeviceName(
  source: DeviceNameSource | undefined,
): Promise<string> {
  const hostAppName = source?.hostAppName?.trim() || undefined;
  const uaData = source?.userAgentData;
  if (uaData) {
    if (typeof uaData.getHighEntropyValues === 'function') {
      try {
        const highEntropy = await uaData.getHighEntropyValues([
          'model',
          'platform',
        ]);
        const model = highEntropy.model?.trim();
        const platform = shortenPlatformName(
          highEntropy.platform ?? uaData.platform,
        );
        const brand =
          hostAppName ?? pickBrandName(highEntropy.brands ?? uaData.brands);
        const label = model && model.length > 0 ? model : platform;
        const combined = joinLabelAndBrand(label, brand);
        if (combined) return combined;
      } catch {
        // High-entropy Client Hints can be blocked by permissions policy or
        // unsupported; fall back to the low-entropy fields below.
      }
    }
    const platform = shortenPlatformName(uaData.platform);
    const brand = hostAppName ?? pickBrandName(uaData.brands);
    const combined = joinLabelAndBrand(platform, brand);
    if (combined) return combined;
  }
  if (source?.userAgent) {
    return parseUserAgentString(source.userAgent, hostAppName);
  }
  return hostAppName ? FALLBACK_NATIVE_DEVICE_NAME : FALLBACK_DEVICE_NAME;
}
