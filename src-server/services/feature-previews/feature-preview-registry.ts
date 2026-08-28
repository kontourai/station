/**
 * Runtime-derived Feature Previews registry (archive#2961).
 *
 * A preview becomes visible only when runtime composition binds a consumer.
 * A bound consumer returns the selector used at its real branch; persistence
 * alone can never make a removed consumer visible.
 */

import { join } from 'node:path';
import type { Logger } from '../../utils/logger.js';
import {
  GrantsFileStore,
  GrantsStoreUnavailableError,
  isPlainObject,
} from '../plugins/grants-file-store.js';

export interface FeaturePreviewDefinition {
  id: string;
  label: string;
  description: string;
  defaultEnabled?: boolean;
}

export interface FeaturePreview extends FeaturePreviewDefinition {
  enabled: boolean;
}

/** A live branch selector owned by one runtime consumer. */
export interface FeaturePreviewSelector {
  select<T>(branches: { enabled: () => T; disabled: () => T }): T;
}

type FeaturePreviewState = Record<string, { enabled: boolean }>;

export class FeaturePreviewStateUnavailableError extends GrantsStoreUnavailableError {
  constructor(
    storePath: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(storePath, detail, options);
    this.name = 'FeaturePreviewStateUnavailableError';
  }
}

export class FeaturePreviewNotOfferedError extends Error {
  constructor(id: string) {
    super(`Feature preview '${id}' is not currently offered.`);
    this.name = 'FeaturePreviewNotOfferedError';
  }
}

export function featurePreviewStatePath(homeDir: string): string {
  return join(homeDir, 'config', 'feature-previews.json');
}

function stateProblems(value: unknown): string[] {
  if (!isPlainObject(value)) return ['must be an object keyed by preview id'];
  const problems: string[] = [];
  for (const [id, entry] of Object.entries(value)) {
    if (!isPlainObject(entry) || typeof entry.enabled !== 'boolean') {
      problems.push(`${id}: must contain a boolean enabled value`);
    }
  }
  return problems;
}

/**
 * Owns persisted operator choices and the ephemeral set of live consumers.
 * The latter intentionally is not persisted: persistence may remember a
 * choice, but it can never make a removed consumer appear in the UI.
 */
export class FeaturePreviewRegistry {
  private readonly consumers = new Map<string, FeaturePreviewDefinition>();
  private readonly state: GrantsFileStore<FeaturePreviewState>;

  constructor(
    homeDir: string,
    private readonly logger: Logger,
  ) {
    this.state = new GrantsFileStore<FeaturePreviewState>({
      filePath: featurePreviewStatePath(homeDir),
      storeLabel: 'feature-previews',
      shapeProblems: stateProblems,
      makeUnavailableError: (path, detail, cause) =>
        new FeaturePreviewStateUnavailableError(path, detail, { cause }),
      emptyValue: {},
    });
  }

  /**
   * Bind a real runtime consumer during composition and return its live
   * branch selector. There is no catalog API: removing this binding removes
   * the consumer from the offered previews, while selection still reads the
   * current persisted choice at the consuming branch.
   */
  bind(definition: FeaturePreviewDefinition): FeaturePreviewSelector {
    this.rememberConsumer(definition);
    return {
      select: <T>(branches: { enabled: () => T; disabled: () => T }): T => {
        if (this.enabledForRuntime(definition)) return branches.enabled();
        return branches.disabled();
      },
    };
  }

  list(): FeaturePreview[] {
    const state = this.state.read();
    return [...this.consumers.values()].map((definition) => ({
      ...definition,
      enabled:
        state[definition.id]?.enabled ?? definition.defaultEnabled === true,
    }));
  }

  async setEnabled(id: string, enabled: boolean): Promise<FeaturePreview> {
    const definition = this.consumers.get(id);
    if (!definition) throw new FeaturePreviewNotOfferedError(id);
    await this.state.mutate(id, (current) => {
      current[id] = { enabled };
      return current;
    });
    this.logger.info('Feature preview updated', { id, enabled });
    return { ...definition, enabled };
  }

  private rememberConsumer(definition: FeaturePreviewDefinition): void {
    const current = this.consumers.get(definition.id);
    if (current && JSON.stringify(current) !== JSON.stringify(definition)) {
      throw new Error(
        `Feature preview '${definition.id}' was consumed with conflicting definitions.`,
      );
    }
    this.consumers.set(definition.id, { ...definition });
  }

  private enabledForRuntime(definition: FeaturePreviewDefinition): boolean {
    try {
      return (
        this.state.read()[definition.id]?.enabled ??
        definition.defaultEnabled === true
      );
    } catch (error) {
      // A corrupt optional-preview store must never enable work that spends a
      // peer's resources. The route still surfaces the read failure instead
      // of pretending the catalog is genuinely empty.
      this.logger.error(
        'Feature preview state is unavailable; disabling preview',
        {
          id: definition.id,
          error,
        },
      );
      return false;
    }
  }
}
