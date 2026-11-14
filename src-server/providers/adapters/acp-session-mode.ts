import { isKnownFullAccessAcpModeId } from '@kontourai/station-contracts/acp';
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

// #2569, #4518: the known full-access mode ids live in the contract so the
// approval picker and the routes classify a mode the same way.
export { isKnownFullAccessAcpModeId };

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
function isFullAccessAcpMode(
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

/**
 * The config option that sets a session's reasoning effort: ACP's
 * `category: "thought_level"`, else an option id an engine is known to use
 * for it. Kiro's agent service carried effort as `effortLevel` (kirocrew
 * agent_sdk/backends_turns.py, KAS 0.66.43). On kiro-cli 3.3.0 v3 with model
 * `auto` there is neither (live, 2026-11-13: the model list's `_meta.kiro`
 * names per-model `effortLevels` but no option sets one), so effort is
 * refused there rather than dropped.
 */
const DECLARED_EFFORT_OPTION_IDS: readonly string[] = ['effortLevel'];

export interface AcpEffortConfigOption {
  id: string;
  currentValue?: string;
  values: string[];
}

export function findAcpEffortConfigOption(
  configOptions: unknown,
): AcpEffortConfigOption | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const read = (option: Record<string, unknown>): AcpEffortConfigOption => ({
    id: option.id as string,
    ...(typeof option.currentValue === 'string'
      ? { currentValue: option.currentValue }
      : {}),
    values: Array.isArray(option.options)
      ? option.options.flatMap((entry) =>
          typeof entry === 'string'
            ? [entry]
            : entry &&
                typeof entry === 'object' &&
                typeof (entry as { value?: unknown }).value === 'string'
              ? [(entry as { value: string }).value]
              : [],
        )
      : [],
  });
  const usable = configOptions.filter(
    (option): option is Record<string, unknown> =>
      !!option &&
      typeof option === 'object' &&
      typeof (option as { id?: unknown }).id === 'string' &&
      !!(option as { id: string }).id.trim(),
  );
  const byCategory = usable.find(
    (option) => option.category === 'thought_level',
  );
  if (byCategory) return read(byCategory);
  const byId = usable.find((option) =>
    DECLARED_EFFORT_OPTION_IDS.includes(option.id as string),
  );
  return byId ? read(byId) : undefined;
}

export function requestedAcpEffort(
  modelOptions?: Record<string, unknown>,
): string | undefined {
  const value = modelOptions?.effort;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Apply `effort` through the session's effort option and read the answer
 * back. Throws, naming the connection, when the session has no such option,
 * the option does not list the value, or the engine reports another value.
 */
export async function applyAcpEffort(
  process: Pick<AcpModeProcess, 'setConfigOption'>,
  configOptions: unknown,
  effort: string,
  connectionId: string,
): Promise<{ configOptions?: unknown[] }> {
  const option = findAcpEffortConfigOption(configOptions);
  if (!option)
    throw new Error(
      `ACP effort option unavailable: connection '${connectionId}' did not advertise a reasoning-effort configuration option for this session.`,
    );
  if (option.values.length > 0 && !option.values.includes(effort))
    throw new Error(
      `ACP effort value unsupported: connection '${connectionId}' did not advertise '${effort}' for this session.`,
    );
  if (option.currentValue === effort) return {};
  const response = await process.setConfigOption(option.id, effort);
  const next =
    response &&
    typeof response === 'object' &&
    Array.isArray((response as { configOptions?: unknown }).configOptions)
      ? (response as { configOptions: unknown[] }).configOptions
      : undefined;
  const applied = findAcpEffortConfigOption(next);
  if (applied?.currentValue !== effort)
    throw new Error(
      `ACP effort application unverified: connection '${connectionId}' reported '${applied?.currentValue ?? 'no current value'}' after '${effort}' was requested.`,
    );
  return { configOptions: next };
}
