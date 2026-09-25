import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { useState } from 'react';
import { identiconHue } from '../../utils/identicon';
import { getInitials } from '../../utils/layout';
import './BrandIcon.css';

type BrandKey =
  | 'station'
  | 'claude'
  | 'codex'
  | 'pi'
  | 'kiro'
  | 'opencode'
  | 'muse'
  | 'cursor'
  | 'goose'
  | 'qwen';

const BRAND_KEYS = [
  'station',
  'claude',
  'codex',
  'pi',
  'kiro',
  'opencode',
  'muse',
  'cursor',
  'goose',
  'qwen',
] as const satisfies readonly BrandKey[];

/** Exact engine-id-to-mark lookup. Engine display names never participate. */
export function resolveBrandKey(engineId: EngineId): BrandKey | undefined {
  if (
    engineId === 'station-agent' ||
    engineId === 'bedrock' ||
    engineId === 'ollama'
  ) {
    return 'station';
  }
  return BRAND_KEYS.find((brand) => brand === engineId);
}

function explicitBrand(value: unknown): BrandKey | undefined {
  if (typeof value !== 'string' || !value.startsWith('brand:'))
    return undefined;
  const key = value.slice('brand:'.length);
  return BRAND_KEYS.find((candidate) => candidate === key);
}

function isGlyph(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 16 &&
    !/^(?:https?:|data:|\/|[A-Za-z]:[\\/])/.test(value) &&
    !/\.(?:png|jpe?g|webp|ico)$/i.test(value)
  );
}

