import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
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
const storedGrants = z.array(storedGrant).max(256);

export type DelegationGrant = z.output<typeof storedGrant>;

export class DelegationGrantStore {
  private readonly path: string;
  private parsed?: { identity: string; grants: DelegationGrant[] };
  private readonly auditedExpirations = new Set<string>();
  private readonly io = { maxBytes: 256 * 1024, label: 'Delegation grants' };

  constructor(
    stationHome: string,
    private readonly logger: Logger,
  ) {
    this.path = join(stationHome, 'config', 'delegation-grants.json');
  }

  list(): readonly DelegationGrant[] {
    return this.readActive() ?? [];
  }

  readActive(): readonly DelegationGrant[] | undefined {
    let grants: DelegationGrant[];
    try {
      const stat = statSync(this.path, { bigint: true, throwIfNoEntry: false });
      if (!stat) {
        this.parsed = undefined;
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
      } else {
        grants = storedGrants.parse(
          readJsonFile<unknown>(this.path, [], this.io),
        );
        this.parsed = { identity, grants };
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
      (current) => storedGrants.parse([...storedGrants.parse(current), grant]),
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
        storedGrants.parse(current).filter((grant) => {
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
