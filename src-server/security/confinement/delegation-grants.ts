import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parseConfinedNetworkSetting } from '@kontourai/station-contracts/execution-confinement';
import {
  mutateJsonFile,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';
import { z } from 'zod';
import type { Logger } from '../../utils/logger.js';

const identity = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim());
const targets = z.array(identity).max(256).default([]);
const projectScope = z.strictObject({ kind: z.literal('project') });
const scope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('station') }),
  projectScope,
  z.strictObject({
    kind: z.literal('conversation'),
    conversationId: identity,
  }),
]);

const expiry = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('parent-session') }),
  z.strictObject({ kind: z.literal('revoked') }),
  z.strictObject({
    kind: z.literal('duration'),
    seconds: z.number().int().positive().max(31_536_000),
  }),
]);

const network = z
  .discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('default') }),
    z.strictObject({ mode: z.literal('open') }),
    z.strictObject({
      mode: z.literal('allowlist'),
      allowedHosts: z.array(z.string()),
    }),
  ])
  .refine(
    (value) =>
      value.mode !== 'allowlist' ||
      parseConfinedNetworkSetting({
        mode: 'restricted',
        allowedHosts: value.allowedHosts,
      }) !== undefined,
    'Invalid egress allowlist',
  );

export function isAllowedExtraDelegationGitPath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  const parts = path.split('/');
  if (
    parts.some(
      (part) =>
        !part || part === '.' || part === '..' || /[\\:\p{Cc}]/u.test(part),
    )
  )
    return false;
  const root = parts[0]?.toLowerCase();
  return root !== 'worktrees' && root !== 'objects';
}

export function isHighRiskDelegationGitPath(path: string): boolean {
  return /^(?:hooks|config|config\.worktree|packed-refs|refs)(?:\/|$)/i.test(
    path,
  );
}

export const delegationGrantSettingsSchema = z
  .strictObject({
    access: z.enum(['confined', 'full-access']),
    scope: scope.default({ kind: 'project' }),
    agents: targets,
    models: targets,
    projects: targets,
    ownWorktree: z.boolean().default(true),
    network: network.default({ mode: 'default' }),
    expiry: expiry.default({ kind: 'parent-session' }),
    highRiskGitWritesConfirmed: z.boolean().default(false),
    extraGitWritePaths: z
      .record(
        identity,
        z
          .array(
            z
              .string()
              .min(1)
              .max(1024)
              .refine(
                isAllowedExtraDelegationGitPath,
                'Path must stay within the common Git directory and outside protected Git metadata',
              ),
          )
          .max(64),
      )
      .default({}),
  })
  .refine(
    (grant) =>
      grant.highRiskGitWritesConfirmed ||
      !Object.values(grant.extraGitWritePaths)
        .flat()
        .some(isHighRiskDelegationGitPath),
    'High-risk Git writes require separate operator confirmation',
  );

export type DelegationGrantSettings = z.output<
  typeof delegationGrantSettingsSchema
>;

const storedGrant = delegationGrantSettingsSchema.safeExtend({
  id: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
  createdBy: z.literal('operator'),
});
const storedGrants = z.array(z.unknown()).max(256);
const signedGrant = z.strictObject({
  grant: storedGrant,
  mac: z.string().regex(/^[a-f0-9]{64}$/),
});

export function delegationGrantKeyPath(stationHome: string): string {
  return join(stationHome, 'security', 'delegation-grant.key');
}

