import { isDeepStrictEqual } from 'node:util';
import {
  type ACPConnectionConfig,
  type ACPConnectionRegistryEntry,
  type ACPEngineSetupEntry,
  ACPStatus,
  installRecipeForPlatform,
} from '@kontourai/station-contracts/acp';
import {
  listValidatedACPRegistryEntries,
  namesSameExecutable,
} from './acp-engine-descriptors.js';
import type { getACPManagerStatus } from './acp-manager-view.js';

/** Project only setup facts; executable configuration stays with the human pane. */
export function engineSetupEntries(
  entries: readonly ACPConnectionRegistryEntry[],
  saved: readonly ACPConnectionConfig[],
  live: ReturnType<typeof getACPManagerStatus>['connections'],
): ACPEngineSetupEntry[] {
  const choices = new Map(entries.map((entry) => [entry.id, entry]));
  const ids = new Set([...choices.keys(), ...saved.map((entry) => entry.id)]);
  return [...ids].map((id) => {
    const entry = choices.get(id);
    const programs = entry
      ? saved.filter(
          (item) =>
            namesSameExecutable(item.command, entry.command) &&
            (!choices.has(item.id) || item.id === id),
        )
      : [];
    const exact = entry
      ? programs.filter((item) =>
          isDeepStrictEqual(item.args ?? [], entry.args ?? []),
        )
      : [];
    const variants = entry
      ? entries.filter(
          (item) =>
            item.source === 'core' &&
            namesSameExecutable(item.command, entry.command),
        ).length
      : 0;
    const related = exact.length ? exact : programs;
    const ambiguous = !exact.length && variants > 1 && programs.length > 0;
    const connection =
      saved.find((item) => item.id === id) ??
      (!ambiguous && related.length === 1 ? related[0] : undefined);
    const observed = live.find((item) => item.id === (connection?.id ?? id));
    const mismatch =
      entry &&
      connection &&
      !isDeepStrictEqual(entry.args ?? [], connection.args ?? []) &&
      observed?.capabilities?.mcpCapabilities?.http !== true;
    const configured = connection !== undefined;
    const enabled = connection?.enabled ?? true;
    const detected = entry?.detected ?? null;
    return {
      id,
      name: connection?.name ?? entry?.name ?? id,
      source: entry?.source === 'core' ? 'core' : entry ? 'plugin' : 'custom',
      detected,
      configured,
      enabled,
      status: observed?.status ?? 'not-connected',
      setupPath: connection
        ? `/connections/engines/${encodeURIComponent(connection.id)}`
        : ambiguous || related.length > 1
          ? '/connections/engines'
          : `/connections/engines/new/${encodeURIComponent(id)}`,
      connectionId: connection?.id ?? null,
      relatedConnectionIds: related.map((item) => item.id),
      handshakeObservedAt: observed?.handshakeObservedAt ?? null,
      httpTools: observed?.handshakeObservedAt
        ? observed.capabilities?.mcpCapabilities?.http === true
          ? 'advertised'
          : 'not-advertised'
        : 'unknown',
      nextAction: mismatch
        ? 'review-setup'
        : !connection && (ambiguous || related.length > 1)
          ? 'choose-existing'
          : configured
            ? !enabled
              ? 'enable'
              : observed?.status === ACPStatus.AVAILABLE
                ? 'inspect'
                : 'check'
            : detected === false
              ? 'install'
              : 'connect',
    };
  });
}

/** Installer identity is projected by the server, including custom saved aliases. */
export function engineInstallerFor(
  connection: Pick<ACPConnectionConfig, 'command'>,
) {
  const match = listValidatedACPRegistryEntries().find(
    (item) =>
      item.builtin &&
      namesSameExecutable(connection.command, item.entry.command) &&
      installRecipeForPlatform(item.entry.install, process.platform),
  );
  return match
    ? {
        installerId: match.entry.id,
        installerDetected: match.entry.detected === true,
      }
    : {};
}
