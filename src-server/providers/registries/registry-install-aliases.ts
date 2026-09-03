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
  /** Optional until a registry is installed through the signed-package path. */
  supplyChain?: RegistrySupplyChainPinRecord;
}

export interface RegistryLastKnownGoodRef {
  version: 1;
  relativePath: string;
  installedDigest: string;
  packageVersion: string;
  source: string;
}

/** Exact package/source pin kept with the existing registry ownership record. */
export interface RegistrySupplyChainPinRecord {
  version: 1;
  packageSchema: { kind: 'station.plugin'; version: '1.0' };
  registryId: string;
  registryKey: string;
  pluginName: string;
  packageVersion: string;
  source: string;
  packageDigest: string;
  installedDigest: string;
  verification:
    | { kind: 'unsigned' }
    | { kind: 'ed25519'; keyId: string; signature: string };
  lastKnownGood?: RegistryLastKnownGoodRef;
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
        supplyChain?: unknown;
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
      if (
        alias.supplyChain !== undefined &&
        !isRegistrySupplyChainPinRecord(alias.supplyChain)
      ) {
        throw new RegistryInstallAliasFormatError(
          'Registry install aliases contain an invalid supply-chain pin. Reinstall the affected registry plugin to regenerate config/registry-installs.json.',
        );
      }
      return [
        id,
        {
          pluginName: alias.pluginName,
          registryKey: alias.registryKey,
          ...(alias.supplyChain
            ? { supplyChain: structuredClone(alias.supplyChain) }
            : {}),
        },
      ];
    }),
  ) as RegistryInstallAliases;
  return aliases;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function isLastKnownGoodRef(value: unknown): value is RegistryLastKnownGoodRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<RegistryLastKnownGoodRef>;
  return (
    record.version === 1 &&
    typeof record.relativePath === 'string' &&
    /^registry-last-known-good\/[a-f0-9]{64}\/tree$/.test(
      record.relativePath,
    ) &&
    typeof record.installedDigest === 'string' &&
    DIGEST.test(record.installedDigest) &&
    typeof record.packageVersion === 'string' &&
    SAFE_TEXT.test(record.packageVersion) &&
    typeof record.source === 'string' &&
    record.source.length > 0 &&
    record.source.length <= 2_048
  );
}

function isRegistrySupplyChainPinRecord(
  value: unknown,
): value is RegistrySupplyChainPinRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<RegistrySupplyChainPinRecord>;
  const verification = record.verification as
    | RegistrySupplyChainPinRecord['verification']
    | undefined;
  const verificationValid =
    verification?.kind === 'unsigned' ||
    (verification?.kind === 'ed25519' &&
      SAFE_TEXT.test(verification.keyId) &&
      typeof verification.signature === 'string' &&
      verification.signature.length > 0 &&
      verification.signature.length <= 512);
  return (
    record.version === 1 &&
    record.packageSchema?.kind === 'station.plugin' &&
    record.packageSchema.version === '1.0' &&
    typeof record.registryId === 'string' &&
    SAFE_TEXT.test(record.registryId) &&
    typeof record.registryKey === 'string' &&
    record.registryKey.length > 0 &&
    record.registryKey.length <= 2_048 &&
    typeof record.pluginName === 'string' &&
    SAFE_TEXT.test(record.pluginName) &&
    typeof record.packageVersion === 'string' &&
    SAFE_TEXT.test(record.packageVersion) &&
    typeof record.source === 'string' &&
    record.source.length > 0 &&
    record.source.length <= 2_048 &&
    typeof record.packageDigest === 'string' &&
    DIGEST.test(record.packageDigest) &&
    typeof record.installedDigest === 'string' &&
    DIGEST.test(record.installedDigest) &&
    verificationValid &&
    (record.lastKnownGood === undefined ||
      isLastKnownGoodRef(record.lastKnownGood))
  );
}
