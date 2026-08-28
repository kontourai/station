import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { parseStationSessionInventoryMcpEnvelope } from '@kontourai/station-contracts/session-inventory-mcp';
import { SESSION_INVENTORY_GROUP_IDS } from '@kontourai/station-contracts/session-inventory';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import {
  buildSessionInventoryViewModel,
  mergeSessionInventoryGroupPages,
} from './session-inventory-view';
import { renderBasisPanel } from './basis-panel-dom';
import { renderSessionInventoryDom } from './session-inventory-dom';

const root = document.querySelector<HTMLElement>('#session-inventory-app');
let app: App | null = null;
let current: ReturnType<typeof parseStationSessionInventoryMcpEnvelope> = null;
let density: 'compact' | 'full' = 'compact';
let groupId: any = 'inputs';
let capability: {
  occurrenceId: string;
  continuations: Map<string, string>;
} | null = null;

function readCapability(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.occurrenceId !== 'string' ||
    !/^[A-Za-z0-9_-]{24,128}$/.test(record.occurrenceId) ||
    !Array.isArray(record.continuations)
  )
    return null;
  const continuations = new Map<string, string>();
  for (const entry of record.continuations) {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.groupId !== 'string' ||
      !SESSION_INVENTORY_GROUP_IDS.includes(item.groupId as any) ||
      typeof item.continuationToken !== 'string' ||
      item.continuationToken.length < 16 ||
      item.continuationToken.length > 1024 ||
      continuations.has(item.groupId)
    )
      return null;
    continuations.set(item.groupId, item.continuationToken);
  }
  return { occurrenceId: record.occurrenceId, continuations };
}

function render() {
  if (!root) return;
  root.replaceChildren();
  if (!current || current.kind !== 'projection')
    return root.append('Session inventory is unavailable.');
  const model = buildSessionInventoryViewModel(
    current.projection,
    {
      scope: current.projection.scope,
      groupId,
    },
    density,
  );
  const inventory = document.createElement('section');
  renderSessionInventoryDom(inventory, model);
  root.append(inventory);
  const controls = document.createElement('section');
  controls.setAttribute('aria-label', 'Inventory controls');
  for (const nextDensity of ['compact', 'full'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = nextDensity;
    button.setAttribute('aria-pressed', String(density === nextDensity));
    button.addEventListener('click', () => {
      density = nextDensity;
      render();
    });
    controls.append(button);
  }
  for (const group of model.groups) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = group.label;
    button.dataset.groupId = group.id;
    button.setAttribute('aria-pressed', String(group.id === groupId));
    button.addEventListener('click', () => {
      groupId = group.id;
      render();
    });
    controls.append(button);
  }
  const token = capability?.continuations.get(String(groupId));
  if (token) {
    const more = document.createElement('button');
    more.type = 'button';
    more.textContent = 'Load more';
    more.addEventListener('click', async () => {
      if (!app || !current || current.kind !== 'projection' || !capability)
        return;
      more.disabled = true;
      try {
        const result = await app.callServerTool({
          name: 'get_session_inventory',
          arguments: {
            operation: 'page',
            scope: current.projection.scope,
            occurrenceId: capability.occurrenceId,
            groupId,
            continuationToken: token,
          },
        });
        const envelope = parseStationSessionInventoryMcpEnvelope(
          (result as { structuredContent?: unknown }).structuredContent,
        );
        const next = readCapability(
          (result as { _meta?: Record<string, unknown> })._meta?.[
            'station.session-inventory-app/v1'
          ],
        );
        if (!envelope || envelope.kind !== 'group-page' || !next)
          throw new Error('unavailable');
        const merged = mergeSessionInventoryGroupPages(
          current.projection,
          [envelope.page],
          current.projection.scope,
        );
        if (!merged) throw new Error('unavailable');
        current = {
          version: current.version,
          kind: 'projection',
          projection: merged,
        };
        capability = next;
        render();
        root
          .querySelector<HTMLElement>(`section[data-group-id="${groupId}"] h2`)
          ?.focus();
      } catch {
        current = null;
        capability = null;
        render();
      }
    });
    controls.append(more);
  }
  root.append(controls);
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
    capability = readCapability(
      (result as { _meta?: Record<string, unknown> })._meta?.[
        'station.session-inventory-app/v1'
      ],
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
