import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import {
  AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
  isBoundedRegistryPackageVersion,
  type RegistryLastKnownGoodRef,
  type RegistrySupplyChainPinRecord,
} from '../../providers/registries/registry-install-aliases.js';
import {
  computePluginContentDigest,
  PLUGIN_TREE_COPY,
} from './plugin-content-integrity.js';

/*
 * This identifies the published manifest schema a claim targets. Manifest
 * validation remains the installer's responsibility once this tracer is wired.
 */
export { AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SOURCE_CHARS = 2_048;
const MAX_KEY_CHARS = 16 * 1_024;

export interface RegistryPackageSignature {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly value: string;
}

/** Claim issued by a registry for one immutable package source tree. */
export interface RegistryPackageClaim {
  readonly packageSchema: typeof AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL;
  readonly registryId: string;
  readonly registryKey: string;
  readonly pluginName: string;
  readonly packageVersion: string;
  readonly source: string;
  readonly packageDigest: string;
  readonly signature?: RegistryPackageSignature;
}

export interface RegistrySupplyChainPolicy {
  readonly signatures: 'optional' | 'required';
  readonly pins: 'exact';
  /** Trust anchors come from Station configuration, never the registry claim. */
  readonly trustedEd25519Keys: Readonly<Record<string, string>>;
}

export type RegistryPackageRefusalReason =
  | 'invalid-claim'
  | 'unsigned-package'
  | 'untrusted-signing-key'
  | 'signature-mismatch'
  | 'content-mismatch'
  | 'pin-mismatch';

export interface VerifiedRegistryPackage {
  readonly claim: RegistryPackageClaim;
  readonly verification: RegistrySupplyChainPinRecord['verification'];
  /** Existing installer must rebind grants before loading replacement code. */
  readonly invalidateExistingGrants: boolean;
}

export type RegistryPackageVerification =
  | { readonly kind: 'verified'; readonly package: VerifiedRegistryPackage }
  | {
      readonly kind: 'refused';
      readonly reason: RegistryPackageRefusalReason;
      readonly message: string;
    };

const CLAIM_KEYS = new Set([
  'packageSchema',
  'registryId',
  'registryKey',
  'pluginName',
  'packageVersion',
  'source',
  'packageDigest',
  'signature',
]);
const SIGNATURE_KEYS = new Set(['algorithm', 'keyId', 'value']);

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return (
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validClaim(claim: unknown): claim is RegistryPackageClaim {
  try {
    if (!claim || typeof claim !== 'object' || Array.isArray(claim))
      return false;
    const record = claim as Record<string, unknown>;
    if (!hasOnlyKeys(record, CLAIM_KEYS)) return false;
    const signature = record.signature;
    const signatureValid =
      signature === undefined ||
      (typeof signature === 'object' &&
        signature !== null &&
        !Array.isArray(signature) &&
        hasOnlyKeys(signature as Record<string, unknown>, SIGNATURE_KEYS) &&
        (signature as Record<string, unknown>).algorithm === 'ed25519' &&
        typeof (signature as Record<string, unknown>).keyId === 'string' &&
        SAFE_ID.test((signature as Record<string, unknown>).keyId as string) &&
        typeof (signature as Record<string, unknown>).value === 'string' &&
        ((signature as Record<string, unknown>).value as string).length > 0 &&
        ((signature as Record<string, unknown>).value as string).length <=
          512 &&
        SIGNATURE.test((signature as Record<string, unknown>).value as string));
    return (
      record.packageSchema === AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL &&
      typeof record.registryId === 'string' &&
      SAFE_ID.test(record.registryId) &&
      typeof record.registryKey === 'string' &&
      record.registryKey.length > 0 &&
      record.registryKey.length <= MAX_SOURCE_CHARS &&
      isCanonicalPluginId(record.pluginName) &&
      isBoundedRegistryPackageVersion(record.packageVersion) &&
      typeof record.source === 'string' &&
      record.source.length > 0 &&
      record.source.length <= MAX_SOURCE_CHARS &&
      typeof record.packageDigest === 'string' &&
      DIGEST.test(record.packageDigest) &&
      signatureValid
    );
  } catch {
    return false;
  }
}

/** Domain-separated canonical bytes signed by the registry's trusted key. */
export function registryPackageSignaturePayload(
  claim: Omit<RegistryPackageClaim, 'signature'>,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      'station.registry-package-signature/v1',
      claim.packageSchema,
      claim.registryId,
      claim.registryKey,
      claim.pluginName,
      claim.packageVersion,
      claim.source,
      claim.packageDigest,
    ]),
  );
}

