import { forwardRef, useEffect, useRef, useState } from 'react';
import { nextTabIndex } from '../utils/tab-navigation';
// Self-imported rather than left to each host to remember: archive#3306 was
// exactly this failure mode (a direct navigation rendered `.page__tabs`
// unstyled because the host forgot this stylesheet). The primitive owning
// its own required CSS makes that class of bug structurally impossible for
// every future adopter.
import '../views/page-layout.css';

/**
* The shared TRUE-tab primitive (archive#4463). Reserved
 * for hosts switching between panels in one composite widget — real
 * `role="tablist"`/`role="tab"`/`aria-selected`, a documented tabpanel
 * contract via `tabElementId`/`tabPanelElementId`, and WAI-ARIA APG's
 * automatic-vs-manual activation choice made explicit per host.
 *
 * Settings/ProjectSettings/Knowledge are NOT hosted here — those are
 * scroll-spy navigation to deep-linkable URL sections, not a tab widget, and
 * live in `components/SectionNav.tsx` instead (real `<a>` + `aria-current`,
 * no roving tabindex). The review that split this in two found real
 * defects in treating both jobs as one component: an anchor masquerading as
 * `role="tab"` lost the links-rotor and landmark a screen reader depends on,
 * and automatic arrow-key activation on a route-changing host pushed a
 * history entry (and stole focus) on every arrow press.
 *
 * `items` is the entire surface of what can render inside the strip — there
 * is deliberately no `children` slot, so a host can never smuggle a
 * non-tab node into the tablist row.
 */
export interface TabItem {
/** Stable identity — what `activeKey` compares against and `onSelect` receives. */
  key: string;
  label: string;
/** A count badge inside the tab (Connections' per-section counts). */
  count?: number;
/** A "needs attention" status dot after the label (Connections' warn dots). */
  attention?: boolean;
}

export type TabActivation = 'automatic' | 'manual';

export interface TabsProps {
/**
* Stable identity for this tablist, used as the prefix for every
* generated tab/panel id (see `tabElementId`/`tabPanelElementId`). Two
* `Tabs` instances on the same page must use different `id`s.
*/
  id: string;
  items: readonly TabItem[];
  activeKey: string;
  onSelect: (key: string) => void;
/** Required — every tablist needs an accessible name distinguishing it from other tablists on the page. */
  'aria-label': string;
/** Extra class(es) merged onto the `.page__tabs` strip, for a host's own layout hooks. */
  className?: string;
/** Pins the strip to the top of its scroll container while content scrolls under it (Registry's catalog). */
  sticky?: boolean;
/**
* WAI-ARIA APG's automatic-vs-manual tab activation choice — no default,
* every host must pick deliberately:
* - `'automatic'`: arrow-key movement activates the tab immediately.
*   Correct when switching is a cheap in-place re-render (Guidance,
*   Registry, Memory's knowledge-root switcher).
* - `'manual'`: arrow-key movement only moves DOM focus (roving
*   tabindex tracks the FOCUSED tab, not the active one); Enter or Space
*   activates the focused tab. Required whenever `onSelect` has a
*   side-effect heavier than local state — specifically a route change
*   (`navigate(...)`, Connections and Developer) — because automatic
*   activation there was pushing one history entry per arrow-key press
*   and yanking focus out of the strip on every navigation.
*/
  activation: TabActivation;
}

/** The tab element's DOM id — pair with `aria-labelledby` on the panel. */
export function tabElementId(groupId: string, key: string): string {
  return `tab-${groupId}-${key}`;
}

/**
 * The tabpanel's DOM id — a host renders `role="tabpanel" id={tabPanelElementId(...)}
 * aria-labelledby={tabElementId(...)}` around the active tab's body content.
 * See `workspace-panes/WorkspacePaneHostTabs.tsx` next door for the
 * in-repo reference of this exact contract (`role="tabpanel"` +
 * `aria-labelledby`, `hidden` on inactive panels it keeps mounted).
 */
export function tabPanelElementId(groupId: string, key: string): string {
  return `tabpanel-${groupId}-${key}`;
}

function tabClassName(selected: boolean): string {
  return selected ? 'page__tab page__tab--active' : 'page__tab';
}

