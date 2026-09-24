/**
 * ACP advertised session modes (station#1945).
 *
 * The spec prefers `configOptions` with `category: "mode"` over the older
 * `modes` / `session/set_mode` API, which is scheduled for removal.
 * Ids and labels are whatever the agent advertised — not Station ask/auto/never.
 */

export type AdvertisedAcpMode = {
  id: string;
  name: string;
  description?: string;
};

export type AdvertisedAcpModeCatalog = {
  currentModeId?: string;
  modes: AdvertisedAcpMode[];
  /**
   * #2569: ids of advertised modes the agent itself declared as full access
   * (`_meta.kind: "full_access"`, as claude-code-acp does). Kept apart from
   * `modes`, which is reported to clients as advertised.
   */
  fullAccessModeIds?: string[];
  /** Present when the engine advertised a config option with category "mode". */
  configOptionId?: string;
};

type AcpModeProcess = {
  setConfigOption(configId: string, value: string): Promise<unknown>;
  setMode(modeId: string): Promise<void>;
};

/**
 * #2569: advertised mode ids known to skip the agent's own permission
 * prompts. ACP's `SessionMode` carries no semantics of its own, so this is an
 * explicit list of what real agents advertise, checked against their source:
 *
 * - `bypassPermissions`: claude-code-acp (`src/session-mode.ts`, "Accepts all
 *   permissions"; it also declares `_meta.kind: "full_access"`).
 * - `full-access`: codex-acp (`src/thread.rs`, the no-sandbox
 *   `PermissionProfile::Disabled` preset).
 * - `yolo`: gemini-cli (`packages/cli/src/acp/acpUtils.ts`, "Auto-approves
 *   all tools").
 *
 * Deliberately not guessed from other names; an agent that declares
 * `_meta.kind: "full_access"` on a mode is classified by that instead.
 */
export const KNOWN_FULL_ACCESS_ACP_MODE_IDS: readonly string[] = [
  'bypassPermissions',
  'full-access',
  'yolo',
];

/** Whether `value` names a mode on the known full-access list. */
export function isKnownFullAccessAcpModeId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    KNOWN_FULL_ACCESS_ACP_MODE_IDS.includes(value.trim())
  );
}

function declaresFullAccess(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const meta = (entry as { _meta?: unknown })._meta;
  return (
    !!meta &&
    typeof meta === 'object' &&
    (meta as { kind?: unknown }).kind === 'full_access'
  );
}

function modeIdOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const record = entry as Record<string, unknown>;
  const id =
    typeof record.value === 'string'
      ? record.value
      : typeof record.id === 'string'
        ? record.id
        : undefined;
  return id?.trim() ? id : undefined;
}

function declaredFullAccessIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const id = modeIdOf(entry);
    return id && declaresFullAccess(entry) ? [id] : [];
  });
}

/** Whether selecting `modeId` in this catalog skips the agent's prompts. */
export function isFullAccessAcpMode(
  catalog: AdvertisedAcpModeCatalog,
  modeId: string,
): boolean {
  return (
    isKnownFullAccessAcpModeId(modeId) ||
    (catalog.fullAccessModeIds ?? []).includes(modeId)
  );
}

/**
 * #2569: the requested mode this session may apply. A full-access mode is
 * the ACP equivalent of approval `never`, so only a `host` session applies
 * it; anything else keeps the connection's current mode.
 */
export function permittedAcpSessionMode(
  catalog: AdvertisedAcpModeCatalog,
  requestedModeId: string | undefined,
  confinement: 'host' | 'workspace' | undefined,
): string | undefined {
  if (!requestedModeId) return undefined;
  // A mode the agent did not advertise is returned as asked, so it is
  // refused as unsupported rather than silently dropped.
  const advertised = catalog.modes.some((mode) => mode.id === requestedModeId);
  return advertised &&
    confinement !== 'host' &&
    isFullAccessAcpMode(catalog, requestedModeId)
    ? undefined
    : requestedModeId;
}

function selectOptions(raw: unknown): AdvertisedAcpMode[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) {
      return [{ id: entry, name: entry }];
    }
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const id =
      typeof record.value === 'string'
        ? record.value
        : typeof record.id === 'string'
          ? record.id
          : '';
    if (!id.trim()) return [];
    return [
      {
        id,
        name:
          typeof record.name === 'string' && record.name.trim()
            ? record.name
            : id,
        ...(typeof record.description === 'string' && record.description.trim()
          ? { description: record.description }
          : {}),
      },
    ];
  });
}

