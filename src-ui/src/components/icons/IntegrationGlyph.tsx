import { BrandIcon } from './BrandIcon';

interface IntegrationGlyphProps {
  /** Integration id — used as the initials-derivation fallback source when
   * `displayName` is absent (mirrors id/displayName precedence used
   * elsewhere in the integrations views). */
  id: string;
  displayName?: string;
  /** Manifest-declared icon (emoji/short string). Takes precedence over the
   * deterministic initials fallback when present. */
  icon?: string;
  iconUrl?: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Shared integration identity. Manifest glyphs and explicit local brand
 * tokens take precedence; a server-issued, same-origin raster URL may follow.
 * Untrusted URLs are never rendered, and every rejected/missing asset falls
 * back to a bundled provider mark or deterministic initials.
 */
export function IntegrationGlyph({
  id,
  displayName,
  icon,
  iconUrl,
  size = 24,
  className,
  style,
}: IntegrationGlyphProps) {
  return (
    <BrandIcon
      name={displayName || id}
      id={id}
      icon={icon}
      iconUrl={iconUrl}
      size={size}
      className={className}
      style={style}
    />
  );
}
