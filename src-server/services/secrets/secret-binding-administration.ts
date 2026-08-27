import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DatumError,
  defaultSecretRunner,
  describeAuth,
  materializeAuthRef,
  parseAuthRef,
  type SecretRunner,
} from '@kontourai/station-contracts/datum-secret-reference';
import {
  type McpIntegrationEnvGrant,
  type SecretBinding,
  type SecretBindingDocument,
  type SecretBindingId,
  type SecretBindingView,
} from '@kontourai/station-contracts/secret-binding';
import {
  isSafeToolServerId,
  type ToolDef,
} from '@kontourai/station-contracts/tool';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import type { ConfigLoader } from '../../domain/config-loader.js';
import {
  publishJsonFileWithOwnedLock,
  readTextFileBounded,
} from '../../domain/file-storage-helpers.js';
import { secretBindingOperations } from '../../telemetry/metrics.js';

const FILE = 'secret-bindings.json';
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_BINDINGS = 512;
const MAX_GRANTS_PER_BINDING = 128;
const BINDING_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_BINDING_METRIC_OPERATIONS = new Set([
  'create',
  'replace',
  'bind',
  'unbind',
  'revoke',
  'materialize',
  'resolve',
  'establish',
]);

/** Stable, non-Datum conflict copy shared by the operator route. */
export const SECRET_BINDING_CONFLICT_MESSAGE =
  'The secret binding changed before this operation could commit.';

export class SecretBindingConflictError extends Error {
  constructor() {
    super(SECRET_BINDING_CONFLICT_MESSAGE);
    this.name = 'SecretBindingConflictError';
  }
}

/** Stable, non-Datum diagnostic that is safe to show outside the secret seam. */
export class SecretBindingResolutionError extends Error {
  constructor(
    readonly reason:
      | 'binding_missing'
      | 'binding_revoked'
      | 'grant_missing'
      | 'backend_unavailable'
      | 'secret_unavailable'
      | 'invalid_binding',
  ) {
    super('The integration secret binding cannot be established.');
    this.name = 'SecretBindingResolutionError';
  }
}

export interface SecretBindingAdministration {
  list(): Promise<SecretBindingView[]>;
  get(id: SecretBindingId): Promise<SecretBindingView | null>;
  create(input: {
    id: string;
    name: string;
    authRef: unknown;
  }): Promise<SecretBindingView>;
  replace(input: {
    id: SecretBindingId;
    name: string;
    authRef: unknown;
    expectedRevision: number;
  }): Promise<SecretBindingView>;
  grant(input: {
    id: SecretBindingId;
    grant: McpIntegrationEnvGrant;
    expectedRevision: number;
  }): Promise<SecretBindingView>;
  ungrant(input: {
    id: SecretBindingId;
    integrationId: string;
    envName: string;
    expectedRevision: number;
  }): Promise<SecretBindingView>;
  revoke(input: {
    id: SecretBindingId;
    expectedRevision: number;
  }): Promise<SecretBindingView>;
}

/** Narrow mutation authority for a legacy credential migration. */
export type IntegrationSecretBindingGranter = Pick<
  SecretBindingAdministration,
  'get' | 'grant'
>;

/**
 * The operator-facing half of a secret binding.  A grant and an integration
 * definition live in different durable stores, so this interface deliberately
 * makes the non-atomic outcome visible instead of pretending a rollback is
 * possible after one side has committed.
 */
export interface SecretBindingIntegrationAdministration {
  getIntegrationBindings(input: { integrationId: string }): Promise<{
    integrationId: string;
    secretEnvBindingIds: Record<string, string>;
  }>;
  bind(input: {
    id: SecretBindingId;
    integrationId: string;
    envName: string;
    expectedRevision: number;
  }): Promise<SecretBindingIntegrationOutcome>;
  unbind(input: {
    id: SecretBindingId;
    integrationId: string;
    envName: string;
    expectedRevision: number;
  }): Promise<SecretBindingIntegrationOutcome>;
}

export type SecretBindingIntegrationOutcome = {
  outcome: 'complete' | 'safe-partial';
  binding: SecretBindingView;
  integrationId: string;
  envName: string;
  /** A stable diagnostic; never an AuthRef or credential material. */
  configurationError?: string;
};

