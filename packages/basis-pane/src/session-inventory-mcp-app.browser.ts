import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { parseStationSessionInventoryMcpEnvelope } from '@kontourai/station-contracts/session-inventory-mcp';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import { buildSessionInventoryCompactViewModel } from './session-inventory-view';
import { renderBasisPanel } from './basis-panel-dom';
import { renderSessionInventoryDom } from './session-inventory-dom';

const root = document.querySelector<HTMLElement>('#session-inventory-app');
let app: App | null = null;
let current: ReturnType<typeof parseStationSessionInventoryMcpEnvelope> = null;

function render() {
  if (!root) return;
  root.replaceChildren();
  if (!current || current.kind !== 'projection')
    return root.append('Session inventory is unavailable.');
  const model = buildSessionInventoryCompactViewModel(current.projection, {
    scope: current.projection.scope,
    groupId: 'inputs',
  });
  const inventory = document.createElement('section');
  renderSessionInventoryDom(inventory, model);
  root.append(inventory);
  if (current.projection.scope.kind === 'current-answer') {
    const basis = document.createElement('section');
    renderBasisPanel(
      basis,
      // The inventory projection already captured Basis; never read an owner again.
      buildBasisPanelViewModel(current.projection.basis),
    );
    root.append(basis);
  }
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
