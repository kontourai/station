import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isSafeToolServerCredentialKey,
  isSafeToolServerId,
} from '@kontourai/station-contracts/tool';
import { fsyncDirectorySync } from './fs-windows-compat.js';
import { acquireFileMutationLockAsync } from './lifecycle-events.js';

/**
 * Credentials used by outbound MCP tool servers. This is deliberately not the
 * peer store: peer credentials have environment/origin/scope semantics and a
 * different lifecycle. Sharing its document would couple unrelated trust
 * domains and make tool-server deletion/rotation capable of damaging peers.
 * The filesystem posture is intentionally identical to PeerCredentialStore.
 */
type Document = {
  schemaVersion: 2;
  credentials: Record<string, Record<string, string>>;
};

/** OAuth material shares a server bucket with environment credentials. */
export const TOOL_SERVER_OAUTH_CREDENTIAL_KEYS = [
  'oauth.tokens',
  'oauth.client-information',
  'oauth.pkce-verifier',
  'oauth.state',
  'oauth.discovery',
] as const;
const TOOL_SERVER_OAUTH_CREDENTIAL_KEY_SET = new Set<string>(
  TOOL_SERVER_OAUTH_CREDENTIAL_KEYS,
);
function assertCredentialKey(value: string, label: 'server id' | 'env name') {
  const safe =
    label === 'server id'
      ? isSafeToolServerId(value)
      : isSafeToolServerCredentialKey(value);
  if (!safe)
    throw new Error(
      `Invalid tool-server credential ${label}: ${JSON.stringify(value)}`,
    );
}
function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const FILE = 'tool-server-credentials.json';
/**
 * #3279: credentials owned by a person rather than the Station instance live
 * in their own document. Instance buckets keep their exact pre-#3279 file and
 * keys, so an older reader, portability export, and every existing operator
 * path see the shared document unchanged and never mistake a person's token
 * for the instance's.
 */
const PRINCIPAL_FILE = 'tool-server-principal-credentials.json';

export type ToolServerCredentialStoreScope = 'instance' | 'principal';

/** The non-instance owner shapes a person-owned bucket can name. */
export type ToolServerPrincipalCredentialOwner =
  | { kind: 'principal'; principalId: string }
  | { kind: 'principal-project'; principalId: string; projectSlug: string };

const PRINCIPAL_BUCKET_DIGEST = /^[0-9a-f]{32}$/;

/**
 * #3279: a person's bucket in the principal document. It joins a digest of
 * the whole owner tuple to the server id, so two owners never share a bucket
 * and every bucket of one server can be found (and removed) without storing a
 * readable principal id beside the token.
 */
export function principalToolServerCredentialBucket(
  serverId: string,
  owner: ToolServerPrincipalCredentialOwner,
): string {
  assertCredentialKey(serverId, 'server id');
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'tool-server-credential-owner/v1',
        owner.kind,
        owner.principalId,
        owner.kind === 'principal-project' ? owner.projectSlug : null,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  return `${digest}.${serverId}`;
}

export function isPrincipalToolServerCredentialBucketFor(
  bucketId: string,
  serverId: string,
): boolean {
  return (
    bucketId.length === serverId.length + 33 &&
    bucketId[32] === '.' &&
    bucketId.slice(33) === serverId &&
    PRINCIPAL_BUCKET_DIGEST.test(bucketId.slice(0, 32))
  );
}

/** Removes every person's credentials for one server; a no-op without a document. */
export async function removePrincipalToolServerCredentials(
  homeDir: string,
  serverId: string,
): Promise<void> {
  assertCredentialKey(serverId, 'server id');
  if (!existsSync(join(homeDir, 'security', PRINCIPAL_FILE))) return;
  const store = new ToolServerCredentialStore(homeDir, 'principal');
  if (
    !store
      .bucketIds()
      .some((id) => isPrincipalToolServerCredentialBucketFor(id, serverId))
  )
    return;
  await store.removeServers((id) =>
    isPrincipalToolServerCredentialBucketFor(id, serverId),
  );
}