/**
 * Coordinates the two consumer records.  The binding authority owns CAS and
 * grants; ConfigLoader owns the integration document and its credential-store
 * boundary.  No raw integration route can author `secretEnvRefs`.
 */
export class SecretBindingIntegrationService
  implements SecretBindingIntegrationAdministration
{
  constructor(
    private readonly bindings: SecretBindingAdministration,
    private readonly configLoader: Pick<
      ConfigLoader,
      'loadIntegration' | 'updateIntegration' | 'isBuiltinIntegration'
    >,
    private readonly logger?: {
      info(message: string, attributes?: Record<string, unknown>): void;
    },
  ) {}

  async getIntegrationBindings(input: { integrationId: string }): Promise<{
    integrationId: string;
    secretEnvBindingIds: Record<string, string>;
  }> {
    const def = await this.configLoader.loadIntegration(input.integrationId);
    return {
      integrationId: input.integrationId,
      secretEnvBindingIds: { ...(def.secretEnvRefs ?? {}) },
    };
  }

  async bind(input: {
    id: SecretBindingId;
    integrationId: string;
    envName: string;
    expectedRevision: number;
  }): Promise<SecretBindingIntegrationOutcome> {
    try {
      return await this.bindInternal(input);
    } catch (error) {
      this.auditConsumerRefusal('bind', input, error);
      throw error;
    }
  }

  private async bindInternal(input: {
    id: SecretBindingId;
    integrationId: string;
    envName: string;
    expectedRevision: number;
  }): Promise<SecretBindingIntegrationOutcome> {
    const def = await this.assertConsumer(input.integrationId, input.envName);
    const configured = def.secretEnvRefs?.[input.envName];
    if (configured && configured !== input.id) {
      throw new Error(
        'The integration environment is already bound to a different secret binding.',
      );
    }
    const current = await this.requiredBindingAtRevision(
      input.id,
      input.expectedRevision,
    );
    // Grant FIRST: a config reference never becomes live unless the binding
    // authority has recorded permission for exactly this consumer/env pair.
    const alreadyGranted = current.grants.some(
      (grant) =>
        grant.integrationId === input.integrationId &&
        grant.envName === input.envName,
    );
    const binding = alreadyGranted
      ? current
      : await this.bindings.grant({
          id: input.id,
          expectedRevision: input.expectedRevision,
          grant: {
            kind: 'mcp-integration-env',
            integrationId: input.integrationId,
            envName: input.envName,
          },
        });
    try {
      await this.configLoader.updateIntegration(
        input.integrationId,
        (current) => ({
          ...current,
          secretEnvRefs: {
            ...(current.secretEnvRefs ?? {}),
            [input.envName]: input.id,
          },
        }),
      );
      const result = this.outcome(input, binding, 'complete');
      this.auditConsumer('bind', result, 'success');
      return result;
    } catch {
      const result = {
        ...this.outcome(input, binding, 'safe-partial'),
        configurationError:
          'The grant was saved, but the integration reference was not updated. Review and retry the binding operation.',
      };
      this.auditConsumer('bind', result, 'configuration_update_failed');
      return result;
    }
  }

  async unbind(input: {
    id: SecretBindingId;
    integrationId: string;
    envName: string;
    expectedRevision: number;
  }): Promise<SecretBindingIntegrationOutcome> {
    try {
      return await this.unbindInternal(input);
    } catch (error) {
      this.auditConsumerRefusal('unbind', input, error);
      throw error;
    }
  }

  private async unbindInternal(input: {
    id: SecretBindingId;
    integrationId: string;
    envName: string;
    expectedRevision: number;
  }): Promise<SecretBindingIntegrationOutcome> {
    const def = await this.assertConsumer(input.integrationId, input.envName);
    const configured = def.secretEnvRefs?.[input.envName];
    if (configured && configured !== input.id) {
      throw new Error(
        'The integration environment is bound to a different secret binding.',
      );
    }
    const current = await this.requiredBindingAtRevision(
      input.id,
      input.expectedRevision,
      { allowRevoked: true },
    );
    // Config FIRST: after this point the child cannot consume the binding,
    // even if the independent grant revocation fails.
    await this.configLoader.updateIntegration(
      input.integrationId,
      (current) => {
        const refs = { ...(current.secretEnvRefs ?? {}) };
        if (refs[input.envName] && refs[input.envName] !== input.id)
          throw new Error(
            'The integration environment is bound to a different secret binding.',
          );
        // Missing is an intentional retry state after config-first partial.
        if (!refs[input.envName]) return current;
        delete refs[input.envName];
        if (Object.keys(refs).length === 0)
          delete (current as ToolDef).secretEnvRefs;
        return Object.keys(refs).length > 0
          ? { ...current, secretEnvRefs: refs }
          : current;
      },
    );
    try {
      // Revocation is terminal: the retained grant is historical evidence,
      // not a live authorization. Config-first removal has already prevented
      // future child establishment, so do not try to mutate the terminal
      // binding merely to erase that audit history.
      if (current.revokedAt) {
        const result = this.outcome(input, current, 'complete');
        this.auditConsumer('unbind', result, 'revoked_binding_preserved');
        return result;
      }
      const hasGrant = current.grants.some(
        (grant) =>
          grant.integrationId === input.integrationId &&
          grant.envName === input.envName,
      );
      const binding = hasGrant ? await this.bindings.ungrant(input) : current;
      const result = this.outcome(input, binding, 'complete');
      this.auditConsumer('unbind', result, 'success');
      return result;
    } catch {
      const binding = await this.bindings.get(input.id);
      if (!binding)
        throw new Error('Secret binding not found after config update.');
      const result = {
        ...this.outcome(input, binding, 'safe-partial'),
        configurationError:
          'The integration reference was removed, but the grant could not be removed. Review and retry the unbind operation.',
      };
      this.auditConsumer('unbind', result, 'grant_update_failed');
      return result;
    }
  }

  private async assertConsumer(integrationId: string, envName: string) {
    assertIntegrationId(integrationId);
    assertEnvName(envName);
    const def = await this.configLoader.loadIntegration(integrationId);
    const transport = def.transport ?? (def.command ? 'stdio' : undefined);
    if (def.kind !== 'mcp' || transport !== 'stdio') {
      throw new Error(
        'Only stdio MCP integrations can consume secret bindings.',
      );
    }
    // Built-ins retain a runtime-owned spawn identity. The ConfigLoader gate
    // rejects refs too, but diagnosing before the grant keeps this operation
    // from creating a grant that can never be used.
    if (
      def.builtinPolicy ||
      this.configLoader.isBuiltinIntegration(integrationId)
    ) {
      throw new Error('Built-in integrations cannot consume secret bindings.');
    }
    const declared = new Set([
      ...Object.keys(def.env ?? {}),
      ...(def.storedEnvNames ?? []),
      ...Object.keys(def.secretEnvRefs ?? {}),
    ]);
    if (!declared.has(envName)) {
      throw new Error(
        'The integration does not declare this environment name.',
      );
    }
    return def;
  }

  private async requiredBindingAtRevision(
    id: SecretBindingId,
    expectedRevision: number,
    options: { allowRevoked?: boolean } = {},
  ): Promise<SecretBindingView> {
    const binding = await this.bindings.get(id);
    if (!binding) throw new Error('Secret binding not found.');
    if (binding.revokedAt && !options.allowRevoked)
      throw new Error('Secret binding is revoked.');
    if (binding.revision !== expectedRevision)
      throw new SecretBindingConflictError();
    return binding;
  }

  private outcome(
    input: { integrationId: string; envName: string },
    binding: SecretBindingView,
    outcome: 'complete' | 'safe-partial',
  ): SecretBindingIntegrationOutcome {
    return {
      binding,
      integrationId: input.integrationId,
      envName: input.envName,
      outcome,
    };
  }

  private auditConsumer(
    operation: 'bind' | 'unbind',
    result: SecretBindingIntegrationOutcome,
    reason: string,
  ): void {
    this.logger?.info('Secret binding audit', {
      operation,
      bindingId: result.binding.id,
      revision: result.binding.revision,
      backend: result.binding.availability.backend,
      integrationId: result.integrationId,
      envName: result.envName,
      outcome: result.outcome,
      reason,
    });
  }

  private auditConsumerRefusal(
    operation: 'bind' | 'unbind',
    input: { id: string; integrationId: string; envName: string },
    error: unknown,
  ): void {
    this.logger?.info('Secret binding audit', {
      operation,
      bindingId: input.id,
      integrationId: input.integrationId,
      envName: input.envName,
      outcome: 'refused',
      reason:
        error instanceof SecretBindingConflictError
          ? 'conflict'
          : 'invalid_request',
    });
  }
}

