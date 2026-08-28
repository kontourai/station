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
  for (const group of model.groups) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.textContent = `${group.label}${group.count ? ` (${group.count})` : ''}`;
    const state = document.createElement('p');
    state.setAttribute('role', 'status');
    state.textContent = group.stateCopy || 'Available.';
    const list = document.createElement('ul');
    for (const item of group.items) {
      const row = document.createElement('li');
      const text = document.createElement('bdi');
      text.textContent = `${item.label} — ${item.relation}`;
      row.append(text);
      list.append(row);
    }
    section.append(title, state, list);
    root.append(section);
  }
}