function loadDelegationGrantKey(path: string): Buffer {
  mkdirSync(dirname(path), { mode: 0o700, recursive: true });
  try {
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const entry = lstatSync(path);
  if (
    !entry.isFile() ||
    entry.size !== 32 ||
    (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)
  ) {
    throw new Error('Invalid delegation grant signing key.');
  }
  return readFileSync(path);
}

export type DelegationGrant = z.output<typeof storedGrant>;

export class DelegationGrantStore {
  private readonly path: string;
  private parsed?: {
    identity: string;
    grants: DelegationGrant[];
    ignored: number;
  };
  private readonly key?: Buffer;
  private ignored = 0;
  private readonly auditedExpirations = new Set<string>();
  private readonly io = { maxBytes: 256 * 1024, label: 'Delegation grants' };

  constructor(
    stationHome: string,
    private readonly logger: Logger,
  ) {
    this.path = join(stationHome, 'config', 'delegation-grants.json');
    try {
      this.key = loadDelegationGrantKey(delegationGrantKeyPath(stationHome));
    } catch {
      this.logger.error(
        'Delegation grant signing key unavailable. Standing grants are disabled.',
      );
    }
  }

  ignoredEntries(): number {
    return this.ignored;
  }

  private sign(grant: DelegationGrant): string {
    if (!this.key) throw new Error('Delegation grant signing key unavailable.');
    return createHmac('sha256', this.key)
      .update(JSON.stringify(grant))
      .digest('hex');
  }

  private authenticated(input: unknown) {
    if (!this.key) throw new Error('Delegation grant signing key unavailable.');
    const entries = storedGrants.parse(input);
    const verified: Array<z.output<typeof signedGrant>> = [];
    for (const entry of entries) {
      const parsed = signedGrant.safeParse(entry);
      if (!parsed.success) continue;
      const { grant, mac } = parsed.data;
      if (
        timingSafeEqual(
          Buffer.from(mac, 'hex'),
          Buffer.from(this.sign(grant), 'hex'),
        )
      ) {
        verified.push(parsed.data);
      }
    }
    return { verified, ignored: entries.length - verified.length };
  }

  list(): readonly DelegationGrant[] {
    return this.readActive() ?? [];
  }

  readActive(): readonly DelegationGrant[] | undefined {
    if (!this.key) return undefined;
    let grants: DelegationGrant[];
    try {
      const stat = statSync(this.path, { bigint: true, throwIfNoEntry: false });
      if (!stat) {
        this.parsed = undefined;
        this.ignored = 0;
        return [];
      }
      const identity = [
        stat.dev,
        stat.ino,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
      ].join(':');
      if (this.parsed?.identity === identity) {
        grants = this.parsed.grants;
        this.ignored = this.parsed.ignored;
      } else {
        const { verified, ignored } = this.authenticated(
          readJsonFile<unknown>(this.path, [], this.io),
        );
        grants = verified.map(({ grant }) => grant);
        this.ignored = ignored;
        this.parsed = { identity, grants, ignored };
        if (ignored > 0)
          this.logger.warn('Ignored unauthenticated delegation grants', {
            count: ignored,
          });
      }
    } catch {
      this.parsed = undefined;
      this.logger.error(
        'Delegation grants could not be read. Standing grants are disabled.',
      );
      return undefined;
    }
    const now = Date.now();
    return grants.filter((grant) => {
      if (
        grant.expiry.kind !== 'duration' ||
        now < grant.createdAt + grant.expiry.seconds * 1000
      )
        return true;
      if (!this.auditedExpirations.has(grant.id)) {
        this.auditedExpirations.add(grant.id);
        this.logger.info('Delegation grant expired', { grantId: grant.id });
      }
      return false;
    });
  }

  async create(
    settings: DelegationGrantSettings,
    assertCurrent: () => void,
  ): Promise<DelegationGrant> {
    const grant = storedGrant.parse({
      ...settings,
      id: randomUUID(),
      createdAt: Date.now(),
      createdBy: 'operator',
    });
    await mutateJsonFile<unknown>(
      this.path,
      [],
      (current) =>
        storedGrants.parse([
          ...this.authenticated(current).verified,
          { grant, mac: this.sign(grant) },
        ]),
      { ...this.io, assertCurrent },
    );
    this.logger.info('Delegation grant created', { grantId: grant.id });
    return grant;
  }

  async revoke(id: string, assertCurrent: () => void): Promise<boolean> {
    let revoked = false;
    await mutateJsonFile<unknown>(
      this.path,
      [],
      (current) =>
        this.authenticated(current).verified.filter(({ grant }) => {
          if (grant.id !== id) return true;
          revoked = true;
          return false;
        }),
      { ...this.io, assertCurrent },
    );
    if (revoked) this.logger.info('Delegation grant revoked', { grantId: id });
    return revoked;
  }
}

export interface VerifiedDelegationGrantParent {
  sessionId: string;
  conversationId: string;
  projectSlug?: string;
  credentialCurrent(): boolean;
}

export interface DelegationGrantTarget {
  agent: string;
  model: string;
  project: string;
  parentConversationId: string;
  parentSessionActive: boolean;
}

const scopeRank: Record<DelegationGrant['scope']['kind'], number> = {
  conversation: 0,
  project: 1,
  station: 2,
};

export function selectDelegationGrant(
  grants: readonly DelegationGrant[],
  target: DelegationGrantTarget,
  now: number,
): DelegationGrant | undefined {
  const applicable = grants.filter(
    (grant) =>
      grant.agents.includes(target.agent) &&
      grant.models.includes(target.model) &&
      grant.projects.includes(target.project) &&
      (grant.scope.kind !== 'conversation' ||
        grant.scope.conversationId === target.parentConversationId) &&
      (grant.expiry.kind !== 'parent-session' || target.parentSessionActive) &&
      (grant.expiry.kind !== 'duration' ||
        now < grant.createdAt + grant.expiry.seconds * 1000),
  );
  applicable.sort((a, b) => scopeRank[a.scope.kind] - scopeRank[b.scope.kind]);
  const [first, second] = applicable;
  // Overlapping grants at the same scope cannot select an access level.
  return first && (!second || first.scope.kind !== second.scope.kind)
    ? first
    : undefined;
}

export interface DelegationLaunch {
  readonly grant: DelegationGrant;
  readonly highRiskGitWrites?: boolean;
  readonly current: () => boolean;
  readonly codexGit?: import('@kontourai/station-contracts/execution-confinement').ConfinementPlan['delegatedCodexGit'];
}