/**
 * Deliberately narrow child-establishment capability. It does not expose list,
 * get, mutation, a Datum runner, or a secret value cache to its callers.
 */
export interface IntegrationSecretResolver {
  resolveForIntegration(input: {
    integrationId: string;
    secretEnvRefs: Record<string, SecretBindingId>;
  }): Promise<IntegrationSecretResolution>;
}

/**
 * The only material-bearing result exposed to a fresh-child establishment.
 * Its settlement capability deliberately closes over a metadata snapshot;
 * callers cannot inspect or reconstruct a binding, AuthRef, or audit record.
 */
export interface IntegrationSecretResolution {
  environment: Record<string, string>;
  settlement: {
    settle(input: {
      outcome: 'success' | 'failure';
      reason?: 'child_establishment_failed';
    }): void;
  };
}

export interface SecretBindingServiceOptions {
  now?: () => Date;
  secretRunner?: SecretRunner;
  environment?: Record<string, string | undefined>;
  /** Durable audit sink. Payloads are deliberately metadata-only. */
  logger?: {
    info(message: string, attributes?: Record<string, unknown>): void;
  };
}

/**
 * The sole Station authority for secret-binding metadata. Its private file
 * adapter accepts only a regular, private document under STATION_HOME and
 * validates every persisted AuthRef through Datum before returning it.
 */
