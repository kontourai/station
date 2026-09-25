import type { EngineId } from '@kontourai/station-contracts/agent-identity';
import { useState } from 'react';
import { identiconHue } from '../../utils/identicon';
import { getInitials } from '../../utils/layout';
import { LazyBoundary } from '../LazyBoundary';
import './BrandIcon.css';

/** Brands drawn as inline SVG, in `BrandMarks`. */
export type InlineBrandKey =
  | 'station'
  | 'claude'
  | 'codex'
  | 'pi'
  | 'kiro'
  | 'opencode';

type BrandKey = InlineBrandKey | 'muse' | 'cursor' | 'goose' | 'qwen';

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

/** Module-level: `LazyBoundary` shares one lazy component per loader. */
const loadBrandMarks = () => import('./BrandMarks');

/**
 * The mark is decorative, so a failed chunk (a stale tab after an upgrade)
 * leaves the tile's box without it instead of reaching an ancestor boundary
 * and replacing the dock or route that contains the icon. Later mounts
 * re-request the chunk; a browser that caches the failed import replays it
 * until reload.
 */
const noMark = () => null;

function Mark({ brand }: { brand: BrandKey }) {
  switch (brand) {
    case 'muse':
    case 'cursor':
    case 'goose':
    case 'qwen':
      return <img src={`/provider-icons/${brand}.svg`} alt="" />;
    default:
      // Until the chunk arrives the tile shows its sized, neutral box.
      return (
        <LazyBoundary
          load={loadBrandMarks}
          componentProps={{ brand }}
          pending={null}
          unavailable={noMark}
        />
      );
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
