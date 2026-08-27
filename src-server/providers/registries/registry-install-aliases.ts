import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface RegistryInstallAlias {
  pluginName: string;
  registryKey: string;
}

export type RegistryInstallAliases = Record<string, RegistryInstallAlias>;

export class RegistryInstallAliasFormatError extends Error {
  readonly code = 'REGISTRY_INSTALL_ALIASES_REGENERATION_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'RegistryInstallAliasFormatError';
  }
}

function aliasesPath(projectHomeDir: string): string {
  return join(projectHomeDir, 'config', 'registry-installs.json');
}

export function writeRegistryInstallAliases(
  projectHomeDir: string,
  aliases: RegistryInstallAliases,
): void {
  const target = aliasesPath(projectHomeDir);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(aliases, null, 2)}\n`);
  renameSync(temporary, target);
}

export function readRegistryInstallAliases(
  projectHomeDir: string,
): RegistryInstallAliases {
  const target = aliasesPath(projectHomeDir);
  if (!existsSync(target)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf-8'));
  } catch {
    throw new RegistryInstallAliasFormatError(
      'Registry install aliases could not be parsed. Reinstall the affected registry plugins to regenerate config/registry-installs.json.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RegistryInstallAliasFormatError(
      'Registry install aliases must be an object of registry id to plugin name. Reinstall the affected registry plugins to regenerate config/registry-installs.json.',
    );
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  const aliases = Object.fromEntries(
    entries.map(([id, value]) => {
      const alias = value as {
        pluginName?: unknown;
        registryKey?: unknown;
      } | null;
      if (
        !alias ||
        typeof alias !== 'object' ||
        typeof alias.pluginName !== 'string' ||
        typeof alias.registryKey !== 'string'
      ) {
        throw new RegistryInstallAliasFormatError(
          'Registry install aliases do not preserve registry ownership. Reinstall the affected registry plugins to regenerate config/registry-installs.json.',
        );
      }
      return [
        id,
        { pluginName: alias.pluginName, registryKey: alias.registryKey },
      ];
    }),
  ) as RegistryInstallAliases;
  return aliases;
}