export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
  {
    id,
    items,
    activeKey,
    onSelect,
    'aria-label': ariaLabel,
    className,
    sticky,
    activation,
  },
  forwardedRef,
) {
  const elementByKey = useRef(new Map<string, HTMLElement>());
// Manual activation needs a roving-tabindex target independent of the
// active tab (arrow keys move focus without activating). Kept in sync
// with `activeKey` so a host-driven selection change (e.g. a deep link)
// starts the next arrow-key journey from the newly active tab, per APG.
  const [focusedKey, setFocusedKey] = useState(activeKey);
  useEffect(() => {
    setFocusedKey(activeKey);
  }, [activeKey]);
  const rovingKey = activation === 'manual' ? focusedKey : activeKey;

  const stripClassName = [
    'page__tabs',
    'tab-strip--scroll',
    sticky ? 'page__tabs--sticky' : null,
    className ?? null,
  ]
    .filter(Boolean)
    .join(' ');

  const handleKeyDown = (index: number) => (event: React.KeyboardEvent) => {
    if (
      activation === 'manual' &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      onSelect(items[index].key);
      return;
    }
    const next = nextTabIndex(index, items.length, event.key);
    if (next === null) return;
    event.preventDefault();
    const target = items[next];
    if (activation === 'automatic') {
      onSelect(target.key);
    } else {
      setFocusedKey(target.key);
    }
    elementByKey.current.get(target.key)?.focus();
  };

  const setRef = (key: string) => (element: HTMLButtonElement | null) => {
    if (element) elementByKey.current.set(key, element);
    else elementByKey.current.delete(key);
  };

  return (
    <div
      ref={forwardedRef}
      className={stripClassName}
      role="tablist"
      aria-label={ariaLabel}
    >
      {items.map((item, index) => {
        const selected = item.key === activeKey;
// Leading space kept for `accessibleName` below (plain string
// concatenation, unaffected by CSS) — NOT relied on for the
// rendered gap: `.page__tab` is `display: inline-flex`, and
// flexbox trims a flex item's own leading whitespace at the start
// of its line box, so this span's leading space renders as nothing
// ("Models0" instead of "Models 0" — visible/accessible-name
// divergence, archive#4463). The
// visual gap instead comes from `page-layout.css`'s
// `.page__tab-count` rule (`margin-left`), which the span below
// carries.
        const countText = item.count !== undefined ? ` ${item.count}` : '';
// A `role="status"` nested inside a `role="tab"` button is not
// reliably exposed as its own accessible object by assistive tech —
// interactive widget roles generally flatten/prune nested
// landmark-ish descendants when computing the tab's own accessible
// name (review MED — the previous nested-status implementation
// tested green in jsdom, which does not model that pruning, while
// lying about what a real AT announces). The visible dot stays for
// sighted users (`aria-hidden`); the attention text instead joins
// the tab's own accessible name, mirroring the exact pattern
// `CodingInspectorPanel.tsx` already uses. (Cited by component name
// only: this file has no Coding dependency, and the full path token
// anchors coding-composition-inventory-gate's semantic scan, which
// would then demand an inventory entry nothing derives.)
        const accessibleName = item.attention
          ? `${item.label}${countText}, needs attention`
          : undefined;
        return (
          <button
            key={item.key}
            ref={setRef(item.key)}
            type="button"
            role="tab"
            id={tabElementId(id, item.key)}
// Only the selected tab points at a panel: the documented
// contract is that hosts render the ACTIVE panel only, so an
// aria-controls on an unselected tab is an IDREF guaranteed to
// dangle — an asserted relationship nothing derives.
            aria-controls={
              selected ? tabPanelElementId(id, item.key) : undefined
            }
            aria-selected={selected}
            aria-label={accessibleName}
            tabIndex={item.key === rovingKey ? 0 : -1}
            className={tabClassName(selected)}
            onClick={() => onSelect(item.key)}
            onKeyDown={handleKeyDown(index)}
          >
            {item.label}
            {item.count !== undefined && (
              <span className="page__tab-count">{countText}</span>
            )}
            {item.attention ? <span aria-hidden="true"> •</span> : null}
          </button>
        );
      })}
    </div>
  );
});
