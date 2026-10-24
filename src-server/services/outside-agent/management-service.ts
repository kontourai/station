import { domainToASCII, domainToUnicode } from 'node:url';
// UNWIRED(#4115): Shared host/passkey decisions; isolated composition only until R6.
import { z } from 'zod';
import {
  GRANT_TTL,
  MINUTE,
  OutsideOAuthRefusal,
  type Records,
  selectionSchema,
} from './oauth-records.js';
import {
  redirectPermitted,
  secretHash,
  selectedScopeDigest,
} from './oauth-registration.js';
import {
  OutsideAgentGrantStore,
  type OutsideOAuthStoreOptions,
} from './oauth-store.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const project = z.union([
  z
    .object({ kind: z.literal('project'), slug: z.string().min(1).max(128) })
    .strict(),
  z.object({ kind: z.literal('global') }).strict(),
]);
const selection = {
  project,
  accessLevel: z.literal('read-only').default('read-only'),
  expiresAt: z.number().int().positive(),
};
const request = {
  requestId: id,
  clientId: id,
  expectedRequestFingerprint: digest,
};
const grant = {
  grantId: id,
  expectedVersion: z.number().int().positive(),
  expectedDigest: digest,
};
const supersession = z.object(grant).strict();
const actionSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('approve'),
      ...request,
      ...selection,
      supersessions: z.array(supersession).max(100),
    })
    .strict(),
  z.object({ operation: z.literal('deny'), ...request }).strict(),
  z.object({ operation: z.literal('revoke'), ...grant }).strict(),
  z.object({ operation: z.literal('change'), ...grant, ...selection }).strict(),
  z
    .object({
      operation: z.literal('origin'),
      policy: z.enum(['redirect', 'cors']),
      action: z.enum(['add', 'remove']),
      origin: z.string().max(2048),
      expectedRevision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('register'),
      name: z.string().min(1).max(128),
      redirectUri: z.string().max(2048),
      applicationType: z.enum(['native', 'web']).default('native'),
    })
    .strict(),
]);
export type OutsideManagementAction = z.infer<typeof actionSchema>;
export type OutsideDecisionActor = Records['intent']['selection']['actor'] & {
  delegatingPrincipalId: string;
};
export interface OutsideManagementAuthority {
  /** Synchronous, live checks, called inside the SQLite decision lock and again at exchange. */
  current(
    actor: OutsideDecisionActor,
    scope: Records['intent']['selection']['projectScope'] | null,
  ): boolean;
  resolveProject(slug: string): { id: string } | null;
  projectExists(id: string): boolean;
}
const refuse = () => {
  throw new OutsideOAuthRefusal('target_changed');
};
const hash = (value: unknown) =>
  secretHash('management', JSON.stringify(value));
const safeLabel = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, '');

