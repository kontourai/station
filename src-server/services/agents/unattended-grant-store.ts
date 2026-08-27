/**
 * Persistent, exact-tool grants for unattended principals (station#2037).
 *
 * A grant is keyed by `(principalKey, toolName)`. `principalKey` is derived
 * from the principal's stable identity: a voice grant includes `agentSlug`,
 * but deliberately excludes its per-session `sessionId`. This lets an
 * operator grant a tool to an agent acting through voice without creating a
 * fresh consent record for every voice session.
 *
 * This v1 store deliberately has no expiry, capability, argument, or tenant
 * scope. Revocation is retained as an audit record and is the only way a
 * grant stops authorizing.
 */

import { join } from 'node:path';
import type { UnattendedPrincipal } from '../../runtime/types.js';
import { unattendedGrantOperations } from '../../telemetry/metrics.js';
import { createLogger } from '../../utils/logger.js';
import { resolveHomeDir } from '../../utils/paths.js';
import {
  GrantsFileStore,
  GrantsStoreUnavailableError,
  isPlainObject,
} from '../plugins/grants-file-store.js';

const STORE_FILENAME = 'unattended-tool-grants.json';

const logger = createLogger({ name: 'unattended-grant-store' });

/**
 * Record a grant/revoke metric AFTER the mutation has durably committed.
 * Telemetry is best-effort and must never turn an already-committed
 * authority change into an observed failure — a throw here would surface a
 * non-2xx to the caller while the grant is live (the fail-closed-mutation
 * violation this guards against). Swallow and log instead.
 */
function recordGrantOperationMetric(operation: 'grant' | 'revoke'): void {
  try {
    unattendedGrantOperations.add(1, { operation });
  } catch (cause) {
    // Belt-and-suspenders: even logging the failure must not throw past a
    // committed authority change (a pathological `cause` — e.g. a Proxy whose
    // enumeration traps throw — could otherwise escape through redaction/pino).
    // Telemetry AND its failure-logging are best-effort here.
    try {
      logger.warn(
        'unattended-grant operation metric failed after commit; ignoring',
        { operation, error: cause },
      );
    } catch {
      // Intentionally swallowed: see above.
    }
  }
}

/** A retained receipt for one principal-key/exact-tool consent decision. */
export interface UnattendedToolGrant {
  principalKey: string;
  toolName: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
}

interface UnattendedGrantFile {
  [grantKey: string]: UnattendedToolGrant;
}

/** The store cannot be read or written, so no authorization answer is safe. */
export class UnattendedGrantStoreUnavailableError extends GrantsStoreUnavailableError {
  constructor(
    storePath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(storePath, detail, options);
    this.name = 'UnattendedGrantStoreUnavailableError';
  }
}

/** A caller supplied an unusable authority identifier; no mutation was made. */
export class UnattendedGrantValidationError extends TypeError {
  constructor(field: 'principal' | 'toolName' | 'grantedBy') {
    super(
      `Unattended grant ${field} must be a non-empty, non-whitespace string`,
    );
    this.name = 'UnattendedGrantValidationError';
  }
}

/** Home-relative persistent location; defaults to `STATION_HOME`. */
export function unattendedGrantStorePath(
  homeDir: string = resolveHomeDir(),
): string {
  return join(homeDir, 'security', STORE_FILENAME);
}

/**
 * Stable, serialized principal identity for grant lookup.
 *
 * Voice `sessionId` is intentionally omitted because it changes per session;
 * all other current principal variants consist entirely of stable identity.
 */
export function principalKey(principal: UnattendedPrincipal): string {
  switch (principal.kind) {
    case 'voice':
      return JSON.stringify({
        kind: principal.kind,
        agentSlug: principal.agentSlug,
      });
    case 'scheduled-job':
      return JSON.stringify({ kind: principal.kind, jobId: principal.jobId });
    case 'delegated-child':
      return JSON.stringify({
        kind: principal.kind,
        originAgentSlug: principal.originAgentSlug,
      });
  }
}

/** A collision-free file key; stored identity remains readable in the value. */
function grantKey(principal: string, toolName: string): string {
  return JSON.stringify([principal, toolName]);
}