function safeSameOriginImage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (
    /^data:image\/(?:png|jpe?g|webp|x-icon);base64,[A-Za-z0-9+/=]+$/i.test(
      value,
    )
  ) {
    return value;
  }
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  ) {
    return undefined;
  }
  try {
    const browserOrigin =
      typeof window === 'undefined' ? undefined : window.location.origin;
    const base =
      !browserOrigin || browserOrigin === 'null'
        ? 'http://station.local'
        : browserOrigin;
    const parsed = new URL(value, base);
    return parsed.origin === base && !parsed.username && !parsed.password
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function Mark({ brand }: { brand: BrandKey }) {
  switch (brand) {
    case 'station':
      return (
        <svg viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="8" />
          <path
            className="brand-icon__inverse"
            d="M9 10.5C9 8.57 10.57 7 12.5 7H23v4h-9.5a.5.5 0 0 0 0 1H19a4.5 4.5 0 0 1 0 9h-10v-4h9.5a.5.5 0 0 0 0-1H13a4.5 4.5 0 0 1-4-6.5Z"
          />
        </svg>
      );
    // Provider marks: path data from each provider's own published asset;
    // sources are recorded in docs/third-party/provider-icons.md.
    case 'claude':
      return (
        <svg viewBox="0 0 248 248" aria-hidden="true">
          <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" />
        </svg>
      );
    case 'codex':
      return (
        <svg viewBox="4 4 15.5 15.5" aria-hidden="true">
          <path d="M9.94494 9.59163V8.13227C9.94494 8.00935 9.99105 7.91713 10.0985 7.85575L13.0327 6.16599C13.4321 5.93558 13.9083 5.8281 14.3998 5.8281C16.2432 5.8281 17.4108 7.25677 17.4108 8.77751C17.4108 8.885 17.4108 9.00792 17.3953 9.13083L14.3537 7.34884C14.1694 7.24135 13.985 7.24135 13.8007 7.34884L9.94494 9.59163ZM16.7963 15.2755V11.7883C16.7963 11.5732 16.704 11.4196 16.5197 11.3121L12.664 9.0693L13.9236 8.34725C14.0311 8.28587 14.1234 8.28587 14.2308 8.34725L17.165 10.037C18.0099 10.5287 18.5782 11.5732 18.5782 12.587C18.5782 13.7544 17.887 14.8298 16.7963 15.2753V15.2755ZM9.03861 12.2031L7.77896 11.4658C7.67146 11.4045 7.62535 11.3122 7.62535 11.1893V7.8098C7.62535 6.16613 8.88501 4.92176 10.5902 4.92176C11.2354 4.92176 11.8344 5.13689 12.3415 5.52089L9.31526 7.27218C9.13097 7.37968 9.03875 7.53328 9.03875 7.74841V12.2033L9.03861 12.2031ZM11.75 13.77L9.94494 12.7562V10.6056L11.75 9.59178L13.5549 10.6056V12.7562L11.75 13.77ZM12.9098 18.44C12.2645 18.44 11.6655 18.2249 11.1585 17.8409L14.1847 16.0896C14.369 15.9821 14.4612 15.8285 14.4612 15.6134V11.1585L15.7363 11.8958C15.8438 11.9572 15.8899 12.0494 15.8899 12.1723V15.5519C15.8899 17.1955 14.6148 18.44 12.9098 18.44ZM9.26901 15.0144L6.33486 13.3246C5.4899 12.833 4.92161 11.7885 4.92161 10.7746C4.92161 9.59177 5.62824 8.53183 6.71886 8.0863V11.5887C6.71886 11.8039 6.81109 11.9575 6.99538 12.065L10.8359 14.2923L9.57621 15.0144C9.46872 15.0758 9.37649 15.0758 9.26901 15.0144ZM9.10013 17.5337C7.36426 17.5337 6.08919 16.2279 6.08919 14.6149C6.08919 14.492 6.1046 14.3691 6.11988 14.2462L9.1461 15.9975C9.33039 16.105 9.51483 16.105 9.69912 15.9975L13.5549 13.7702V15.2295C13.5549 15.3524 13.5088 15.4446 13.4013 15.506L10.4671 17.1958C10.0677 17.4262 9.59148 17.5337 9.09999 17.5337H9.10013ZM12.9098 19.3616C14.7685 19.3616 16.32 18.0406 16.6735 16.2893C18.3939 15.8438 19.5 14.2308 19.5 12.5872C19.5 11.5118 19.0391 10.4673 18.2096 9.71454C18.2864 9.39192 18.3326 9.0693 18.3326 8.74682C18.3326 6.55014 16.5505 4.90634 14.4921 4.90634C14.0774 4.90634 13.6779 4.96772 13.2785 5.10605C12.5872 4.43011 11.6347 4 10.5902 4C8.7314 4 7.17996 5.32103 6.8265 7.07232C5.10605 7.51786 4 9.13083 4 10.7745C4 11.8498 4.4608 12.8944 5.29035 13.6471C5.21354 13.9697 5.16743 14.2923 5.16743 14.6148C5.16743 16.8114 6.94941 18.4552 9.00792 18.4552C9.42261 18.4552 9.82204 18.3939 10.2215 18.2556C10.9127 18.9315 11.8651 19.3616 12.9098 19.3616Z" />
        </svg>
      );
    case 'pi':
      return (
        <svg viewBox="-195 -195 950 950" aria-hidden="true">
          <rect x="-195" y="-195" width="950" height="950" rx="190" />
          <path
            className="brand-icon__inverse"
            d="M420 280H280V140H0V0H420V280Z"
          />
          <path className="brand-icon__inverse" d="M560 560H420V280H560V560Z" />
          <path
            className="brand-icon__inverse"
            d="M140 560H0V140H140V280H280V420H140V560Z"
          />
        </svg>
      );
    case 'kiro':
      return (
        <svg viewBox="0 0 1200 1200" aria-hidden="true">
          <rect width="1200" height="1200" rx="260" />
          <path
            className="brand-icon__inverse"
            d="M398.554 818.914C316.315 1001.03 491.477 1046.74 620.672 940.156C658.687 1059.66 801.052 970.473 852.234 877.795C964.787 673.567 919.318 465.357 907.64 422.374C827.637 129.443 427.623 128.946 358.8 423.865C342.651 475.544 342.402 534.18 333.458 595.051C328.986 625.86 325.507 645.488 313.83 677.785C306.873 696.424 297.68 712.819 282.773 740.645C259.915 783.881 269.604 867.113 387.87 823.883L399.051 818.914H398.554Z"
          />
          <path
            className="brand-icon__ink"
            d="M636.123 549.353C603.328 549.353 598.359 510.097 598.359 486.742C598.359 465.623 602.086 448.977 609.293 438.293C615.504 428.852 624.697 424.131 636.123 424.131C647.555 424.131 657.492 428.852 664.447 438.541C672.398 449.474 676.623 466.12 676.623 486.742C676.623 525.998 661.471 549.353 636.375 549.353H636.123Z"
          />
          <path
            className="brand-icon__ink"
            d="M771.24 549.353C738.445 549.353 733.477 510.097 733.477 486.742C733.477 465.623 737.203 448.977 744.41 438.293C750.621 428.852 759.814 424.131 771.24 424.131C782.672 424.131 792.609 428.852 799.564 438.541C807.516 449.474 811.74 466.12 811.74 486.742C811.74 525.998 796.588 549.353 771.492 549.353H771.24Z"
          />
        </svg>
      );
    case 'opencode':
      return (
        <svg viewBox="128 96 256 320" aria-hidden="true">
          <path className="brand-icon__muted" d="M320 224V352H192V224H320Z" />
          <path
            fillRule="evenodd"
            d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
          />
        </svg>
      );
    case 'muse':
    case 'cursor':
    case 'goose':
    case 'qwen':
      return <img src={`/provider-icons/${brand}.svg`} alt="" />;
  }
}

interface BrandIconProps {
  name: string;
  id?: string;
  engineId?: EngineId;
  icon?: unknown;
  /** Output-only same-origin URL issued by Station's local icon route. */
  iconUrl?: string;
  /** Preserve existing agent/project artwork without permitting remote hotlinks. */
  allowSafeImageIcon?: boolean;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  alt?: string;
  /**
   * Deterministic identicon seed (archive#1424) — when set, the plain-text
   * initials fallback (no glyph/brand mark/image resolved) renders with a
   * seed-derived hue instead of the flat default swatch, so two different
   * unbranded identities are visually distinguishable. Omitted callers
   * (project icons, integration glyphs) keep today's flat fallback exactly
   * as before — this is opt-in per call site, never a default behavior
   * change to `BrandIcon` itself.
   */
  identiconSeed?: string;
}

/**
 * Shared identity renderer. It never uses a manifest URL: explicit glyphs win,
 * then a same-origin local integration image, then a bundled mark, then initials.
 */
export function BrandIcon({
  name,
  id,
  engineId,
  icon,
  iconUrl,
  allowSafeImageIcon = false,
  size = 24,
  className,
  style,
  alt = '',
  identiconSeed,
}: BrandIconProps) {
  const [failedImageSource, setFailedImageSource] = useState<string>();
  const explicitBrandKey = explicitBrand(icon);
  const brand =
    explicitBrandKey ?? (engineId ? resolveBrandKey(engineId) : undefined);
  const localUrl =
    typeof iconUrl === 'string' &&
    /^\/(?:api\/)?integrations\/[A-Za-z0-9._-]+\/icon$/.test(iconUrl)
      ? iconUrl
      : undefined;
  const safeImageIcon = allowSafeImageIcon
    ? safeSameOriginImage(icon)
    : undefined;
  const imageSource = localUrl ?? safeImageIcon;
  const fallback = getInitials(name || id || '?');
  const content = explicitBrand(icon)
    ? undefined
    : isGlyph(icon)
      ? icon
      : undefined;
  const usesInitialsFallback =
    !content &&
    !explicitBrandKey &&
    !(imageSource && failedImageSource !== imageSource) &&
    !brand;
  const isIdenticon = Boolean(identiconSeed) && usesInitialsFallback;

  return (
    <span
      className={`brand-icon${brand ? ` brand-icon--${brand}` : ''}${isIdenticon ? ' brand-icon--identicon' : ''}${className ? ` ${className}` : ''}`}
      style={
        {
          width: size,
          height: size,
          // archive#1424: `.brand-icon__initials`'s
          // font-size is a percentage of THIS custom property, not of `size`
          // directly — a bare percentage font-size resolves against the
          // inherited ambient text size, not this element's own box
          // dimensions, so without this the initials never actually scaled
          // with the icon (always ~the same few px regardless of a 20px vs
          // 48px icon). Always set, not just for the identicon path — every
          // initials fallback benefits, and it's inert (unused) on every
          // other content branch.
          '--icon-size': `${size}px`,
          ...(isIdenticon
            ? ({
                '--identicon-hue': identiconHue(identiconSeed!),
              } as React.CSSProperties)
            : undefined),
          ...style,
        } as React.CSSProperties
      }
      data-brand-key={brand}
      {...(alt ? { role: 'img', 'aria-label': alt } : { 'aria-hidden': true })}
    >
      {content ? (
        <span className="brand-icon__glyph">{content}</span>
      ) : explicitBrandKey ? (
        <Mark brand={explicitBrandKey} />
      ) : imageSource && failedImageSource !== imageSource ? (
        <img
          src={imageSource}
          alt=""
          onError={() => setFailedImageSource(imageSource)}
        />
      ) : brand ? (
        <Mark brand={brand} />
      ) : (
        <span className="brand-icon__initials">{fallback}</span>
      )}
    </span>
  );
}