function findModeConfigOption(configOptions: unknown):
  | {
      id: string;
      currentValue?: string;
      options: AdvertisedAcpMode[];
      fullAccessModeIds: string[];
    }
  | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const option of configOptions) {
    if (!option || typeof option !== 'object') continue;
    const candidate = option as Record<string, unknown>;
    if (
      candidate.category !== 'mode' ||
      typeof candidate.id !== 'string' ||
      !candidate.id.trim()
    ) {
      continue;
    }
    const options = selectOptions(candidate.options);
    if (options.length === 0) continue;
    return {
      id: candidate.id,
      fullAccessModeIds: declaredFullAccessIds(candidate.options),
      ...(typeof candidate.currentValue === 'string'
        ? { currentValue: candidate.currentValue }
        : {}),
      options,
    };
  }
  return undefined;
}

export function advertisedAcpSessionModes(input: {
  configOptions?: unknown;
  modes?: {
    availableModes?: Array<{
      id?: unknown;
      name?: unknown;
      description?: unknown;
    }>;
    currentModeId?: unknown;
  };
}): AdvertisedAcpModeCatalog {
  const fromConfig = findModeConfigOption(input.configOptions);
  if (fromConfig) {
    return {
      modes: fromConfig.options,
      configOptionId: fromConfig.id,
      ...(fromConfig.fullAccessModeIds.length > 0
        ? { fullAccessModeIds: fromConfig.fullAccessModeIds }
        : {}),
      ...(fromConfig.currentValue
        ? { currentModeId: fromConfig.currentValue }
        : {}),
    };
  }
  const available = Array.isArray(input.modes?.availableModes)
    ? input.modes.availableModes.flatMap((mode) => {
        if (!mode || typeof mode.id !== 'string' || !mode.id.trim()) return [];
        return [
          {
            id: mode.id,
            name:
              typeof mode.name === 'string' && mode.name.trim()
                ? mode.name
                : mode.id,
            ...(typeof mode.description === 'string' && mode.description.trim()
              ? { description: mode.description }
              : {}),
          },
        ];
      })
    : [];
  const declared = declaredFullAccessIds(input.modes?.availableModes);
  return {
    modes: available,
    ...(declared.length > 0 ? { fullAccessModeIds: declared } : {}),
    ...(typeof input.modes?.currentModeId === 'string' &&
    input.modes.currentModeId.trim()
      ? { currentModeId: input.modes.currentModeId }
      : {}),
  };
}

export function requestedAcpSessionMode(
  modelOptions?: Record<string, unknown>,
): string | undefined {
  const value = modelOptions?.mode;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function applyAdvertisedAcpSessionMode(
  process: AcpModeProcess,
  catalog: AdvertisedAcpModeCatalog,
  requestedModeId: string,
  connectionId: string,
): Promise<{ currentModeId: string; configOptions?: unknown[] }> {
  if (!catalog.modes.some((mode) => mode.id === requestedModeId)) {
    throw new Error(
      `ACP mode value unsupported: connection '${connectionId}' did not advertise '${requestedModeId}' for this session.`,
    );
  }
  if (catalog.currentModeId === requestedModeId) {
    return { currentModeId: requestedModeId };
  }
  if (catalog.configOptionId) {
    const response = await process.setConfigOption(
      catalog.configOptionId,
      requestedModeId,
    );
    const nextOptions =
      response &&
      typeof response === 'object' &&
      Array.isArray((response as { configOptions?: unknown }).configOptions)
        ? (response as { configOptions: unknown[] }).configOptions
        : undefined;
    const applied = advertisedAcpSessionModes({ configOptions: nextOptions });
    if (applied.currentModeId !== requestedModeId) {
      throw new Error(
        `ACP mode application unverified: connection '${connectionId}' reported '${applied.currentModeId ?? 'no current value'}' after '${requestedModeId}' was requested.`,
      );
    }
    return {
      currentModeId: requestedModeId,
      ...(nextOptions ? { configOptions: nextOptions } : {}),
    };
  }
  await process.setMode(requestedModeId);
  return { currentModeId: requestedModeId };
}
