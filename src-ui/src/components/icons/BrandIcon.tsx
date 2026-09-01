import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { useState } from 'react';
import { identiconHue } from '../../utils/identicon';
import { getInitials } from '../../utils/layout';
import './BrandIcon.css';

export type BrandKey =
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
    case 'claude':
      return (
        <svg viewBox="0 0 256 257" aria-hidden="true">
          <path d="m50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z" />
        </svg>
      );
    case 'codex':
      return (
        <svg viewBox="0 0 256 260" aria-hidden="true">
          <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z" />
        </svg>
      );
    case 'pi':
      return (
        <svg viewBox="0 0 800 800" aria-hidden="true">
          <rect width="800" height="800" rx="160" />
          <path
            className="brand-icon__inverse"
            fillRule="evenodd"
            d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
          />
          <path
            className="brand-icon__inverse"
            d="M517.36 400H634.72V634.72H517.36Z"
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
    case 'muse':
    case 'cursor':
    case 'goose':
    case 'qwen':
      return <img src={`/provider-icons/${brand}.svg`} alt="" />;
    case 'opencode':
      return (
        <svg viewBox="0 0 32 40" aria-hidden="true">
          <path className="brand-icon__muted" d="M24 32H8V16H24V32Z" />
          <path d="M24 8H8V32H24V8ZM32 40H0V0H32V40Z" />
        </svg>
      );
  }
}

export interface BrandIconProps {
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
