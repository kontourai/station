import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { parseStationSessionInventoryMcpEnvelope } from '@kontourai/station-contracts/session-inventory-mcp';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import { buildSessionInventoryCompactViewModel } from './session-inventory-view';
import { renderBasisPanel } from './basis-panel-dom';

const root = document.querySelector<HTMLElement>('#session-inventory-app');
let app: App | null = null;
let current: ReturnType<typeof parseStationSessionInventoryMcpEnvelope> = null;

function render() {
  if (!root) return;
  root.replaceChildren();
  if (!current) return root.append('Session inventory is unavailable.');
  const model = buildSessionInventoryCompactViewModel(current.projection, {
    scope: current.projection.scope,
    groupId: 'inputs',
  });
  const heading = document.createElement('h1');
  heading.textContent = model.scopeLabel;
  root.append(heading);
  if (current.projection.scope.kind === 'current-answer') {
    const basis = document.createElement('section');
    renderBasisPanel(
      basis,
      // The inventory projection already captured Basis; never read an owner again.
      buildBasisPanelViewModel(current.projection.basis),
    );
    root.append(basis);
  }
  const groups = document.createElement('section');
  groups.setAttribute('aria-label', 'Session inventory groups');
  for (const group of model.groups) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.textContent = `${group.label}${group.count ? ` (${group.count})` : ''}`;
    section.append(title);
    const state = document.createElement('p');
    state.setAttribute('role', 'status');
    state.textContent = group.stateCopy || 'Available.';
    section.append(state);
    const list = document.createElement('ul');
    for (const item of group.items) {
      const row = document.createElement('li');
      const text = document.createElement('bdi');
      text.textContent = `${item.label} — ${item.relation}`;
      row.append(text);
      list.append(row);
    }
    section.append(list);
    groups.append(section);
  }
  root.append(groups);
}

function appearance() {
  const context = app?.getHostContext();
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
}

void (async () => {
  app = new App(
    { name: 'Station Session inventory', version: '1.0.0' },
    {},
    { autoResize: true, strict: true },
  );
  app.onhostcontextchanged = appearance;
  app.ontoolresult = (result) => {
    current = parseStationSessionInventoryMcpEnvelope(
      (result as { structuredContent?: unknown }).structuredContent,
    );
    render();
  };
  try {
    await app.connect();
    appearance();
  } catch {
    render();
  }
})();
