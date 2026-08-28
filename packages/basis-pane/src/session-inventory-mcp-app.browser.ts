import {
  SESSION_INVENTORY_CURRENT_GROUP_IDS,
  SESSION_INVENTORY_GROUP_IDS,
} from '@kontourai/station-contracts/session-inventory';
import {
  parseStationSessionInventoryMcpEnvelope,
  parseStationSessionInventoryMcpV2Envelope,
} from '@kontourai/station-contracts/session-inventory-mcp';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from '@modelcontextprotocol/ext-apps';
import { renderBasisPanel } from './basis-panel-dom';
import { renderSessionInventoryDom } from './session-inventory-dom';
import {
  buildSessionInventoryViewModel,
  mergeSessionInventoryGroupPages,
} from './session-inventory-view';

const root = document.querySelector<HTMLElement>('#session-inventory-app');
let app: App | null = null;
type Envelope =
  | NonNullable<ReturnType<typeof parseStationSessionInventoryMcpEnvelope>>
  | NonNullable<ReturnType<typeof parseStationSessionInventoryMcpV2Envelope>>;
let current: Envelope | null = null;
let density: 'compact' | 'full' = 'compact';
let groupId: any = 'inputs';
let capability: {
  occurrenceId: string;
  continuations: Map<string, string>;
} | null = null;

function readCapability(value: unknown, v2: boolean) {
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
      !(
        v2 ? SESSION_INVENTORY_CURRENT_GROUP_IDS : SESSION_INVENTORY_GROUP_IDS
      ).includes(item.groupId as any) ||
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

function parseEnvelope(value: unknown): Envelope | null {
  return (
    parseStationSessionInventoryMcpV2Envelope(value) ??
    parseStationSessionInventoryMcpEnvelope(value)
  );
}

function render() {
  if (!root) return;
  root.replaceChildren();
  if (current?.kind !== 'projection')
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
  renderSessionInventoryDom(inventory, model, (_action, url) => {
    // AppBridge owns navigation. There is no anchor, provider URL, or network
    // escape in this portable resource.
    void app?.openLink({ url });
  });
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
            ...(current.version === 'station.session-inventory-mcp/v2'
              ? { version: 'station.session-inventory-mcp/v2' }
              : {}),
            operation: 'page',
            scope: current.projection.scope,
            occurrenceId: capability.occurrenceId,
            groupId,
            continuationToken: token,
          },
        });
        const envelope = parseEnvelope(
          (result as { structuredContent?: unknown }).structuredContent,
        );
        const next = readCapability(
          (result as { _meta?: Record<string, unknown> })._meta?.[
            current.version === 'station.session-inventory-mcp/v2'
              ? 'station.session-inventory-app/v2'
              : 'station.session-inventory-app/v1'
          ],
          current.version === 'station.session-inventory-mcp/v2',
        );
        if (envelope?.kind !== 'group-page' || !next)
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
        } as Envelope;
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
    const envelope = parseEnvelope(
      (result as { structuredContent?: unknown }).structuredContent,
    );
    const v2 = envelope?.version === 'station.session-inventory-mcp/v2';
    const nextCapability = readCapability(
      (result as { _meta?: Record<string, unknown> })._meta?.[
        v2
          ? 'station.session-inventory-app/v2'
          : 'station.session-inventory-app/v1'
      ],
      v2,
    );
    // The envelope and its occurrence capability are one authorization unit.
    // Do not leave a read-only projection visible if host metadata is absent
    // or malformed, even when the model-visible envelope itself parses.
    current = envelope && nextCapability ? envelope : null;
    capability = envelope && nextCapability ? nextCapability : null;
    render();
  };
  try {
    await app.connect();
    appearance();
  } catch {
    render();
  }
})();