function canonicalOutsideOrigin(input: string) {
  if (
    !/^https:\/\//i.test(input) ||
    input.includes('@') ||
    input !== input.trim() ||
    /[\s\\%*\p{Cc}]/u.test(input) ||
    input.includes('?') ||
    input.includes('#')
  )
    throw new OutsideOAuthRefusal('invalid_request');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OutsideOAuthRefusal('invalid_request');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    !url.hostname ||
    url.hostname.endsWith('..') ||
    url.port === '0'
  )
    throw new OutsideOAuthRefusal('invalid_request');
  const rawHost = input.match(
    /^https:\/\/(\[[^\]]+\]|[^/:?#]+)(?::[0-9]+)?\/?$/i,
  )?.[1];
  if (
    !rawHost ||
    (/^[0-9]+(?:\.[0-9]+){3}$/.test(url.hostname) && rawHost !== url.hostname)
  )
    throw new OutsideOAuthRefusal('invalid_request');
  url.hostname = url.hostname.replace(/\.$/, '');
  if (
    !url.hostname ||
    (!url.hostname.startsWith('[') && !url.hostname.includes('.')) ||
    url.hostname.split('.').some((label) => {
      if (!label.startsWith('xn--')) return false;
      const unicode = domainToUnicode(label);
      return unicode === label || domainToASCII(unicode) !== label;
    }) ||
    (!url.hostname.startsWith('[') &&
      url.hostname
        .split('.')
        .some(
          (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
        ))
  )
    throw new OutsideOAuthRefusal('invalid_request');
  return {
    scheme: 'https' as const,
    asciiHost: url.hostname,
    effectivePort: Number(url.port || 443),
    serializedOrigin: url.origin,
  };
}

export class OutsideAgentManagementService {
  constructor(
    readonly store: OutsideAgentGrantStore,
    readonly authority: OutsideManagementAuthority,
    readonly now: () => number = Date.now,
  ) {}
  static open(
    home: string,
    options: Omit<OutsideOAuthStoreOptions, 'validateReview'>,
    authority: OutsideManagementAuthority,
  ) {
    let service: OutsideAgentManagementService;
    const store = OutsideAgentGrantStore.open(home, {
      ...options,
      validateReview: (review) => service.validateReview(review),
    });
    service = new OutsideAgentManagementService(store, authority, options.now);
    return service;
  }
  validateReview(
    review: Parameters<OutsideOAuthStoreOptions['validateReview']>[0],
  ): boolean {
    const selection = review.intent.selection;
    const scope = selection.projectScope;
    return (
      this.authority.current(
        {
          ...selection.actor,
          delegatingPrincipalId: selection.delegatingPrincipalId,
        },
        scope,
      ) &&
      (scope.kind === 'global' ||
        this.authority.projectExists(scope.projectId)) &&
      selection.redirectPolicyRevision ===
        this.store.policy('redirect').revision &&
      redirectPermitted(
        review.request.redirectUri,
        review.client.metadata.application_type,
        this.store.policy('redirect').origins,
      ) &&
      selection.scopes.every((value) => review.request.scopes.includes(value))
    );
  }
  #assertActor(
    actor: OutsideDecisionActor,
    scope: Records['intent']['selection']['projectScope'] | null = null,
  ) {
    if (
      !this.authority.current(actor, scope) ||
      (scope?.kind === 'project' &&
        !this.authority.projectExists(scope.projectId))
    )
      refuse();
  }
  #requestFingerprint(request: Records['request'], client: Records['client']) {
    return hash({
      request,
      registrationDigest: client.digest,
      redirectPolicyRevision: this.store.policy('redirect').revision,
    });
  }
  list(actor: OutsideDecisionActor) {
    return this.store.decide(() => {
      this.#assertActor(actor);
      const pending = this.store
        .pending()
        .map(({ request, comparisonCode }) => {
          const client = this.store.client(request.clientId);
          if (!client) return null;
          return {
            requestId: request.id,
            version: request.version,
            state: request.state,
            comparisonCode: actor.kind === 'host' ? comparisonCode : null,
            ageMs: this.now() - request.createdAt,
            expiresAt: request.expiresAt,
            clientId: client.id,
            clientName: safeLabel(client.metadata.client_name ?? ''),
            softwareId: safeLabel(client.metadata.software_id ?? ''),
            redirectUri: request.redirectUri,
            resource: request.resource,
            requestedScopes: [...request.scopes].sort(),
            expectedRequestFingerprint: this.#requestFingerprint(
              request,
              client,
            ),
          };
        })
        .filter((row) => row !== null);
      return {
        resource: `${this.store.options.issuer}/mcp`,
        pending,
        grants: this.store.grants().map((g) => ({
          grantId: g.id,
          version: g.version,
          digest: this.store.grantDigest(g),
          clientId: g.clientId,
          clientName: safeLabel(
            this.store.client(g.clientId)?.metadata.client_name ?? '',
          ),
          redirectUri: g.redirectUri,
          resource: g.resource,
          projectScope: g.selection.projectScope,
          accessLevel: g.selection.accessLevel,
          lastUsedAt: g.lastUsedAt,
          expiresAt: g.expiresAt,
          state: g.state,
          reason: g.reason,
          approvalActor: g.selection.actor,
          approvedAt: g.createdAt,
        })),
      };
    });
  }
  origins(actor: OutsideDecisionActor, kind: 'redirect' | 'cors') {
    this.#assertActor(actor);
    return this.store.policy(kind);
  }
  #selection(
    action: Extract<
      OutsideManagementAction,
      { operation: 'approve' | 'change' }
    >,
    actor: OutsideDecisionActor,
  ) {
    const resolved =
      action.project.kind === 'global'
        ? { kind: 'global' as const }
        : {
            kind: 'project' as const,
            projectId:
              this.authority.resolveProject(action.project.slug)?.id ?? '',
          };
    if (resolved.kind === 'project' && !resolved.projectId) refuse();
    this.#assertActor(actor, resolved);
    if (
      action.expiresAt < this.now() + 5 * MINUTE ||
      action.expiresAt > this.now() + GRANT_TTL
    )
      refuse();
    return selectionSchema.parse({
      delegatingPrincipalId: actor.delegatingPrincipalId,
      actor: {
        kind: actor.kind,
        id: actor.id,
        authorityRevision: actor.authorityRevision,
      },
      projectScope: resolved,
      accessLevel: action.accessLevel,
      scopes: ['station-control:read'],
      expiresAt: action.expiresAt,
      redirectPolicyRevision: this.store.policy('redirect').revision,
    });
  }
  #prepare(raw: unknown, actor: OutsideDecisionActor) {
    const action = actionSchema.parse(raw);
    this.#assertActor(actor);
    const base = {
      schemaVersion: 1,
      stationId: this.store.options.stationId,
      tenantId: 'local',
      issuer: this.store.options.issuer,
      resource: `${this.store.options.issuer}/mcp`,
    };
    if (action.operation === 'approve' || action.operation === 'deny') {
      const request = this.store.request(action.requestId);
      if (
        !request ||
        request.state !== 'pending' ||
        request.clientId !== action.clientId
      )
        return refuse();
      const client = this.store.client(request.clientId);
      if (
        !client ||
        this.#requestFingerprint(request, client) !==
          action.expectedRequestFingerprint
      )
        return refuse();
      const selected =
        action.operation === 'approve' ? this.#selection(action, actor) : null;
      const supersededGrants =
        action.operation === 'approve'
          ? action.supersessions
              .map((s) => ({
                grantId: s.grantId,
                expectedVersion: s.expectedVersion,
                expectedDigest: s.expectedDigest,
              }))
              .sort((a, b) => a.grantId.localeCompare(b.grantId))
          : [];
      const target = {
        kind:
          action.operation === 'approve'
            ? ('outside-agent-approval' as const)
            : ('outside-agent-denial' as const),
        ...base,
        requestId: request.id,
        expectedRequestVersion: request.version,
        expectedRequestState: 'pending',
        clientId: client.id,
        expectedRegistrationVersion: client.version,
        registrationDigest: client.digest,
        redirectUri: request.redirectUri,
        expectedRedirectPolicyRevision: this.store.policy('redirect').revision,
        responseType: 'code',
        codeChallengeMethod: 'S256',
        codeChallenge: request.challenge,
        stateDigest: request.stateDigest,
        requestedScopes: [...request.scopes].sort(),
        requestedAccessLevel: request.scopes.includes('station-control:full')
          ? 'full'
          : 'read-only',
        selectedScopes: selected?.scopes ?? [],
        selectedAccessLevel: selected?.accessLevel ?? null,
        projectScope: selected?.projectScope ?? null,
        delegatingPrincipalId: actor.delegatingPrincipalId,
        approverAuthorityRevision: actor.authorityRevision,
        expiresAt: selected?.expiresAt ?? null,
        supersededGrants,
      };
      const warning =
        new URL(request.redirectUri).protocol === 'https:'
          ? `sends access to ${new URL(request.redirectUri).origin}, a remote site`
          : null;
      const candidates = selected
        ? this.store
            .grants()
            .filter(
              (g) =>
                g.state === 'active' &&
                g.resource === request.resource &&
                g.selection.delegatingPrincipalId ===
                  actor.delegatingPrincipalId &&
                selectedScopeDigest(g.selection.projectScope) ===
                  selectedScopeDigest(selected.projectScope),
            )
            .filter((g) => {
              const other = this.store.client(g.clientId)?.metadata;
              return (
                supersededGrants.some(
                  (selected) => selected.grantId === g.id,
                ) ||
                (other &&
                  ((client.metadata.software_id &&
                    other.software_id === client.metadata.software_id) ||
                    (client.metadata.client_name &&
                      other.client_name === client.metadata.client_name)))
              );
            })
            .map((g) => ({
              grantId: g.id,
              expectedVersion: g.version,
              expectedDigest: this.store.grantDigest(g),
              clientId: g.clientId,
              name: safeLabel(
                this.store.client(g.clientId)?.metadata.client_name ?? '',
              ),
              redirectUri: g.redirectUri,
              accessLevel: g.selection.accessLevel,
              lastUsedAt: g.lastUsedAt,
              expiresAt: g.expiresAt,
              match: 'unverified',
              selected: supersededGrants.some(
                (selected) => selected.grantId === g.id,
              ),
            }))
        : [];
      return {
        action,
        target,
        warning,
        candidates,
        commit: (decisionId: string) => {
          if (!selected) {
            this.store.deny(request.id, request.version);
            return { status: 'denied', requestId: request.id };
          }
          this.store.approve({
            decisionId,
            requestId: request.id,
            expectedVersion: request.version,
            registrationDigest: client.digest,
            selection: selected,
            supersessions: supersededGrants,
          });
          return {
            status: 'approved-awaiting-exchange',
            requestId: request.id,
            projectScope: selected.projectScope,
            accessLevel: selected.accessLevel,
            expiresAt: selected.expiresAt,
            supersededGrants,
          };
        },
      };
    }
    if (action.operation === 'change' || action.operation === 'revoke') {
      const grant = this.store.grants().find((g) => g.id === action.grantId);
      if (
        !grant ||
        grant.state !== 'active' ||
        grant.version !== action.expectedVersion ||
        this.store.grantDigest(grant) !== action.expectedDigest ||
        grant.selection.delegatingPrincipalId !== actor.delegatingPrincipalId
      )
        return refuse();
      const client = this.store.client(grant.clientId);
      if (!client) return refuse();
      this.#assertActor(actor, grant.selection.projectScope);
      const next =
        action.operation === 'change' ? this.#selection(action, actor) : null;
      if (
        next &&
        (!next.scopes.every((scope) => grant.requestedScopes.includes(scope)) ||
          next.expiresAt > grant.createdAt + GRANT_TTL)
      )
        return refuse();
      const target = {
        kind:
          action.operation === 'change'
            ? ('outside-agent-grant-change' as const)
            : ('outside-agent-grant-revocation' as const),
        ...base,
        grantId: grant.id,
        clientId: client.id,
        expectedRegistrationVersion: client.version,
        registrationDigest: client.digest,
        redirectUri: grant.redirectUri,
        expectedGrantVersion: grant.version,
        expectedGrantState: 'active',
        expectedGrantDigest: this.store.grantDigest(grant),
        requestedScopes: [...grant.requestedScopes].sort(),
        requestedAccessLevel: grant.requestedScopes.includes(
          'station-control:full',
        )
          ? 'full'
          : 'read-only',
        selectedAccessLevel: next?.accessLevel ?? grant.selection.accessLevel,
        selectedScopes: next?.scopes ?? grant.selection.scopes,
        projectScope: next?.projectScope ?? grant.selection.projectScope,
        delegatingPrincipalId: actor.delegatingPrincipalId,
        approverAuthorityRevision: actor.authorityRevision,
        expiresAt: next?.expiresAt ?? grant.expiresAt,
        reason: next ? null : 'revoked',
      };
      return {
        action,
        target,
        warning: null,
        candidates: [],
        commit: () => {
          if (next)
            this.store.change(
              grant.id,
              grant.version,
              action.expectedDigest,
              next,
            );
          else this.store.revoke(grant.id, grant.version);
          return {
            status: next ? 'changed' : 'revoked',
            grantId: grant.id,
          };
        },
      };
    }
    if (action.operation === 'origin') {
      const canonicalOrigin = canonicalOutsideOrigin(action.origin);
      const policy = this.store.policy(action.policy);
      if (policy.revision !== action.expectedRevision) return refuse();
      const origins =
        action.action === 'add'
          ? [
              ...new Set([...policy.origins, canonicalOrigin.serializedOrigin]),
            ].sort()
          : policy.origins.filter(
              (o) => o !== canonicalOrigin.serializedOrigin,
            );
      const target = {
        kind:
          action.policy === 'redirect'
            ? ('outside-agent-redirect-origin-change' as const)
            : ('outside-agent-cors-origin-change' as const),
        ...base,
        actorPrincipalId: actor.delegatingPrincipalId,
        approverAuthorityRevision: actor.authorityRevision,
        operation: action.action,
        canonicalOrigin,
        expectedPolicyRevision: policy.revision,
        expectedPolicyDigest: hash(policy.origins),
        nextPolicyDigest: hash(origins),
      };
      return {
        action,
        target,
        warning: null,
        candidates: [],
        commit: () => {
          this.store.changePolicy(
            action.policy,
            action.action,
            canonicalOrigin.serializedOrigin,
            policy.revision,
          );
          return {
            status: 'changed',
            policy: action.policy,
            revision: policy.revision + 1,
          };
        },
      };
    }
    const target = {
      kind: 'outside-agent-registration' as const,
      ...base,
      actorPrincipalId: actor.delegatingPrincipalId,
      approverAuthorityRevision: actor.authorityRevision,
      name: action.name,
      redirectUri: action.redirectUri,
      applicationType: action.applicationType,
      expectedRedirectPolicyRevision: this.store.policy('redirect').revision,
    };
    return {
      action,
      target,
      warning: null,
      candidates: [],
      commit: () => {
        const client = this.store.register({
          client_name: action.name,
          application_type: action.applicationType,
          redirect_uris: [action.redirectUri],
        });
        return {
          status: 'registered',
          clientId: client.id,
          resource: `${this.store.options.issuer}/mcp`,
          redirectUri: action.redirectUri,
        };
      },
    };
  }
  review(action: unknown, actor: OutsideDecisionActor) {
    return this.store.decide(() => {
      const prepared = this.#prepare(action, actor);
      const client =
        'clientId' in prepared.target
          ? this.store.client(prepared.target.clientId)
          : undefined;
      const requestId =
        'requestId' in prepared.target ? prepared.target.requestId : null;
      return {
        action: prepared.action,
        clientDetails: client
          ? {
              clientId: client.id,
              unverified: true,
              clientName: safeLabel(client.metadata.client_name ?? ''),
              softwareId: safeLabel(client.metadata.software_id ?? ''),
            }
          : null,
        target: prepared.target,
        fingerprint: JSON.stringify(prepared.target),
        comparisonCode: requestId
          ? (this.store
              .pending()
              .find(({ request }) => request.id === requestId)
              ?.comparisonCode ?? null)
          : null,
        warning: prepared.warning,
        supersessionCandidates: prepared.candidates,
        disconnectWarning:
          'Selected grants will disconnect when the new login completes.',
      };
    });
  }
  commit(
    input: { action: unknown; fingerprint: string; decisionId: string },
    actor: OutsideDecisionActor,
  ) {
    id.parse(input.decisionId);
    return this.store.decide(() => {
      this.#assertActor(actor);
      const prior = this.store.decision(input.decisionId);
      const storedActor = {
        kind: actor.kind,
        id: actor.id,
        authorityRevision: actor.authorityRevision,
      };
      if (prior) {
        if (
          prior.fingerprint !== input.fingerprint ||
          prior.actionDigest !== hash(input.action) ||
          JSON.stringify(prior.actor) !== JSON.stringify(storedActor)
        )
          return refuse();
        return prior.effect;
      }
      const prepared = this.#prepare(input.action, actor);
      if (JSON.stringify(prepared.target) !== input.fingerprint)
        return refuse();
      const effect = prepared.commit(input.decisionId);
      this.store.recordDecision({
        id: input.decisionId,
        fingerprint: input.fingerprint,
        actionDigest: hash(input.action),
        actor: storedActor,
        effect,
        createdAt: this.now(),
      });
      return effect;
    });
  }
}

export type OutsideManagementReview = ReturnType<
  OutsideAgentManagementService['review']
>;
