import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import type {
  RegistryLastKnownGoodRef,
  RegistrySupplyChainPinRecord,
} from '../../providers/registries/registry-install-aliases.js';
import {
  computePluginContentDigest,
  PLUGIN_TREE_COPY,
} from './plugin-content-integrity.js';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SOURCE_CHARS = 2_048;
const MAX_KEY_CHARS = 16 * 1_024;

export const STATION_PLUGIN_PACKAGE_SCHEMA = Object.freeze({
  kind: 'station.plugin' as const,
  version: '1.0' as const,
});

export interface RegistryPackageSignature {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly value: string;
}

/** Claim issued by a registry for one immutable package source tree. */
export interface RegistryPackageClaim {
  readonly packageSchema: typeof STATION_PLUGIN_PACKAGE_SCHEMA;
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

function validClaim(claim: RegistryPackageClaim): boolean {
  return (
    claim.packageSchema?.kind === STATION_PLUGIN_PACKAGE_SCHEMA.kind &&
    claim.packageSchema.version === STATION_PLUGIN_PACKAGE_SCHEMA.version &&
    SAFE_ID.test(claim.registryId) &&
    claim.registryKey.length > 0 &&
    claim.registryKey.length <= MAX_SOURCE_CHARS &&
    isCanonicalPluginId(claim.pluginName) &&
    SAFE_ID.test(claim.packageVersion) &&
    claim.source.length > 0 &&
    claim.source.length <= MAX_SOURCE_CHARS &&
    DIGEST.test(claim.packageDigest) &&
    (claim.signature === undefined ||
      (claim.signature.algorithm === 'ed25519' &&
        SAFE_ID.test(claim.signature.keyId) &&
        claim.signature.value.length > 0 &&
        claim.signature.value.length <= 512 &&
        SIGNATURE.test(claim.signature.value)))
  );
}

/** Domain-separated canonical bytes signed by the registry's trusted key. */
export function registryPackageSignaturePayload(
  claim: Omit<RegistryPackageClaim, 'signature'>,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      'station.registry-package-signature/v1',
      claim.packageSchema.kind,
      claim.packageSchema.version,
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
    pin.packageSchema.kind === claim.packageSchema.kind &&
    pin.packageSchema.version === claim.packageSchema.version &&
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
  const { claim, policy } = input;
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
      claim: structuredClone(claim),
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
    packageSchema: STATION_PLUGIN_PACKAGE_SCHEMA,
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

function assertContained(root: string, candidate: string): void {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  if (!candidatePath.startsWith(`${rootPath}${sep}`)) {
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
    this.#root = join(projectHomeDir, 'registry-last-known-good');
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
      !SAFE_ID.test(input.packageVersion) ||
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
      existsSync(destination)
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
