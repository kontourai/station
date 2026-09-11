export type AdvertisedAcpMode = {
  id: string;
  name: string;
  description?: string;
};

type AcpModeOption = {
  value?: string;
  id?: string;
  name?: string;
  description?: string;
};

type AcpModeConnection = {
  modes?: string[];
  configOptions?: Array<{
    category?: string;
    currentValue?: string;
    options?: Array<string | AcpModeOption>;
  }>;
};

function selectOptions(
  raw: Array<string | AcpModeOption> | undefined,
): AdvertisedAcpMode[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) {
      return [{ id: entry, name: entry }];
    }
    if (!entry || typeof entry !== 'object') return [];
    const id =
      typeof entry.value === 'string'
        ? entry.value
        : typeof entry.id === 'string'
          ? entry.id
          : '';
    if (!id.trim()) return [];
    return [
      {
        id,
        name:
          typeof entry.name === 'string' && entry.name.trim() ? entry.name : id,
        ...(typeof entry.description === 'string' && entry.description.trim()
          ? { description: entry.description }
          : {}),
      },
    ];
  });
}

/**
 * Composer catalog for an ACP connection (station#1945). Prefers
 * `configOptions` with `category: "mode"` per the ACP spec.
 */
export function advertisedAcpSessionModesFromConnection(
  connection?: AcpModeConnection | null,
): { currentModeId?: string; modes: AdvertisedAcpMode[] } {
  const modeOption = connection?.configOptions?.find(
    (option) => option.category === 'mode',
  );
  if (modeOption) {
    const modes = selectOptions(modeOption.options);
    return {
      modes,
      ...(typeof modeOption.currentValue === 'string'
        ? { currentModeId: modeOption.currentValue }
        : {}),
    };
  }
  const ids = connection?.modes?.filter((id) => id.trim()) ?? [];
  return {
    modes: ids.map((id) => ({ id, name: id })),
  };
}