export class FileSecretBindingAdministration
  implements SecretBindingAdministration, IntegrationSecretResolver
{
  readonly #store: SecretBindingFileStore;
  readonly #now: () => Date;
  readonly #runner: SecretRunner;
  readonly #environment: Record<string, string | undefined>;
  readonly #logger?: SecretBindingServiceOptions['logger'];

  constructor(homeDir: string, options: SecretBindingServiceOptions = {}) {
    this.#store = new SecretBindingFileStore(homeDir);
    this.#now = options.now ?? (() => new Date());
    this.#runner = options.secretRunner ?? defaultSecretRunner;
    this.#environment = options.environment ?? process.env;
    this.#logger = options.logger;
  }

  async list(): Promise<SecretBindingView[]> {
    const document = this.#store.read();
    return Object.values(document.bindings)
      .map((binding) => this.#view(binding))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: SecretBindingId): Promise<SecretBindingView | null> {
    assertBindingId(id);
    const binding = this.#store.read().bindings[id];
    return binding ? this.#view(binding) : null;
  }

  async create(input: {
    id: string;
    name: string;
    authRef: unknown;
  }): Promise<SecretBindingView> {
    return this.#adminOperation('create', { bindingId: input.id }, async () => {
      assertBindingId(input.id);
      const name = validName(input.name);
      const authRef = parseAuthRef(input.authRef);
      const created = await this.#store.mutate((document) => {
        if (document.bindings[input.id]) {
          throw new Error('A secret binding with this id already exists.');
        }
        if (Object.keys(document.bindings).length >= MAX_BINDINGS) {
          throw new Error('The secret binding limit has been reached.');
        }
        const timestamp = this.#now().toISOString();
        const binding: SecretBinding = {
          id: input.id,
          name,
          authRef,
          revision: 1,
          grants: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        return { document: withBinding(document, binding), result: binding };
      });
      this.#audit('create', {
        bindingId: created.id,
        revision: created.revision,
        backend: authBackend(created.authRef),
        outcome: 'success',
      });
      return this.#view(created);
    });
  }

  async replace(input: {
    id: SecretBindingId;
    name: string;
    authRef: unknown;
    expectedRevision: number;
  }): Promise<SecretBindingView> {
    return this.#adminOperation(
      'replace',
      { bindingId: input.id },
      async () => {
        assertBindingId(input.id);
        assertRevision(input.expectedRevision);
        const name = validName(input.name);
        const authRef = parseAuthRef(input.authRef);
        const replaced = await this.#store.mutate((document) => {
          const current = requiredActiveBinding(
            document,
            input.id,
            input.expectedRevision,
          );
          const next = {
            ...current,
            name,
            authRef,
            revision: current.revision + 1,
            updatedAt: this.#now().toISOString(),
          };
          return { document: withBinding(document, next), result: next };
        });
        this.#audit('replace', {
          bindingId: replaced.id,
          revision: replaced.revision,
          backend: authBackend(replaced.authRef),
          outcome: 'success',
        });
        return this.#view(replaced);
      },
    );
  }

  async grant(input: {
    id: SecretBindingId;
    grant: McpIntegrationEnvGrant;
    expectedRevision: number;
  }): Promise<SecretBindingView> {
    return this.#adminOperation(
      'bind',
      {
        bindingId: input.id,
        integrationId: input.grant.integrationId,
        envName: input.grant.envName,
      },
      async () => {
        assertBindingId(input.id);
        assertRevision(input.expectedRevision);
        assertGrant(input.grant);
        const granted = await this.#store.mutate((document) => {
          const current = requiredActiveBinding(
            document,
            input.id,
            input.expectedRevision,
          );
          const alreadyGranted = current.grants.some(
            (grant) =>
              grant.integrationId === input.grant.integrationId &&
              grant.envName === input.grant.envName,
          );
          if (alreadyGranted)
            throw new Error('The integration environment is already granted.');
          if (current.grants.length >= MAX_GRANTS_PER_BINDING) {
            throw new Error('The secret binding grant limit has been reached.');
          }
          const next = {
            ...current,
            grants: [...current.grants, { ...input.grant }].sort(compareGrant),
            revision: current.revision + 1,
            updatedAt: this.#now().toISOString(),
          };
          return { document: withBinding(document, next), result: next };
        });
        this.#audit('bind', {
          bindingId: granted.id,
          integrationId: input.grant.integrationId,
          envName: input.grant.envName,
          revision: granted.revision,
          backend: authBackend(granted.authRef),
          outcome: 'success',
        });
        return this.#view(granted);
      },
    );
  }

  async ungrant(input: {
    id: SecretBindingId;
    integrationId: string;
    envName: string;
    expectedRevision: number;
  }): Promise<SecretBindingView> {
    return this.#adminOperation(
      'unbind',
      {
        bindingId: input.id,
        integrationId: input.integrationId,
        envName: input.envName,
      },
      async () => {
        assertBindingId(input.id);
        assertRevision(input.expectedRevision);
        assertIntegrationId(input.integrationId);
        assertEnvName(input.envName);
        const ungranted = await this.#store.mutate((document) => {
          const current = requiredActiveBinding(
            document,
            input.id,
            input.expectedRevision,
          );
          const grants = current.grants.filter(
            (grant) =>
              grant.integrationId !== input.integrationId ||
              grant.envName !== input.envName,
          );
          if (grants.length === current.grants.length) {
            throw new Error(
              'The integration environment grant does not exist.',
            );
          }
          const next = {
            ...current,
            grants,
            revision: current.revision + 1,
            updatedAt: this.#now().toISOString(),
          };
          return { document: withBinding(document, next), result: next };
        });
        this.#audit('unbind', {
          bindingId: ungranted.id,
          integrationId: input.integrationId,
          envName: input.envName,
          revision: ungranted.revision,
          backend: authBackend(ungranted.authRef),
          outcome: 'success',
        });
        return this.#view(ungranted);
      },
    );
  }

  async revoke(input: {
    id: SecretBindingId;
    expectedRevision: number;
  }): Promise<SecretBindingView> {
    return this.#adminOperation('revoke', { bindingId: input.id }, async () => {
      assertBindingId(input.id);
      assertRevision(input.expectedRevision);
      const revoked = await this.#store.mutate((document) => {
        const current = requiredActiveBinding(
          document,
          input.id,
          input.expectedRevision,
        );
        const timestamp = this.#now().toISOString();
        const next = {
          ...current,
          revision: current.revision + 1,
          revokedAt: timestamp,
          updatedAt: timestamp,
        };
        return { document: withBinding(document, next), result: next };
      });
      this.#audit('revoke', {
        bindingId: revoked.id,
        revision: revoked.revision,
        backend: authBackend(revoked.authRef),
        outcome: 'success',
      });
      return this.#view(revoked);
    });
  }

  async resolveForIntegration(input: {
    integrationId: string;
    secretEnvRefs: Record<string, SecretBindingId>;
  }): Promise<IntegrationSecretResolution> {
    try {
      assertIntegrationId(input.integrationId);
      const entries = Object.entries(input.secretEnvRefs);
      if (entries.length > MAX_GRANTS_PER_BINDING) {
        throw new SecretBindingResolutionError('invalid_binding');
      }
      const document = this.#store.read();
      const values = new Map<string, string>();
      const resolved: Record<string, string> = Object.create(null);
      const consumers: Array<{
        bindingId: string;
        integrationId: string;
        envName: string;
        revision: number;
        backend: string;
      }> = [];
      for (const [envName, id] of entries) {
        try {
          assertEnvName(envName);
          assertBindingId(id);
        } catch {
          throw new SecretBindingResolutionError('invalid_binding');
        }
        const binding = document.bindings[id];
        if (!binding) throw new SecretBindingResolutionError('binding_missing');
        if (binding.revokedAt)
          throw new SecretBindingResolutionError('binding_revoked');
        if (
          !binding.grants.some(
            (grant) =>
              grant.integrationId === input.integrationId &&
              grant.envName === envName,
          )
        ) {
          throw new SecretBindingResolutionError('grant_missing');
        }
        let value = values.get(id);
        if (value === undefined) {
          try {
            value = materializeAuthRef(binding.authRef, {
              env: this.#environment,
              secretRunner: this.#runner,
            });
          } catch (error) {
            if (error instanceof DatumError) {
              throw new SecretBindingResolutionError(
                error.code === 'SECRET_BACKEND_UNAVAILABLE'
                  ? 'backend_unavailable'
                  : 'secret_unavailable',
              );
            }
            throw new SecretBindingResolutionError('secret_unavailable');
          }
          values.set(id, value);
          this.#audit('materialize', {
            bindingId: id,
            integrationId: input.integrationId,
            envName,
            revision: binding.revision,
            backend: authBackend(binding.authRef),
            outcome: 'success',
          });
        }
        resolved[envName] = value;
        consumers.push({
          bindingId: id,
          integrationId: input.integrationId,
          envName,
          revision: binding.revision,
          backend: authBackend(binding.authRef),
        });
      }
      this.#audit('resolve', {
        integrationId: input.integrationId,
        consumers: new Set(Object.values(input.secretEnvRefs)).size,
        outcome: 'success',
      });
      let settled = false;
      return {
        environment: resolved,
        settlement: {
          settle: ({ outcome, reason }) => {
            if (settled) return;
            settled = true;
            for (const consumer of consumers) {
              this.#audit('establish', {
                ...consumer,
                outcome,
                ...(outcome === 'failure' && reason ? { reason } : {}),
              });
            }
          },
        },
      };
    } catch (error) {
      const reason =
        error instanceof SecretBindingResolutionError
          ? error.reason
          : 'secret_unavailable';
      this.#audit('auth-refusal', {
        integrationId: input.integrationId,
        outcome: 'refused',
        reason,
      });
      throw error instanceof SecretBindingResolutionError
        ? error
        : new SecretBindingResolutionError(reason);
    }
  }

  async #adminOperation<T>(
    operation: string,
    identifiers: Record<string, unknown>,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      this.#audit(operation, {
        ...safeAuditIdentifiers(identifiers),
        outcome: 'refused',
        reason:
          error instanceof SecretBindingConflictError
            ? 'conflict'
            : 'invalid_request',
      });
      throw error;
    }
  }

  #audit(operation: string, attributes: Record<string, unknown>): void {
    this.#logger?.info('Secret binding audit', { operation, ...attributes });
    const metricOperation =
      operation === 'auth-refusal'
        ? 'resolve'
        : SECRET_BINDING_METRIC_OPERATIONS.has(operation)
          ? operation
          : 'other';
    const metricOutcome =
      attributes.outcome === 'success' ||
      attributes.outcome === 'failure' ||
      attributes.outcome === 'refused'
        ? attributes.outcome
        : 'refused';
    secretBindingOperations.add(1, {
      operation: metricOperation,
      outcome: metricOutcome,
    });
  }

  #view(binding: SecretBinding): SecretBindingView {
    const availability = describeAuth(
      binding.authRef,
      this.#environment,
      this.#runner,
    );
    return {
      ...binding,
      grants: binding.grants.map((grant) => ({ ...grant })),
      availability: {
        backend: availability.kind,
        available: availability.available,
      },
    };
  }
}