export function toolServerIntegrationMutationLockPath(
  homeDir: string,
  serverId: string,
): string {
  assertCredentialKey(serverId, 'server id');
  return join(homeDir, 'integrations', `.${serverId}.integration.mutation`);
}

export function toolServerCredentialStoreMutationLockPath(
  homeDir: string,
  scope: ToolServerCredentialStoreScope = 'instance',
): string {
  return join(
    homeDir,
    'security',
    `${scope === 'principal' ? PRINCIPAL_FILE : FILE}.mutation`,
  );
}

function validate(value: unknown): Document {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid tool-server credential store');
  const input = value as Partial<Document>;
  if (
    input.schemaVersion !== 2 ||
    !input.credentials ||
    typeof input.credentials !== 'object' ||
    Array.isArray(input.credentials)
  )
    throw new Error('Invalid tool-server credential store schema');
  const credentials = dictionary<Record<string, string>>();
  for (const [serverId, serverCredentials] of Object.entries(
    input.credentials,
  )) {
    if (
      serverId.length === 0 ||
      !serverCredentials ||
      typeof serverCredentials !== 'object' ||
      Array.isArray(serverCredentials)
    )
      throw new Error('Invalid tool-server credential record');
    assertCredentialKey(serverId, 'server id');
    credentials[serverId] = dictionary<string>();
    for (const [name, secret] of Object.entries(serverCredentials)) {
      if (
        name.length === 0 ||
        typeof secret !== 'string' ||
        secret.length < 1 ||
        secret.length > 65536
      )
        throw new Error('Invalid tool-server credential record');
      assertCredentialKey(name, 'env name');
      credentials[serverId][name] = secret;
    }
  }
  return { schemaVersion: 2, credentials };
}