/** Validate mutation inputs before acquiring the store lock or writing a file. */
function validateMutationInputs(
  principal: string,
  toolName: string,
  // `grantedBy` is REQUIRED on the grant path and absent on revoke. It is a
  // wrapper object rather than an optional string so a runtime
  // grantTool(p, t, undefined) is rejected instead of silently skipped — a
  // receipt with a vanishing grantedBy would brick the store on next read.
  grant?: { grantedBy: unknown },
): void {
  const inputs: Array<[unknown, 'principal' | 'toolName' | 'grantedBy']> = [
    [principal, 'principal'],
    [toolName, 'toolName'],
  ];
  if (grant) inputs.push([grant.grantedBy, 'grantedBy']);
  for (const [value, field] of inputs) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new UnattendedGrantValidationError(field);
    }
  }
}

function shapeProblems(value: unknown): string[] {
  if (!isPlainObject(value)) {
    return ['must be an object keyed by principal-key/exact-tool'];
  }
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      problems.push(`${key}: must be an object`);
      continue;
    }
    for (const field of [
      'principalKey',
      'toolName',
      'grantedBy',
      'grantedAt',
    ]) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        problems.push(`${key}.${field}: must be a non-empty string`);
      }
    }
    if (entry.revokedAt !== undefined && typeof entry.revokedAt !== 'string') {
      problems.push(`${key}.revokedAt: must be a string when present`);
    }
    if (
      typeof entry.principalKey === 'string' &&
      typeof entry.toolName === 'string' &&
      key !== grantKey(entry.principalKey, entry.toolName)
    ) {
      problems.push(`${key}: does not match its principalKey/toolName`);
    }
    const allowed = new Set([
      'principalKey',
      'toolName',
      'grantedBy',
      'grantedAt',
      'revokedAt',
    ]);
    for (const field of Object.keys(entry)) {
      if (!allowed.has(field)) problems.push(`${key}.${field}: unknown field`);
    }
  }
  return problems;
}

export class UnattendedGrantStore {
  private readonly grants: GrantsFileStore<UnattendedGrantFile>;

  constructor(
    homeDir: string = resolveHomeDir(),
    private readonly now = () => new Date(),
  ) {
    this.grants = new GrantsFileStore<UnattendedGrantFile>({
      filePath: unattendedGrantStorePath(homeDir),
      storeLabel: 'unattended-tool-grants',
      shapeProblems,
      makeUnavailableError: (storePath, detail, cause) =>
        new UnattendedGrantStoreUnavailableError(storePath, detail, { cause }),
      emptyValue: {},
    });
  }

  async grantTool(
    principal: string,
    toolName: string,
    grantedBy: string,
  ): Promise<UnattendedToolGrant> {
    validateMutationInputs(principal, toolName, { grantedBy });
    const key = grantKey(principal, toolName);
    const receipt: UnattendedToolGrant = {
      principalKey: principal,
      toolName,
      grantedBy,
      grantedAt: this.now().toISOString(),
    };
    await this.grants.mutate(key, (current) => {
      current[key] = receipt;
      return current;
    });
    recordGrantOperationMetric('grant');
    return receipt;
  }

  async revokeGrant(principal: string, toolName: string): Promise<void> {
    validateMutationInputs(principal, toolName);
    const key = grantKey(principal, toolName);
    await this.grants.mutate(key, (current) => {
      const existing = current[key];
      if (existing)
        current[key] = { ...existing, revokedAt: this.now().toISOString() };
      return current;
    });
    recordGrantOperationMetric('revoke');
  }

  /** Throws unavailable rather than silently treating a corrupt store as deny. */
  isGranted(principal: string, toolName: string): boolean {
    const grant = this.grants.read()[grantKey(principal, toolName)];
    return grant !== undefined && grant.revokedAt === undefined;
  }

  /** Includes revoked records so revoke UX can expose the audit trail. */
  listGrants(): UnattendedToolGrant[] {
    return Object.values(this.grants.read()).map((grant) => ({ ...grant }));
  }
}