function claimMatchesPin(
  claim: RegistryPackageClaim,
  pin: RegistrySupplyChainPinRecord,
): boolean {
  return (
    pin.packageSchema === claim.packageSchema &&
    pin.registryId === claim.registryId &&
    pin.registryKey === claim.registryKey &&
    pin.pluginName === claim.pluginName &&
    pin.packageVersion === claim.packageVersion &&
    pin.source === claim.source &&
    pin.packageDigest === claim.packageDigest
  );
}

export function verifyRegistryPackage(input: {
  readonly claim: RegistryPackageClaim;
  readonly observedPackageDigest: string;
  readonly policy: RegistrySupplyChainPolicy;
  readonly currentPin?: RegistrySupplyChainPinRecord;
  /** A separately authorized upgrade action, never inferred from availability. */
  readonly allowPinUpdate?: boolean;
}): RegistryPackageVerification {
  const { policy } = input;
  let claim: RegistryPackageClaim;
  try {
    claim = structuredClone(input.claim);
  } catch {
    return {
      kind: 'refused',
      reason: 'invalid-claim',
      message: 'Registry package claim is invalid.',
    };
  }
  if (
    !validClaim(claim) ||
    !DIGEST.test(input.observedPackageDigest) ||
    policy.pins !== 'exact' ||
    !['optional', 'required'].includes(policy.signatures)
  ) {
    return {
      kind: 'refused',
      reason: 'invalid-claim',
      message: 'Registry package claim is invalid.',
    };
  }
  if (input.currentPin && !claimMatchesPin(claim, input.currentPin)) {
    if (!input.allowPinUpdate) {
      return {
        kind: 'refused',
        reason: 'pin-mismatch',
        message:
          'Registry package version or source changed without an explicit local pin update.',
      };
    }
    if (
      input.currentPin.registryId !== claim.registryId ||
      input.currentPin.registryKey !== claim.registryKey ||
      input.currentPin.pluginName !== claim.pluginName
    ) {
      return {
        kind: 'refused',
        reason: 'pin-mismatch',
        message: 'Registry package ownership does not match the installed pin.',
      };
    }
  }

  let verification: RegistrySupplyChainPinRecord['verification'];
  if (!claim.signature) {
    if (policy.signatures === 'required') {
      return {
        kind: 'refused',
        reason: 'unsigned-package',
        message: 'Registry policy requires a signed package.',
      };
    }
    if (claim.packageDigest !== input.observedPackageDigest) {
      return {
        kind: 'refused',
        reason: 'content-mismatch',
        message: 'Registry package content does not match its declared digest.',
      };
    }
    verification = { kind: 'unsigned' };
  } else {
    const publicKey = policy.trustedEd25519Keys[claim.signature.keyId];
    if (
      typeof publicKey !== 'string' ||
      publicKey.length === 0 ||
      publicKey.length > MAX_KEY_CHARS
    ) {
      return {
        kind: 'refused',
        reason: 'untrusted-signing-key',
        message: 'Registry package signing key is not trusted by local policy.',
      };
    }
    let signatureValid = false;
    try {
      signatureValid = verify(
        null,
        registryPackageSignaturePayload(claim),
        createPublicKey(publicKey),
        Buffer.from(claim.signature.value, 'base64'),
      );
    } catch {
      signatureValid = false;
    }
    if (
      !signatureValid ||
      claim.packageDigest !== input.observedPackageDigest
    ) {
      return {
        kind: 'refused',
        reason: 'signature-mismatch',
        message:
          'Registry package signature mismatch: signed metadata or package bytes changed.',
      };
    }
    verification = {
      kind: 'ed25519',
      keyId: claim.signature.keyId,
      signature: claim.signature.value,
    };
  }

  return {
    kind: 'verified',
    package: {
      claim,
      verification,
      invalidateExistingGrants: Boolean(
        input.currentPin && !claimMatchesPin(claim, input.currentPin),
      ),
    },
  };
}

export function finalizeRegistrySupplyChainPin(input: {
  readonly verifiedPackage: VerifiedRegistryPackage;
  readonly installedDigest: string;
  readonly lastKnownGood?: RegistryLastKnownGoodRef;
}): RegistrySupplyChainPinRecord {
  if (!DIGEST.test(input.installedDigest)) {
    throw new Error('Installed registry package digest is invalid.');
  }
  const claim = input.verifiedPackage.claim;
  return {
    version: 1,
    packageSchema: AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
    registryId: claim.registryId,
    registryKey: claim.registryKey,
    pluginName: claim.pluginName,
    packageVersion: claim.packageVersion,
    source: claim.source,
    packageDigest: claim.packageDigest,
    installedDigest: input.installedDigest,
    verification: structuredClone(input.verifiedPackage.verification),
    ...(input.lastKnownGood
      ? { lastKnownGood: structuredClone(input.lastKnownGood) }
      : {}),
  };
}

function assertRealDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

