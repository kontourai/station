import { projectIconProblem } from '@kontourai/station-contracts/project';
import { BrandIcon } from './BrandIcon';
import './ProjectIcon.css';

/**
 * The project's icon as the user chose it, or `undefined` when there is none
 * to show. A stored value the contracts rule refuses (a legacy remote URL, a
 * path) is treated as no icon: the renderer never shows what the routes
 * would not store.
 */
export function displayableProjectIcon(
  icon: string | undefined | null,
): string | undefined {
  if (!icon) return undefined;
  return projectIconProblem(icon) ? undefined : icon;
}

interface ProjectIconProps {
  project: { name: string; icon?: string };
  /** Edge length of the icon, in px. */
  size: number;
  /**
   * The project's colour (`useProjectAccents`). Drawn only when the project
   * has no icon, as the swatch the surface already used for identity.
   */
  accent?: string;
  /**
   * What stands in for a missing icon:
   * - `dot` (default): the accent as a round swatch, `size / 2` across.
   * - `bar`: the accent as a 3px bar, most of `size` tall.
   * - `initials`: a neutral initials tile, used by workspace map rows and
   *   page headers.
   * - `none`: nothing, for a surface that draws the accent itself.
   */
  fallback?: 'dot' | 'bar' | 'initials' | 'none';
  /** Applied to whichever mark renders: the icon or the swatch. */
  className?: string;
  /** Applied to the colour swatch only, for a surface that styles it. */
  swatchClassName?: string;
  /**
   * Set ONLY where no text beside the icon names the project. Without it the
   * icon is `aria-hidden`: a row that says "Station" next to the mark must not
   * announce the project twice.
   */
  label?: string;
}

/**
 * A project's identity mark, the way `AgentIcon` is an agent's: the chosen
 * icon rendered through `BrandIcon` (glyph or same-origin image, never a
 * remote hotlink), else the surface's chosen fallback.
 */
export function ProjectIcon({
  project,
  size,
  accent,
  fallback = 'dot',
  className,
  swatchClassName,
  label,
}: ProjectIconProps) {
  const icon = displayableProjectIcon(project.icon);
  const classes = (...names: Array<string | undefined | false>) =>
    names.filter(Boolean).join(' ');
  const a11y = label
    ? ({ role: 'img', 'aria-label': label } as const)
    : ({ 'aria-hidden': true } as const);

  if (icon || fallback === 'initials') {
    return (
      <BrandIcon
        name={project.name}
        icon={icon}
        allowSafeImageIcon
        size={size}
        alt={label}
        className={classes(
          'project-icon',
          icon ? 'project-icon--icon' : 'project-icon--initials',
          className,
        )}
      />
    );
  }
  if (fallback === 'none' || !accent) return null;
  const swatch =
    fallback === 'bar'
      ? { width: 3, height: Math.round(size * 0.78) }
      : { width: Math.round(size / 2), height: Math.round(size / 2) };
  return (
    <span
      className={classes(
        'project-icon',
        `project-icon--${fallback}`,
        className,
        swatchClassName,
      )}
      title={project.name}
      data-project-icon={fallback}
      style={{ ...swatch, backgroundColor: accent }}
      {...a11y}
    />
  );
}
