import { normalizeToolName } from '../../utils/tool-name-normalizer.js';

/** Probe receipts carry the server prefix; protocol calls use the original name. */
export function originalMcpToolName(
  serverId: string,
  recordedName: string,
): string {
  const prefix = `${serverId}_`;
  return recordedName.startsWith(prefix)
    ? recordedName.slice(prefix.length)
    : recordedName;
}

export function mcpToolIdentities(serverId: string, name: string): string[] {
  const qualified = `${serverId}_${name}`;
  return [name, qualified, normalizeToolName(qualified)];
}

export function mcpToolDisabled(
  serverId: string,
  name: string,
  disabled: readonly string[] = [],
): boolean {
  return mcpToolIdentities(serverId, name).some((identity) =>
    disabled.includes(identity),
  );
}

export function selectedMcpTools(
  serverId: string,
  names: readonly string[],
  available: readonly string[],
  serverIds: readonly string[],
): string[] | undefined {
  if (
    available.includes('*') ||
    available.includes(`${serverId}_*`) ||
    available.includes(`${serverId}/*`)
  )
    return undefined;
  const selected = new Set<string>();
  for (const entry of available) {
    if (entry.endsWith('_*') || entry.endsWith('/*')) {
      const prefix = entry.slice(0, -2);
      for (const name of names) {
        if (
          mcpToolIdentities(serverId, name).some(
            (identity) =>
              identity.startsWith(`${prefix}_`) ||
              identity.startsWith(`${prefix}/`),
          )
        )
          selected.add(name);
      }
      continue;
    }
    const qualified = names.filter((name) => `${serverId}_${name}` === entry);
    const normalized = qualified.length
      ? qualified
      : names.filter(
          (name) => normalizeToolName(`${serverId}_${name}`) === entry,
        );
    if (normalized.length) {
      for (const name of normalized) selected.add(name);
    } else if (entry.startsWith(`${serverId}_`))
      selected.add(entry.slice(serverId.length + 1));
    else if (
      !entry.includes('*') &&
      !serverIds.some(
        (id) => entry.startsWith(`${id}_`) || entry.startsWith(`${id}/`),
      )
    )
      selected.add(entry);
  }
  return [...selected];
}

export function canonicalDisabledMcpTools(
  serverId: string,
  names: readonly string[],
  disabled: readonly string[] = [],
): string[] {
  const unknown = disabled.filter(
    (entry) => !names.some((name) => mcpToolDisabled(serverId, name, [entry])),
  );
  return [
    ...new Set([
      ...unknown,
      ...names
        .filter((name) => mcpToolDisabled(serverId, name, disabled))
        .map((name) => normalizeToolName(`${serverId}_${name}`)),
    ]),
  ];
}
