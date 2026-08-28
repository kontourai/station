import type { SessionInventoryViewModel } from './session-inventory-view';

/** Inert portable rendering of an already-derived inventory view model. */
export function renderSessionInventoryDom(
  root: HTMLElement,
  model: SessionInventoryViewModel,
): void {
  root.replaceChildren();
  const heading = document.createElement('h1');
  heading.textContent = model.scopeLabel;
  root.append(heading);
  // Selection is the disclosure boundary in both densities. Full expands the
  // selected owner's currently loaded rows; compact keeps its bounded preview.
  const visible = model.groups.filter((group) => group.selected);
  for (const group of visible) {
    const section = document.createElement('section');
    section.dataset.groupId = group.id;
    const title = document.createElement('h2');
    title.tabIndex = -1;
    title.textContent = `${group.label}${group.count ? ` (${group.count})` : ''}`;
    const state = document.createElement('p');
    state.setAttribute('role', 'status');
    state.textContent = group.stateCopy || 'Available.';
    const gaps = document.createElement('ul');
    gaps.setAttribute('aria-label', `${group.label} gaps`);
    for (const gap of group.gaps) {
      const row = document.createElement('li');
      const text = document.createElement('bdi');
      text.textContent = gap;
      row.append(text);
      gaps.append(row);
    }
    const list = document.createElement('ul');
    const items =
      model.density === 'compact' ? group.items.slice(0, 2) : group.items;
    for (const item of items) {
      const row = document.createElement('li');
      const text = document.createElement('bdi');
      text.textContent = `${item.label} — ${item.relation}; ${
        item.classification === 'kept' ? 'Kept context' : 'Current context'
      }`;
      row.append(text);
      list.append(row);
    }
    section.append(title, state, gaps, list);
    root.append(section);
  }
}
