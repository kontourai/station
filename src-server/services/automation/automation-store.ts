/**
 * Private Station-home storage for Automation sources and rules
 * (`security/automations.json`, mode 0600).
 *
 * The file is re-read and re-validated on every access, like the inbound
 * webhook configuration, so a revocation or a hand edit takes effect on the
 * next read without a restart. A file that exists but cannot be read, parsed
 * or validated fails closed with {@link AutomationPolicyUnavailableError}; it
 * never reads as an empty configuration, because "no rules" would silently
 * mask a configuration the operator believes is in force. Only genuine
 * absence reads as empty.
 *
 * Sources and rules are always created disabled, with server-issued ids. A
 * rule is refused unless its source grants its action (the two-keys rule;
 * see `automation-config-validation.ts`). Mutations run under a cross-process
 * file lock with the read inside it, and a corrupt file is never overwritten.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AUTOMATION_SCHEMA_VERSION,
  type AutomationAction,
  type AutomationConfiguration,
  type AutomationEpisodePolicy,
  type AutomationGrant,
  type AutomationMatcher,
  type AutomationRule,
  type AutomationSource,
  type AutomationSourceProjection,
} from '@kontourai/station-contracts/automation';
import { writeJsonDurably } from '@kontourai/station-shared/durable-json-file';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { resolveHomeDir } from '../../utils/paths.js';
import { automationConfigurationProblems } from './automation-config-validation.js';

export const AUTOMATION_CONFIG_FILE = 'automations.json';

/** Home-relative persistent location; defaults to `STATION_HOME`. */
export function automationConfigPath(
  homeDir: string = resolveHomeDir(),
): string {
  return join(homeDir, 'security', AUTOMATION_CONFIG_FILE);
}

/**
 * The Automation policy cannot be read, so no Automation may act. The
 * message is path-free so a route may serialize it; the detail stays
 * server-side.
 */
export class AutomationPolicyUnavailableError extends Error {
  readonly code = 'policy_unavailable' as const;

  constructor(
    readonly detail: string,
    options?: { cause?: unknown },
  ) {
    super('Automation policy is unavailable.', options);
    this.name = 'AutomationPolicyUnavailableError';
  }
}

/** A requested change would produce an invalid configuration; nothing was written. */
export class AutomationValidationError extends Error {
  readonly code = 'invalid_automation' as const;

  constructor(readonly problems: readonly string[]) {
    super(`Automation configuration is invalid: ${problems.join('; ')}`);
    this.name = 'AutomationValidationError';
  }
}

export type CreateAutomationSourceInput =
  | Readonly<{
      kind: 'github-poll';
      name: string;
      repository: string;
      grants?: readonly AutomationGrant[];
      credentialSecretBinding?: string;
      pollIntervalMs?: number;
    }>
  | Readonly<{
      kind: 'github-webhook';
      name: string;
      repository: string;
      grants?: readonly AutomationGrant[];
    }>;

export type CreateAutomationSourceResult = Readonly<{
  source: AutomationSourceProjection;
  /**
   * The generated webhook secret, returned exactly once at creation so the
   * operator can configure GitHub. It is never returned again.
   */
  secret?: string;
}>;

export type CreateAutomationRuleInput = Readonly<{
  name: string;
  sourceId: string;
  match: AutomationMatcher;
  episode?: AutomationEpisodePolicy;
  action: AutomationAction;
  rateLimit: Readonly<{ maxStartsPerHour: number }>;
}>;

const EMPTY_CONFIGURATION: AutomationConfiguration = Object.freeze({
  schemaVersion: AUTOMATION_SCHEMA_VERSION,
  sources: [],
  rules: [],
});

