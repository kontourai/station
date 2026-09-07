/** Versioned contract for user-initiated work owned by one installed plugin. */
export const PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION =
  'station.plugin-foreground-work/v1' as const;

export const PLUGIN_FOREGROUND_WORK_LIMITS = {
  declarationsPerPlugin: 32,
  requiredCapabilitiesPerDeclaration: 16,
  inputBytes: 256 * 1024,
  inputDepth: 24,
  inputNodes: 8_192,
  idempotencyKeyBytes: 256,
} as const;

export type PluginForegroundWorkJson =
  | null
  | boolean
  | number
  | string
  | PluginForegroundWorkJson[]
  | { [key: string]: PluginForegroundWorkJson };

/** Inert declaration. Registration grants no authority to execute it. */
export interface PluginForegroundWorkDeclaration {
  readonly kind: string;
  readonly title: string;
  readonly requiredCapabilities: readonly string[];
  readonly cancellation: 'supported' | 'unsupported';
}

/** Plugin-authored intent. The host binds installation and account identity. */
export interface PluginForegroundWorkStartRequest {
  readonly schemaVersion: typeof PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly input: PluginForegroundWorkJson;
  readonly taskId?: string;
  readonly sessionId?: string;
}

export type PluginForegroundWorkState =
  | 'admitted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'indeterminate';

/** How far the owner is proved to have crossed its consequential boundary. */
export type PluginForegroundWorkEffectDepth =
  | 'uninvoked'
  | 'possible-effect'
  | 'confirmed-effect';

/** Safe public projection. It contains no input, idempotency key, or host key. */
export interface PluginForegroundRun {
  readonly schemaVersion: typeof PLUGIN_FOREGROUND_WORK_SCHEMA_VERSION;
  readonly runId: string;
  readonly pluginId: string;
  readonly installationGeneration: number;
  readonly kind: string;
  readonly state: PluginForegroundWorkState;
  readonly effectDepth: PluginForegroundWorkEffectDepth;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  /** Bounded public copy; never a worker exception or provider response body. */
  readonly failureSummary?: string;
}

export type PluginForegroundWorkStartOutcome =
  | { readonly kind: 'admitted'; readonly run: PluginForegroundRun }
  | { readonly kind: 'existing'; readonly run: PluginForegroundRun }
  | {
      readonly kind: 'refused';
      readonly reason:
        | 'invalid'
        | 'undeclared'
        | 'unauthorized'
        | 'authorization-unavailable'
        | 'idempotency-equivocation'
        | 'run-authority-unavailable';
    };

export type PluginForegroundWorkCancellationOutcome =
  | { readonly kind: 'confirmed'; readonly run: PluginForegroundRun }
  | { readonly kind: 'refused'; readonly run: PluginForegroundRun }
  | { readonly kind: 'unknown'; readonly run: PluginForegroundRun }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'unavailable' };
