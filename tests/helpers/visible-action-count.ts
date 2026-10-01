import type { Page } from '@playwright/test';

/**
 * The RENDERED half of the two-action cap (#3045).
 *
 * `scripts/button-cap-ratchet.mjs` reads JSX and so cannot see a row built
 * from an array or from several components, a button hidden by CSS, or what a
 * header shows after it collapses at a narrow width. This counts what a page
 * actually shows: for each container matching `selector`, the visible
 * buttons that display a word.
 *
 * Counted: a `button` or `[role="button"]` with a non-empty box that is not
 * hidden, whose displayed text has two letters in a row. Not counted: an
 * icon-only button, a menu trigger (`aria-haspopup` of `true`, `menu` or
 * `listbox` — not `dialog`, not `false`), a choice (tab, menu
 * item, option, radio, switch, or anything pressed/selected/checked), and
 * anything inside a `role="menu"`/`listbox`/`tablist` — the same exemptions
 * the static scan makes, decided here from the live DOM.
 *
 * It reports; `actionRowsOverCap` is what a spec asserts on.
 */
export interface VisibleActionRow {
  /** `tag.firstClass` or `tag[aria-label]`, to name the row in a failure. */
  container: string;
  labels: string[];
}

export async function visibleLabelledActions(
  page: Page,
  selector = '[role="toolbar"], header, .action-row',
): Promise<VisibleActionRow[]> {
  return page.evaluate((containerSelector) => {
    const CHOICE_ROLES = new Set([
      'tab',
      'menuitem',
      'menuitemradio',
      'menuitemcheckbox',
      'option',
      'radio',
      'switch',
      'checkbox',
      'treeitem',
    ]);
    const isShown = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      const style = getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    /** Text a sighted user reads: shown text nodes, not hidden descendants. */
    const shownText = (element: Element): string => {
      let text = '';
      for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
        else if (node instanceof Element) {
          if (node.getAttribute('aria-hidden') === 'true') continue;
          const box = node.getBoundingClientRect();
          // Visually-hidden text is clipped to a pixel; `display: none` has
          // no box at all.
          if (box.width <= 1 || box.height <= 1) continue;
          if (getComputedStyle(node).visibility === 'hidden') continue;
          text += ` ${shownText(node)}`;
        }
      }
      return text.replaceAll(/\s+/g, ' ').trim();
    };
    const isAction = (button: Element) => {
      // A MENU trigger only — the same values the static scan accepts. A
      // button that opens a dialog is an ordinary action, and
      // `aria-haspopup="false"` opens nothing.
      if (
        ['', 'true', 'menu', 'listbox'].includes(
          button.getAttribute('aria-haspopup') ?? 'false',
        )
      ) {
        return false;
      }
      if (CHOICE_ROLES.has(button.getAttribute('role') ?? '')) return false;
      if (
        ['aria-pressed', 'aria-selected', 'aria-checked'].some((name) =>
          button.hasAttribute(name),
        )
      ) {
        return false;
      }
      return !button.closest(
        '[role="menu"], [role="listbox"], [role="tablist"], [role="radiogroup"]',
      );
    };
    const describe = (element: Element) => {
      const tag = element.tagName.toLowerCase();
      const firstClass = element.classList[0];
      if (firstClass) return `${tag}.${firstClass}`;
      const name = element.getAttribute('aria-label');
      return name ? `${tag}[${name}]` : tag;
    };

    const containers = [...document.querySelectorAll(containerSelector)];
    return containers.filter(isShown).map((container) => {
      const labels = [...container.querySelectorAll('button, [role="button"]')]
        // A button belongs to its NEAREST matching container, so a toolbar
        // inside a header is not counted twice.
        .filter((button) => button.closest(containerSelector) === container)
        .filter((button) => isShown(button) && isAction(button))
        .map(shownText)
        .filter((text) => /\p{L}{2}/u.test(text));
      return { container: describe(container), labels };
    });
  }, selector);
}

/** The rows showing more than `max` labelled actions — empty when conforming. */
export async function actionRowsOverCap(
  page: Page,
  options: { selector?: string; max?: number } = {},
): Promise<VisibleActionRow[]> {
  const rows = await visibleLabelledActions(page, options.selector);
  return rows.filter((row) => row.labels.length > (options.max ?? 2));
}
