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
 * Sources are always created disabled and rules in `observe` mode, with
 * server-issued ids. A rule written before #4509 stores `enabled: boolean`;
 * {@link migrateLegacyRuleModes} reads it as `mode` (`false` -> `off`,
 * `true` -> `live`) before validation, and every write stores `mode`. A rule
 * carrying both fields is ambiguous and fails closed. A
 * rule is refused unless its source grants its action (the two-keys rule;
 * see `automation-config-validation.ts`). Mutations run under a cross-process
 * file lock with the read inside it, and a corrupt file is never overwritten.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AUTOMATION_EXECUTION_LIMITS,
  AUTOMATION_SCHEMA_VERSION,
  type AutomationAction,
  type AutomationConfiguration,
  type AutomationEpisodePolicy,
  type AutomationGrant,
  type AutomationMatcher,
  type AutomationRule,
  type AutomationRuleMode,
  type AutomationSource,
  type AutomationSourceProjection,
} from '@kontourai/station-contracts/automation';
import { writeJsonDurably } from '@kontourai/station-shared/durable-json-file';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { isRecord } from '../../utils/is-record.js';
import { resolveHomeDir } from '../../utils/paths.js';
import {
  automationConfigurationProblems,
  sourceGrantsRuleAction,
} from './automation-config-validation.js';

import { automationConfigurationFingerprint } from './automation-intent.js';

const AUTOMATION_CONFIG_FILE = 'automations.json';