function digestTree(path: string): string | null {
  return computePluginContentDigest(dirname(path), basename(path));
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function contained(
  root: string,
  candidate: string,
  allowRoot: boolean,
): boolean {
  const relation = relative(root, candidate);
  return (
    (allowRoot || relation !== '') &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

function assertContained(root: string, candidate: string): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (!contained(rootPath, candidatePath, false)) {
    throw new Error('Registry last-known-good path escapes its root.');
  }
  let existingAncestor = candidatePath;
  while (!entryExists(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error('Registry last-known-good path escapes its root.');
    }
    existingAncestor = parent;
  }
  const realRoot = realpathSync(rootPath);
  const realAncestor = realpathSync(existingAncestor);
  if (!contained(realRoot, realAncestor, true)) {
    throw new Error('Registry last-known-good path escapes its root.');
  }
}

/**
 * Holds one prior tree per registry ownership identity. It never writes the
 * live plugin directory; rollback staging must re-enter the existing installer.
 */
export class RegistryLastKnownGoodStore {
  readonly #root: string;
  readonly #home: string;

  constructor(projectHomeDir: string) {
    this.#home = resolve(projectHomeDir);
    this.#root = join(this.#home, 'registry-last-known-good');
    if (existsSync(this.#root)) assertRealDirectory(this.#root, 'LKG root');
    else mkdirSync(this.#root, { recursive: true, mode: 0o700 });
  }

  archive(input: {
    readonly registryId: string;
    readonly registryKey: string;
    readonly pluginName: string;
    readonly packageVersion: string;
    readonly source: string;
    readonly installedTree: string;
    readonly expectedInstalledDigest: string;
  }): RegistryLastKnownGoodRef {
    if (
      !SAFE_ID.test(input.registryId) ||
      !isCanonicalPluginId(input.pluginName) ||
      !isBoundedRegistryPackageVersion(input.packageVersion) ||
      !DIGEST.test(input.expectedInstalledDigest) ||
      input.registryKey.length === 0 ||
      input.registryKey.length > MAX_SOURCE_CHARS ||
      input.source.length === 0 ||
      input.source.length > MAX_SOURCE_CHARS
    ) {
      throw new Error('Invalid registry last-known-good identity.');
    }
    assertRealDirectory(input.installedTree, 'Installed plugin tree');
    if (digestTree(input.installedTree) !== input.expectedInstalledDigest) {
      throw new Error(
        'Installed plugin tree does not match its pinned digest.',
      );
    }
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          'station.registry-lkg/v1',
          input.registryId,
          input.registryKey,
          input.pluginName,
        ]),
      )
      .digest('hex');
    const relativePath = `registry-last-known-good/${identity}/tree`;
    const ownerRoot = join(this.#root, identity);
    const target = join(ownerRoot, 'tree');
    const stage = join(this.#root, `.stage-${identity}-${randomUUID()}`);
    assertContained(this.#root, target);
    assertContained(this.#root, stage);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    try {
      const stagedTree = join(stage, 'tree');
      cpSync(input.installedTree, stagedTree, PLUGIN_TREE_COPY);
      if (digestTree(stagedTree) !== input.expectedInstalledDigest) {
        throw new Error('Last-known-good copy is not byte-identical.');
      }
      const previous = join(
        this.#root,
        `.previous-${identity}-${randomUUID()}`,
      );
      if (existsSync(ownerRoot)) renameSync(ownerRoot, previous);
      try {
        renameSync(stage, ownerRoot);
        rmSync(previous, { recursive: true, force: true });
      } catch (error) {
        if (existsSync(previous) && !existsSync(ownerRoot)) {
          renameSync(previous, ownerRoot);
        }
        throw error;
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    return {
      version: 1,
      relativePath,
      installedDigest: input.expectedInstalledDigest,
      packageVersion: input.packageVersion,
      source: input.source,
    };
  }

  /** Produces a verified source tree for the existing install transaction. */
  stageRollback(ref: RegistryLastKnownGoodRef, destination: string): string {
    if (
      ref.version !== 1 ||
      !/^registry-last-known-good\/[a-f0-9]{64}\/tree$/.test(
        ref.relativePath,
      ) ||
      !DIGEST.test(ref.installedDigest) ||
      entryExists(destination)
    ) {
      throw new Error('Invalid registry rollback request.');
    }
    const source = join(dirname(this.#root), ref.relativePath);
    assertContained(this.#root, source);
    assertContained(this.#home, destination);
    assertRealDirectory(source, 'Last-known-good tree');
    if (digestTree(source) !== ref.installedDigest) {
      throw new Error(
        'Last-known-good tree no longer matches its pinned digest.',
      );
    }
    try {
      cpSync(source, destination, PLUGIN_TREE_COPY);
      if (digestTree(destination) !== ref.installedDigest) {
        throw new Error('Staged rollback tree is not byte-identical.');
      }
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    return destination;
  }
}