class SecretBindingFileStore {
  readonly #directory: string;
  readonly #file: string;

  constructor(homeDir: string) {
    this.#directory = join(homeDir, 'security');
    this.#file = join(this.#directory, FILE);
  }

  read(): SecretBindingDocument {
    this.#assertDirectory(false);
    if (!existsSync(this.#file)) return emptyDocument();
    assertPrivateRegularFile(this.#file, 'secret binding store');
    try {
      // This opens and fstats the descriptor before allocating, then reads no
      // more than the bounded number of bytes even if a concurrent writer
      // grows the file after that first check.
      return validateDocument(
        JSON.parse(
          readTextFileBounded(
            this.#file,
            MAX_DOCUMENT_BYTES,
            'Secret binding store',
          ),
        ),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Secret binding store exceeds the byte limit.'
      ) {
        throw error;
      }
      throw new Error('Secret binding store is invalid.');
    }
  }

  async mutate<T>(
    update: (document: SecretBindingDocument) => {
      document: SecretBindingDocument;
      result: T;
    },
  ): Promise<T> {
    // The lock file lives in the owned security directory, so establish and
    // validate that directory before asking the shared lock adapter to create
    // its temporary entry. Revalidate after ownership below.
    this.#assertDirectory(true);
    const release = await acquireFileMutationLockAsync(
      `${this.#file}.mutation`,
    );
    try {
      this.#assertDirectory(true);
      const current = this.read();
      const next = update(current);
      const validated = validateDocument(next.document);
      await publishJsonFileWithOwnedLock(this.#file, validated, {
        maxBytes: MAX_DOCUMENT_BYTES,
        label: 'Secret binding store',
        beforeCommit: () => this.#assertDirectory(true),
      });
      return next.result;
    } finally {
      await release();
    }
  }

  #assertDirectory(create: boolean): void {
    if (!existsSync(this.#directory)) {
      if (!create) return;
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    }
    const entry = lstatSync(this.#directory);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)
    ) {
      throw new Error('Unsafe secret binding directory.');
    }
  }
}

function emptyDocument(): SecretBindingDocument {
  return { schemaVersion: 1, bindings: Object.create(null) };
}

function validateDocument(value: unknown): SecretBindingDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error();
  const raw = value as Partial<SecretBindingDocument>;
  assertOnlyKeys(raw, ['schemaVersion', 'bindings']);
  if (
    raw.schemaVersion !== 1 ||
    !raw.bindings ||
    typeof raw.bindings !== 'object' ||
    Array.isArray(raw.bindings)
  )
    throw new Error();
  const bindings: Record<string, SecretBinding> = Object.create(null);
  const entries = Object.entries(raw.bindings);
  if (entries.length > MAX_BINDINGS) throw new Error();
  for (const [id, candidate] of entries) {
    assertBindingId(id);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error();
    const binding = candidate as Partial<SecretBinding>;
    assertOnlyKeys(binding, [
      'id',
      'name',
      'authRef',
      'revision',
      'grants',
      'createdAt',
      'updatedAt',
      'revokedAt',
    ]);
    if (
      binding.id !== id ||
      typeof binding.name !== 'string' ||
      validName(binding.name) !== binding.name ||
      !Number.isSafeInteger(binding.revision) ||
      binding.revision! < 1 ||
      typeof binding.createdAt !== 'string' ||
      typeof binding.updatedAt !== 'string' ||
      !Array.isArray(binding.grants)
    )
      throw new Error();
    assertTimestamp(binding.createdAt);
    assertTimestamp(binding.updatedAt);
    if (binding.revokedAt !== undefined) {
      if (typeof binding.revokedAt !== 'string') throw new Error();
      assertTimestamp(binding.revokedAt);
    }
    const grants = binding.grants.map((grant) => {
      assertExactGrant(grant);
      return {
        kind: 'mcp-integration-env' as const,
        integrationId: grant.integrationId,
        envName: grant.envName,
      };
    });
    if (
      grants.length > MAX_GRANTS_PER_BINDING ||
      new Set(
        grants.map((grant) => `${grant.integrationId}\u0000${grant.envName}`),
      ).size !== grants.length
    )
      throw new Error();
    bindings[id] = {
      id,
      name: binding.name,
      authRef: parseAuthRef(binding.authRef),
      revision: binding.revision!,
      grants: grants.sort(compareGrant),
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
      ...(binding.revokedAt ? { revokedAt: binding.revokedAt } : {}),
    };
  }
  return { schemaVersion: 1, bindings };
}

function assertOnlyKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error();
  }
}