export class ToolServerCredentialStore {
  readonly #directory: string;
  readonly #file: string;
  readonly #scope: ToolServerCredentialStoreScope;
  constructor(
    homeDir: string,
    scope: ToolServerCredentialStoreScope = 'instance',
  ) {
    this.#scope = scope;
    this.#directory = join(homeDir, 'security');
    this.#file = join(
      this.#directory,
      scope === 'principal' ? PRINCIPAL_FILE : FILE,
    );
    mkdirSync(this.#directory, { recursive: true, mode: DIRECTORY_MODE });
    const directory = lstatSync(this.#directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
    )
      throw new Error('Unsafe tool-server credential directory');
    if (existsSync(this.#file)) this.#read();
  }
  get scope(): ToolServerCredentialStoreScope {
    return this.#scope;
  }
  get(serverId: string, name: string): string {
    assertCredentialKey(serverId, 'server id');
    assertCredentialKey(name, 'env name');
    const value = this.#read().credentials[serverId]?.[name];
    if (value === undefined)
      throw new Error('Tool-server credential is missing');
    return value;
  }
  async upsert(serverId: string, name: string, secret: string): Promise<void> {
    assertCredentialKey(serverId, 'server id');
    assertCredentialKey(name, 'env name');
    if (
      serverId.length === 0 ||
      name.length === 0 ||
      typeof secret !== 'string' ||
      secret.length < 1 ||
      secret.length > 65536
    )
      throw new Error('Invalid tool-server credential');
    await this.#mutate((document) => {
      const credentials = Object.assign(
        dictionary<Record<string, string>>(),
        document.credentials,
      );
      const serverCredentials = Object.assign(
        dictionary<string>(),
        document.credentials[serverId],
      );
      serverCredentials[name] = secret;
      credentials[serverId] = serverCredentials;
      return { ...document, credentials };
    });
  }
  async remove(serverId: string, name: string): Promise<void> {
    await this.removeMany(serverId, [name]);
  }
  /**
   * Remove one logical migration batch with one credential-store publication.
   * A failed write therefore leaves every legacy value intact instead of
   * turning a multi-env migration into an unrecoverable partial cleanup.
   */
  async removeMany(serverId: string, names: readonly string[]): Promise<void> {
    assertCredentialKey(serverId, 'server id');
    for (const name of names) assertCredentialKey(name, 'env name');
    const removed = new Set(names);
    await this.#mutate((document) => {
      const credentials = Object.assign(
        dictionary<Record<string, string>>(),
        document.credentials,
      );
      const serverCredentials = Object.assign(
        dictionary<string>(),
        credentials[serverId],
      );
      for (const name of removed) delete serverCredentials[name];
      if (Object.keys(serverCredentials).length > 0)
        credentials[serverId] = serverCredentials;
      else delete credentials[serverId];
      return { ...document, credentials };
    });
  }
  async removeServer(serverId: string): Promise<void> {
    assertCredentialKey(serverId, 'server id');
    await this.#mutate((document) => {
      const credentials = Object.assign(
        dictionary<Record<string, string>>(),
        document.credentials,
      );
      delete credentials[serverId];
      return { ...document, credentials };
    });
  }
  /** Bucket ids currently present; names only, never values. */
  bucketIds(): string[] {
    return Object.keys(this.#read().credentials);
  }
  /** Remove every matching bucket in one publication. */
  async removeServers(matches: (bucketId: string) => boolean): Promise<void> {
    await this.#mutate((document) => {
      const credentials = dictionary<Record<string, string>>();
      for (const [bucketId, bucket] of Object.entries(document.credentials))
        if (!matches(bucketId)) credentials[bucketId] = bucket;
      return { ...document, credentials };
    });
  }
  async reconcileServer(
    serverId: string,
    referencedNames: readonly string[],
    removedNames: readonly string[] = [],
  ): Promise<void> {
    assertCredentialKey(serverId, 'server id');
    for (const name of referencedNames) assertCredentialKey(name, 'env name');
    for (const name of removedNames) assertCredentialKey(name, 'env name');
    await this.#mutate((document) => {
      const credentials = Object.assign(
        dictionary<Record<string, string>>(),
        document.credentials,
      );
      const names = new Set(referencedNames);
      const current = credentials[serverId];
      if (current) {
        for (const name of removedNames) delete current[name];
      }
      const retained = dictionary<string>();
      for (const [name, secret] of Object.entries(credentials[serverId] ?? {}))
        if (names.has(name) || TOOL_SERVER_OAUTH_CREDENTIAL_KEY_SET.has(name))
          retained[name] = secret;
      if (Object.keys(retained).length > 0) credentials[serverId] = retained;
      else delete credentials[serverId];
      return { ...document, credentials };
    });
  }
  #read(): Document {
    if (!existsSync(this.#file))
      return { schemaVersion: 2, credentials: dictionary() };
    const status = lstatSync(this.#file);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      (process.platform !== 'win32' && (status.mode & 0o777) !== FILE_MODE)
    )
      throw new Error('Unsafe tool-server credential store');
    return validate(JSON.parse(readFileSync(this.#file, 'utf8')));
  }
  async #mutate(change: (document: Document) => Document): Promise<void> {
    const lockPath = toolServerCredentialStoreMutationLockPath(
      dirname(this.#directory),
      this.#scope,
    );
    mkdirSync(dirname(lockPath), { recursive: true });
    const release = await acquireFileMutationLockAsync(lockPath);
    try {
      await this.#write(change(this.#read()));
    } finally {
      await release();
    }
  }
  async #write(document: Document): Promise<void> {
    const temporary = join(
      dirname(this.#file),
      `.${FILE}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: Awaited<ReturnType<typeof open>> | undefined;
    try {
      descriptor = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      );
      if (process.platform !== 'win32') await descriptor.chmod(FILE_MODE);
      await descriptor.writeFile(
        `${JSON.stringify(validate(document))}\n`,
        'utf8',
      );
      await descriptor.sync();
      await descriptor.close();
      descriptor = undefined;
      await rename(temporary, this.#file);
      try {
        fsyncDirectorySync(this.#directory);
      } catch {}
    } finally {
      if (descriptor !== undefined)
        try {
          await descriptor.close();
        } catch {}
      try {
        await rm(temporary, { force: true });
      } catch {}
    }
  }
}
