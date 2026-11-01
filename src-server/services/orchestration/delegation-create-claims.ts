import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
} from '../../domain/file-storage-helpers.js';
import type {
  DelegatedTaskHandle,
  DelegateTaskInput,
} from '../../tools/station-control-delegation.js';
import type {
  ForegroundMessageHandle,
  ForegroundMessageInput,
} from '../execution-target/execution-target-execution.js';
import { chatTurnSubmissionDigest } from './turn-submission-digest.js';

const MISSING = Symbol('missing-create-claims');

type CreateHandle = DelegatedTaskHandle | ForegroundMessageHandle;

interface Claim {
  kind: 'delegation' | 'foreground';
  digest: string;
  sessionId: string;
  result?: CreateHandle;
}
interface Ledger {
  version: 1;
  claims: Record<string, Claim>;
}

export class DelegationCreateConflictError extends Error {
  readonly code = 'delegation_create_conflict';
  constructor() {
    super('This request key already belongs to different delegation input.');
  }
}
export class DelegationCreateIndeterminateError extends Error {
  readonly code = 'delegation_create_indeterminate';
  readonly outcome = 'indeterminate';
  constructor(
    readonly sessionId: string,
    readonly clientTurnId: string,
  ) {
    super(
      'The original delegation may have started. Inspect its session; do not resend under a new key.',
    );
  }
}

/** Durable create claims use the same lock/atomic-publication boundary as portable attempt claims. */
export class DelegationCreateClaims {
  readonly #file: string;
  constructor(dataDir: string) {
    this.#file = join(dataDir, 'delegation-create-claims.json');
  }

  #read(): Ledger {
    const ledger = readJsonFile<Ledger | typeof MISSING>(this.#file, MISSING, {
      maxBytes: 4 * 1024 * 1024,
      label: 'Delegation create claims',
    });
    if (ledger === MISSING) return { version: 1, claims: {} };
    if (
      !ledger ||
      typeof ledger !== 'object' ||
      ledger.version !== 1 ||
      !ledger.claims ||
      typeof ledger.claims !== 'object' ||
      Array.isArray(ledger.claims)
    )
      throw new Error('Malformed delegation create claims');
    for (const claim of Object.values(ledger.claims)) {
      if (
        !claim ||
        !/^[a-f0-9]{64}$/.test(claim.digest) ||
        typeof claim.sessionId !== 'string' ||
        claim.sessionId.length === 0 ||
        (claim.kind !== 'delegation' && claim.kind !== 'foreground') ||
        (claim.result !== undefined &&
          (claim.result.conversationId !== claim.sessionId ||
            !claim.result.sessionId ||
            !claim.result.target ||
            !claim.result.resolution ||
            (claim.kind === 'foreground'
              ? !(
                  'providerTurnId' in claim.result &&
                  claim.result.providerTurnId
                )
              : !('turnId' in claim.result && claim.result.turnId))))
      )
        throw new Error('Malformed delegation create claim');
    }
    return ledger;
  }

  async #update<T>(operation: (ledger: Ledger) => T): Promise<T> {
    const release = await acquireFileMutationLockAsync(
      `${this.#file}.mutation`,
    );
    try {
      const ledger = this.#read();
      const result = operation(ledger);
      await publishJsonFileWithOwnedLock(this.#file, ledger, {
        maxBytes: 4 * 1024 * 1024,
        label: 'Delegation create claims',
      });
      return result;
    } finally {
      await release();
    }
  }

  async run<T extends CreateHandle>(
    input: {
      kind: 'delegation' | 'foreground';
      principal: PrincipalRef | undefined;
      authority: SessionReadAuthority;
      requestKey: string;
      intent: unknown;
      sessionId?: string;
    },
    effect: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    if (!input.authority.userId || !input.requestKey)
      throw new Error(
        'Delegation create requires authenticated caller scope and a request key.',
      );
    const scope = JSON.stringify([
      input.authority.mode,
      input.authority.tenantExecutionContext?.tenantId ?? null,
      input.authority.userId,
      input.principal?.id ?? null,
    ]);
    const key = createHash('sha256')
      .update(JSON.stringify([input.kind, scope, input.requestKey]))
      .digest('hex');
    const digest = createHash('sha256')
      .update(chatTurnSubmissionDigest(input.intent))
      .digest('hex');
    const claimed = await this.#update((ledger) => {
      const existing = Object.hasOwn(ledger.claims, key)
        ? ledger.claims[key]
        : undefined;
      if (existing) {
        if (existing.digest !== digest)
          throw new DelegationCreateConflictError();
        return { claim: existing, created: false };
      }
      // Never evict an old or unresolved claim to admit another create.
      if (Object.keys(ledger.claims).length >= 1024)
        throw new Error('Delegation create claim capacity reached.');
      const claim: Claim = {
        kind: input.kind,
        digest,
        sessionId:
          input.sessionId ??
          `${input.kind === 'delegation' ? 'task' : 'conversation'}:${randomUUID()}`,
      };
      ledger.claims[key] = claim;
      return { claim, created: true };
    });
    if (!claimed.created) {
      if (claimed.claim.result) return claimed.claim.result as T;
      // No owner reclaim: absence of a session is insufficient proof that no effect occurred.
      throw new DelegationCreateIndeterminateError(
        claimed.claim.sessionId,
        input.requestKey,
      );
    }
    const result = await effect(claimed.claim.sessionId);
    await this.#update((ledger) => {
      ledger.claims[key].result = result;
    });
    return result;
  }
}

export async function runDelegationCreate(
  input: DelegateTaskInput,
  authority: SessionReadAuthority,
  existingAttemptSessionId: string | undefined,
  create: (sessionId: string) => Promise<DelegatedTaskHandle>,
): Promise<DelegatedTaskHandle> {
  if (existingAttemptSessionId) return create(existingAttemptSessionId);
  const claims = input.delegationAttemptClaimStore?.createRequests;
  if (!claims)
    throw new Error('Durable delegation create claims are unavailable.');
  return claims.run(
    {
      kind: 'delegation',
      principal: input.principal,
      authority,
      requestKey: input.clientTurnId!,
      intent: input.createRequestIntent ?? {
        prompt: input.prompt,
        target: input.target,
        parentTaskId: input.parentTaskId ?? null,
        sessionId: input.sessionId ?? null,
        attachments: input.taskRoomAttachments ?? null,
      },
      sessionId: input.sessionId,
    },
    create,
  );
}

export async function runForegroundCreateClaim(
  claims: DelegationCreateClaims | undefined,
  input: ForegroundMessageInput,
  authority: SessionReadAuthority,
  intent: unknown,
  execute: (input: ForegroundMessageInput) => Promise<unknown>,
): Promise<unknown> {
  if (input.conversationId) return execute(input);
  if (!claims || !input.clientTurnId)
    throw new Error('Durable foreground create claims are unavailable.');
  return claims.run(
    {
      kind: 'foreground',
      principal: input.principal,
      authority,
      requestKey: input.clientTurnId,
      intent,
    },
    async (conversationId) => {
      const result = await execute({ ...input, conversationId });
      if (
        !result ||
        typeof result !== 'object' ||
        !('conversationId' in result) ||
        result.conversationId !== conversationId ||
        !('sessionId' in result) ||
        typeof result.sessionId !== 'string' ||
        !('providerTurnId' in result) ||
        typeof result.providerTurnId !== 'string' ||
        !result.providerTurnId
      )
        throw new DelegationCreateIndeterminateError(
          conversationId,
          input.clientTurnId!,
        );
      return result as ForegroundMessageHandle;
    },
  );
}