function requiredActiveBinding(
  document: SecretBindingDocument,
  id: string,
  expectedRevision: number,
): SecretBinding {
  const binding = document.bindings[id];
  if (!binding) throw new Error('Secret binding not found.');
  if (binding.revokedAt) throw new Error('Secret binding is revoked.');
  if (binding.revision !== expectedRevision)
    throw new SecretBindingConflictError();
  return binding;
}

function withBinding(
  document: SecretBindingDocument,
  binding: SecretBinding,
): SecretBindingDocument {
  return {
    ...document,
    bindings: { ...document.bindings, [binding.id]: binding },
  };
}

function assertPrivateRegularFile(path: string, label: string): void {
  const entry = lstatSync(path);
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)
  )
    throw new Error(`Unsafe ${label}.`);
}

function authBackend(
  authRef: { env: string } | { keychain: unknown } | { op: string },
): string {
  if ('env' in authRef) return 'env';
  if ('keychain' in authRef) return 'keychain';
  return 'op';
}

function safeAuditIdentifiers(
  input: Record<string, unknown>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 128 &&
      /^[A-Za-z0-9_.-]+$/.test(value)
    ) {
      output[key] = value;
    }
  }
  return output;
}

function assertBindingId(value: string): asserts value is SecretBindingId {
  if (typeof value !== 'string' || !BINDING_ID.test(value))
    throw new Error('Invalid secret binding id.');
}
function validName(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 120 ||
    value.trim() !== value
  )
    throw new Error('Invalid secret binding name.');
  return value;
}
function assertIntegrationId(value: string): void {
  if (
    typeof value !== 'string' ||
    !isSafeToolServerId(value) ||
    value.length > 128
  )
    throw new Error('Invalid integration id.');
}
function assertEnvName(value: string): void {
  if (typeof value !== 'string' || !ENV_NAME.test(value))
    throw new Error('Invalid integration environment name.');
}
function assertGrant(grant: McpIntegrationEnvGrant): void {
  if (grant?.kind !== 'mcp-integration-env')
    throw new Error('Invalid secret binding grant.');
  assertIntegrationId(grant.integrationId);
  assertEnvName(grant.envName);
}
function assertExactGrant(
  grant: unknown,
): asserts grant is McpIntegrationEnvGrant {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant))
    throw new Error('Invalid secret binding grant.');
  assertOnlyKeys(grant, ['kind', 'integrationId', 'envName']);
  assertGrant(grant as McpIntegrationEnvGrant);
}
function assertRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('Invalid secret binding revision.');
}
function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error('Invalid secret binding timestamp.');
}
function compareGrant(
  a: McpIntegrationEnvGrant,
  b: McpIntegrationEnvGrant,
): number {
  return (
    a.integrationId.localeCompare(b.integrationId) ||
    a.envName.localeCompare(b.envName)
  );
}
