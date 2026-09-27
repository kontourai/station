import { SETTINGS_CATALOG } from '../../views/settings/settings-catalog';

/**
 * The catalog ids a Settings view should render for one host, derived from
 * each entry's `conditional` alone. It is the completeness oracle: kept apart
 * from the view's own filtering so the rendered set is checked against an
 * independent answer rather than against itself.
 */
export function visibleCatalogIds(options: {
  isMobile: boolean;
  isDesktop: boolean;
  /** Absent reads as "not the operator" — the fail-closed direction (#2067). */
  isOperator?: boolean;
}) {
  return SETTINGS_CATALOG.filter((entry) => {
    if (entry.conditional === 'mobile') return options.isMobile;
    if (entry.conditional === 'desktop') return options.isDesktop;
    if (entry.conditional === 'operator') return options.isOperator === true;
    return true;
  }).map((entry) => entry.id);
}
