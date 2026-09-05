import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
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
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
  type RegistryPackageClaim,
} from '@kontourai/station-contracts/registry-trust';
import { parseAgentPluginManifest } from '@kontourai/station-shared/agent-plugin-manifest';
import { registryPackageSignaturePayload } from '@kontourai/station-shared/plugin-registry-signature';
import { computePluginTreeDigest } from '@kontourai/station-shared/plugin-tree-digest';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const usage =
  'Usage: tsx prepare.ts --package SNAPSHOT --source HTTPS_GIT_URL#REF --registry HTTPS_CATALOG_URL --key-id LABEL --private-key FILE --out NEW_DIRECTORY [--id REGISTRY_ENTRY_ID]';

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  );
}

function boundedFile(path: string, limit: number, label: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Invalid file');
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > limit) throw new Error('File grew beyond its limit');
    return bytes.subarray(0, offset);
  } catch {
    throw new Error(
      `${label} must be a readable regular file within its size limit.`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function publicUrl(value: string, source: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Source and registry locators must be public HTTPS URLs.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    value.length > 2048
  ) {
    throw new Error(
      'This example requires HTTPS locators without credentials or query parameters.',
    );
  }
  if (
    source ? !url.pathname.endsWith('.git') || !url.hash : Boolean(url.hash)
  ) {
    throw new Error(
      'Use a Git source URL ending in .git#REF and a registry URL without a fragment.',
    );
  }
  return url.href;
}

export interface PrepareOptions {
  package: string;
  source: string;
  registry: string;
  keyId: string;
  privateKey: string;
  out: string;
  id?: string;
}

/** Authoring only: no Station home, network request, install or trust-policy write. */
export function prepareSignedPackage(options: PrepareOptions) {
  const root = realpathSync(options.package);
  if (!lstatSync(root).isDirectory())
    throw new Error('Package snapshot must be a directory.');
  const requestedOutput = resolve(options.out);
  // Resolve existing parents so a symlink cannot make an apparently external
  // output or key path refer into the package being signed.
  const output = join(
    realpathSync(dirname(requestedOutput)),
    basename(requestedOutput),
  );
  const keyPath = realpathSync(options.privateKey);
  if (inside(root, output) || inside(root, keyPath)) {
    throw new Error(
      'The private key and output directory must be outside the signed package.',
    );
  }
  if (!ID.test(options.keyId)) throw new Error('Signing-key label is invalid.');
  const source = publicUrl(options.source, true);
  const registryKey = publicUrl(options.registry, false);
  const manifestBytes = boundedFile(
    join(root, 'plugin.json'),
    1024 * 1024,
    'plugin.json',
  );
  const reports: Array<{ level: string; code: string }> = [];
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('plugin.json must contain valid JSON.');
  }
  const parsed = parseAgentPluginManifest(rawManifest, (report) =>
    reports.push(report),
  );
  if (
    !parsed ||
    reports.some(
      (report) =>
        report.level === 'error' || report.code === 'station-extension-invalid',
    )
  ) {
    throw new Error(
      'Portable manifest or Station namespace validation failed.',
    );
  }
  const { manifest, stationExtension } = parsed;
  if (
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0 ||
    manifest.version.length > 256 ||
    Array.from(manifest.version).some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('Signed packages need an explicit, bounded version.');
  }
  const registryId = options.id ?? manifest.name;
  if (!ID.test(registryId)) throw new Error('Registry entry ID is invalid.');
  const packageDigest = computePluginTreeDigest(root);
  if (!packageDigest) throw new Error('Package tree could not be observed.');
  const claim: RegistryPackageClaim = {
    packageSchema: AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
    registryId,
    registryKey,
    pluginName: manifest.name,
    packageVersion: manifest.version,
    source,
    packageDigest,
  };
  const keyBytes = boundedFile(keyPath, 16 * 1024, 'Private key');
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(keyBytes);
    if (privateKey.asymmetricKeyType !== 'ed25519')
      throw new Error('Wrong algorithm');
  } catch {
    throw new Error('An unencrypted Ed25519 private-key PEM is required.');
  } finally {
    keyBytes.fill(0);
  }
  const publicKey = createPublicKey(privateKey);
  const signed: RegistryPackageClaim = {
    ...claim,
    signature: {
      algorithm: 'ed25519',
      keyId: options.keyId,
      value: sign(
        null,
        registryPackageSignaturePayload(claim),
        privateKey,
      ).toString('base64'),
    },
  };
  if (
    computePluginTreeDigest(root) !== packageDigest ||
    !boundedFile(join(root, 'plugin.json'), 1024 * 1024, 'plugin.json').equals(
      manifestBytes,
    )
  ) {
    throw new Error(
      'Package changed during signing; use a frozen source snapshot.',
    );
  }
  const catalog = {
    version: 1,
    plugins: [
      {
        id: registryId,
        displayName: stationExtension?.title ?? manifest.name,
        description: manifest.description ?? '',
        version: manifest.version,
        source,
        type: 'plugin',
        claim: signed,
      },
    ],
  };
  // Refuse existing destinations and files. Partial output after an I/O failure
  // is left inspectable; a retry must use another new directory.
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(
    join(output, 'catalog.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 },
  );
  writeFileSync(
    join(output, 'signer-public-key.pem'),
    publicKey.export({ format: 'pem', type: 'spki' }),
    { flag: 'wx', mode: 0o644 },
  );
  return {
    output,
    packageDigest,
    publicKeyFingerprint:
      'sha256:' +
      createHash('sha256')
        .update(publicKey.export({ format: 'der', type: 'spki' }))
        .digest('hex'),
    manifestWarnings: reports.length,
  };
}

export function main(args = process.argv.slice(2)): void {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      options: {
        package: { type: 'string' },
        source: { type: 'string' },
        registry: { type: 'string' },
        'key-id': { type: 'string' },
        'private-key': { type: 'string' },
        out: { type: 'string' },
        id: { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch {
    throw new Error(usage);
  }
  if (values.help) {
    console.log(usage);
    return;
  }
  for (const key of [
    'package',
    'source',
    'registry',
    'key-id',
    'private-key',
    'out',
  ]) {
    if (typeof values[key] !== 'string' || !values[key]) throw new Error(usage);
  }
  const result = prepareSignedPackage({
    package: values.package as string,
    source: values.source as string,
    registry: values.registry as string,
    keyId: values['key-id'] as string,
    privateKey: values['private-key'] as string,
    out: values.out as string,
    ...(typeof values.id === 'string' ? { id: values.id } : {}),
  });
  console.log(JSON.stringify(result));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Could not prepare the signed catalog.',
    );
    process.exitCode = 1;
  }
}