/** Home-relative persistent location; defaults to `STATION_HOME`. */
function automationConfigPath(homeDir: string = resolveHomeDir()): string {
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

/**
 * Mode changes and source enablement at an expected configuration
 * fingerprint. A rule input with `enabled` keeps the pre-#4509 meaning:
 * `true` sets `live`, `false` sets `off`.
 */
export type AutomationEnablementInput =
  | Readonly<{
      kind: 'source' | 'rule';
      id: string;
      expectedFingerprint: string;
      enabled: boolean;
    }>
  | Readonly<{
      kind: 'rule';
      id: string;
      expectedFingerprint: string;
      mode: AutomationRuleMode;
    }>;

/** The rule mode an enablement input requests; undefined for a source. */
export function requestedRuleMode(
  input: AutomationEnablementInput,
): AutomationRuleMode | undefined {
  if (input.kind !== 'rule') return undefined;
  if ('mode' in input) return input.mode;
  return input.enabled ? 'live' : 'off';
}

/**
 * Reads a pre-#4509 rule's `enabled: boolean` as `mode`. Only a rule with a
 * boolean `enabled` and no `mode` is rewritten; anything else is left for
 * validation to refuse, so a rule carrying both fields fails closed rather
 * than one silently winning.
 */
function migrateLegacyRuleModes(parsed: unknown): unknown {
  if (!isRecord(parsed) || !Array.isArray(parsed.rules)) return parsed;
  return {
    ...parsed,
    rules: parsed.rules.map((rule: unknown) => {
      if (
        !isRecord(rule) ||
        Object.hasOwn(rule, 'mode') ||
        typeof rule.enabled !== 'boolean'
      )
        return rule;
      const { enabled, ...rest } = rule;
      return { ...rest, mode: enabled ? 'live' : 'off' };
    }),
  };
}

/**
 * #4513: `notify` is no longer an action kind. A grant listing it granted
 * nothing that ever ran, so the stored grant drops it on read rather than
 * making the whole configuration unreadable. A stored `notify` rule is still
 * refused (fails closed): it named work Station never did.
 */
function dropRetiredNotifyGrants(parsed: unknown): unknown {
  if (!isRecord(parsed) || !Array.isArray(parsed.sources)) return parsed;
  return {
    ...parsed,
    sources: parsed.sources.map((source: unknown) => {
      if (!isRecord(source) || !Array.isArray(source.grants)) return source;
      return {
        ...source,
        grants: source.grants.map((grant: unknown) =>
          isRecord(grant) && Array.isArray(grant.actions)
            ? {
                ...grant,
                actions: grant.actions.filter(
                  (action: unknown) => action !== 'notify',
                ),
              }
            : grant,
        ),
      };
    }),
  };
}

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

function assertFingerprint(
  current: AutomationConfiguration,
  expected: string,
): void {
  if (automationConfigurationFingerprint(current) !== expected)
    throw new AutomationValidationError([
      'Automation configuration changed; refresh before changing it.',
    ]);
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
      const stat = lstatSync(this.path);
      if (stat.isSymbolicLink()) {
        throw new AutomationPolicyUnavailableError('store path is a symlink');
      }
      // The file holds webhook secrets. A mode looser than 0600 means
      // someone else may have read or written it, so refuse rather than
      // silently tighten. (The inbound-webhook store does not check; POSIX
      // modes carry no such meaning on Windows.)
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new AutomationPolicyUnavailableError('insecure permissions');
      }
      if (stat.size > AUTOMATION_EXECUTION_LIMITS.maxConfigurationBytes) {
        throw new AutomationPolicyUnavailableError('file too large');
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
    const migrated = dropRetiredNotifyGrants(migrateLegacyRuleModes(parsed));
    const problems = automationConfigurationProblems(migrated);
    if (problems.length > 0) {
      throw new AutomationPolicyUnavailableError(
        `invalid: ${problems.slice(0, 8).join('; ')}`,
      );
    }
    return migrated as AutomationConfiguration;
  }

  listSources(): AutomationSourceProjection[] {
    return this.read().sources.map(projectAutomationSource);
  }

  /**
   * Rules intake evaluates for one source: the rule is not `off`, its source
   * is enabled and not revoked, and the source still grants the rule's
   * action. Each rule keeps its `mode`; intake lets only `live` rules act.
   */
  actionableRules(sourceId: string): AutomationRule[] {
    const configuration = this.read();
    const source = configuration.sources.find(({ id }) => id === sourceId);
    if (!source) return [];
    return structuredClone(
      configuration.rules.filter(
        (rule) =>
          rule.sourceId === sourceId &&
          rule.mode !== 'off' &&
          sourceGrantsRuleAction(source, rule),
      ),
    );
  }

  /** Creates a disabled source with a server-issued id. */
  async createSource(
    input: CreateAutomationSourceInput,
    assertCurrent?: () => Promise<void>,
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
    await this.mutate(
      (current) => ({
        ...current,
        sources: [...current.sources, source],
      }),
      assertCurrent,
    );
    return {
      source: projectAutomationSource(source),
      ...(secret ? { secret } : {}),
    };
  }

  /**
   * Creates an `observe` rule with a server-issued id. Refused with
   * {@link AutomationValidationError} when its source does not grant the
   * rule's action.
   */
  async createRule(
    input: CreateAutomationRuleInput,
    assertCurrent?: () => Promise<void>,
  ): Promise<AutomationRule> {
    const rule: AutomationRule = {
      id: this.newId(),
      name: input.name,
      mode: 'observe',
      sourceId: input.sourceId,
      match: input.match,
      ...(input.episode ? { episode: input.episode } : {}),
      action: input.action,
      rateLimit: input.rateLimit,
    };
    await this.mutate((current) => {
      const source = current.sources.find(({ id }) => id === rule.sourceId);
      if (source?.revokedAt !== undefined) {
        throw new AutomationValidationError([
          `source ${rule.sourceId} is revoked`,
        ]);
      }
      return { ...current, rules: [...current.rules, rule] };
    }, assertCurrent);
    return structuredClone(rule);
  }

  async setEnabled(
    input: AutomationEnablementInput,
    assertCurrent?: () => Promise<void>,
  ): Promise<void> {
    const mode = requestedRuleMode(input);
    await this.mutate((current) => {
      assertFingerprint(current, input.expectedFingerprint);
      const records = input.kind === 'source' ? current.sources : current.rules;
      const record = records.find((record) => record.id === input.id);
      if (!record || ('revokedAt' in record && record.revokedAt !== undefined))
        throw new AutomationValidationError([
          'Automation identity unavailable.',
        ]);
      if (input.kind === 'source' && 'enabled' in input)
        return {
          ...current,
          sources: current.sources.map((source) =>
            source.id === input.id
              ? { ...source, enabled: input.enabled }
              : source,
          ),
        };
      if (mode === undefined)
        throw new AutomationValidationError(['Automation mode unavailable.']);
      return {
        ...current,
        rules: current.rules.map((rule) =>
          rule.id === input.id ? { ...rule, mode } : rule,
        ),
      };
    }, assertCurrent);
  }

  /**
   * Replaces a rule's operator-editable fields at an expected configuration
   * fingerprint (#4513). The id, source and mode are kept: a rule never moves
   * to another source, and only enable/disable change its mode. The action
   * kind may not change; `kinds` names the kinds this caller may edit.
   */
  async updateRule(
    input: Readonly<{
      id: string;
      expectedFingerprint: string;
      kinds: readonly AutomationRule['action']['kind'][];
      rule: Omit<CreateAutomationRuleInput, 'sourceId'>;
    }>,
    assertCurrent?: () => Promise<void>,
  ): Promise<AutomationRule> {
    let updated: AutomationRule | undefined;
    await this.mutate((current) => {
      assertFingerprint(current, input.expectedFingerprint);
      const existing = current.rules.find(({ id }) => id === input.id);
      if (
        !existing ||
        !input.kinds.includes(existing.action.kind) ||
        existing.action.kind !== input.rule.action.kind
      )
        throw new AutomationValidationError([
          'Automation rule unavailable for this edit.',
        ]);
      updated = {
        id: existing.id,
        name: input.rule.name,
        mode: existing.mode,
        sourceId: existing.sourceId,
        match: input.rule.match,
        ...(input.rule.episode ? { episode: input.rule.episode } : {}),
        action: input.rule.action,
        rateLimit: input.rule.rateLimit,
      };
      return {
        ...current,
        rules: current.rules.map((rule) =>
          rule.id === input.id ? updated! : rule,
        ),
      };
    }, assertCurrent);
    return structuredClone(updated!);
  }

  /**
   * Deletes a rule (#4513). Narrowing, so no fingerprint is required; one
   * given is still checked. A deleted rule's pending and running actions are
   * refused or stopped by their consumers on the next tick.
   */
  async deleteRule(
    input: Readonly<{
      id: string;
      expectedFingerprint?: string;
      kinds: readonly AutomationRule['action']['kind'][];
    }>,
    assertCurrent?: () => Promise<void>,
  ): Promise<void> {
    await this.mutate((current) => {
      if (input.expectedFingerprint !== undefined)
        assertFingerprint(current, input.expectedFingerprint);
      const existing = current.rules.find(({ id }) => id === input.id);
      if (!existing || !input.kinds.includes(existing.action.kind))
        throw new AutomationValidationError([
          'Automation rule unavailable for this edit.',
        ]);
      return {
        ...current,
        rules: current.rules.filter(({ id }) => id !== input.id),
      };
    }, assertCurrent);
  }

  /**
   * Deletes a source that no rule names (#4513); delete its rules first, so a
   * source never disappears from under a rule an operator still sees.
   */
  async deleteSource(
    input: Readonly<{ id: string; expectedFingerprint?: string }>,
    assertCurrent?: () => Promise<void>,
  ): Promise<void> {
    await this.mutate((current) => {
      if (input.expectedFingerprint !== undefined)
        assertFingerprint(current, input.expectedFingerprint);
      if (!current.sources.some(({ id }) => id === input.id))
        throw new AutomationValidationError(['Automation source unavailable.']);
      if (current.rules.some((rule) => rule.sourceId === input.id))
        throw new AutomationValidationError([
          'Delete the rules on this source first.',
        ]);
      return {
        ...current,
        sources: current.sources.filter(({ id }) => id !== input.id),
      };
    }, assertCurrent);
  }

  private async mutate(
    change: (current: AutomationConfiguration) => AutomationConfiguration,
    assertCurrent?: () => Promise<void>,
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
      await assertCurrent?.();
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