/** Removes the webhook secret; every API surface must project through this. */
export function projectAutomationSource(
  source: AutomationSource,
): AutomationSourceProjection {
  if (source.kind === 'github-poll') return structuredClone(source);
  const { secret: _secret, ...rest } = source;
  return { ...structuredClone(rest), hasSecret: true };
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export class AutomationStore {
  readonly path: string;

  constructor(
    homeDir: string = resolveHomeDir(),
    private readonly newId: () => string = randomUUID,
  ) {
    this.path = automationConfigPath(homeDir);
  }

  /** Validated read. Throws {@link AutomationPolicyUnavailableError} unless valid or absent. */
  read(): AutomationConfiguration {
    let raw: string;
    try {
      // lstat first: a symlink (dangling or not) is not this store's file,
      // and `readFileSync` would follow it or report a misleading ENOENT.
      if (lstatSync(this.path).isSymbolicLink()) {
        throw new AutomationPolicyUnavailableError('store path is a symlink');
      }
      raw = readFileSync(this.path, 'utf8');
    } catch (error) {
      if (error instanceof AutomationPolicyUnavailableError) throw error;
      if (isAbsent(error)) return structuredClone(EMPTY_CONFIGURATION);
      throw new AutomationPolicyUnavailableError('unreadable', {
        cause: error,
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AutomationPolicyUnavailableError('unparseable JSON', {
        cause: error,
      });
    }
    const problems = automationConfigurationProblems(parsed);
    if (problems.length > 0) {
      throw new AutomationPolicyUnavailableError(
        `invalid: ${problems.slice(0, 8).join('; ')}`,
      );
    }
    return parsed as AutomationConfiguration;
  }

  listSources(): AutomationSourceProjection[] {
    return this.read().sources.map(projectAutomationSource);
  }

  listRules(): AutomationRule[] {
    return structuredClone([...this.read().rules]);
  }

  /** Creates a disabled source with a server-issued id. */
  async createSource(
    input: CreateAutomationSourceInput,
  ): Promise<CreateAutomationSourceResult> {
    const id = this.newId();
    let source: AutomationSource;
    let secret: string | undefined;
    if (input.kind === 'github-webhook') {
      secret = randomBytes(32).toString('hex');
      source = {
        id,
        kind: 'github-webhook',
        name: input.name,
        repository: input.repository,
        enabled: false,
        ...(input.grants ? { grants: input.grants } : {}),
        secret,
      };
    } else {
      source = {
        id,
        kind: 'github-poll',
        name: input.name,
        repository: input.repository,
        enabled: false,
        ...(input.grants ? { grants: input.grants } : {}),
        ...(input.credentialSecretBinding !== undefined
          ? { credentialSecretBinding: input.credentialSecretBinding }
          : {}),
        ...(input.pollIntervalMs !== undefined
          ? { pollIntervalMs: input.pollIntervalMs }
          : {}),
      };
    }
    await this.mutate((current) => ({
      ...current,
      sources: [...current.sources, source],
    }));
    return {
      source: projectAutomationSource(source),
      ...(secret ? { secret } : {}),
    };
  }

  /**
   * Creates a disabled rule with a server-issued id. Refused with
   * {@link AutomationValidationError} when its source does not grant the
   * rule's action.
   */
  async createRule(input: CreateAutomationRuleInput): Promise<AutomationRule> {
    const rule: AutomationRule = {
      id: this.newId(),
      name: input.name,
      enabled: false,
      sourceId: input.sourceId,
      match: input.match,
      ...(input.episode ? { episode: input.episode } : {}),
      action: input.action,
      rateLimit: input.rateLimit,
    };
    await this.mutate((current) => ({
      ...current,
      rules: [...current.rules, rule],
    }));
    return structuredClone(rule);
  }

  private async mutate(
    change: (current: AutomationConfiguration) => AutomationConfiguration,
  ): Promise<void> {
    let release: () => Promise<void>;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      release = await acquireFileMutationLockAsync(`${this.path}.mutation`);
    } catch (error) {
      throw new AutomationPolicyUnavailableError('lock unavailable', {
        cause: error,
      });
    }
    try {
      // Read inside the lock; a corrupt file throws here and is never
      // replaced by a write derived from an empty default.
      const next = change(this.read());
      const problems = automationConfigurationProblems(next);
      if (problems.length > 0) throw new AutomationValidationError(problems);
      this.writePrivate(next);
    } finally {
      await release();
    }
  }

  private writePrivate(configuration: AutomationConfiguration): void {
    try {
      writeJsonDurably(this.path, configuration);
      chmodSync(dirname(this.path), 0o700);
      chmodSync(this.path, 0o600);
    } catch (error) {
      throw new AutomationPolicyUnavailableError('write failed', {
        cause: error,
      });
    }
  }
}
