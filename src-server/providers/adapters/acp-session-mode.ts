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
  /** Present when the engine advertised a config option with category "mode". */
  configOptionId?: string;
};

type AcpModeProcess = {
  setConfigOption(configId: string, value: string): Promise<unknown>;
  setMode(modeId: string): Promise<void>;
};

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
  return {
    modes: available,
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
