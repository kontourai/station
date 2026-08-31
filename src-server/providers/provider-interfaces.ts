import type {
  ACPConnectionConfig,
  ACPConnectionRegistryEntry,
} from '@kontourai/station-contracts/acp';
import type {
  AuthStatus,
  RenewResult,
  UserDetailVM,
  UserIdentity,
} from '@kontourai/station-contracts/auth';
import type {
  InstallResult,
  RegistryItem,
} from '@kontourai/station-contracts/catalog';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ScheduleNotificationOpts } from '@kontourai/station-contracts/notification';
import type { PluginPreview } from '@kontourai/station-contracts/plugin';
import type { EngineId } from '@kontourai/station-contracts/provider';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import type {
  AddJobOpts,
  SchedulerCapability,
  SchedulerFormField,
  SchedulerJob,
  SchedulerLogEntry,
  SchedulerManualRunReceipt,
  SchedulerProviderStats,
  SchedulerProviderStatus,
} from '@kontourai/station-contracts/scheduler';
import type { Prerequisite, ToolDef } from '@kontourai/station-contracts/tool';
import type {
  WorkItemProviderCapabilities,
  WorkItemProviderIdentity,
  WorkItemProviderListResult,
} from '@kontourai/station-contracts/work-item-provider';
import type { ProviderAdapterShape } from './adapter-shape.js';

export interface IAgentRegistryProvider {
  listAvailable(): Promise<RegistryItem[]>;
  listInstalled(): Promise<RegistryItem[]>;
  install(id: string): Promise<InstallResult>;
  uninstall(id: string): Promise<InstallResult>;
  update?(id: string): Promise<InstallResult>;
}

export interface IIntegrationRegistryProvider {
  listAvailable(): Promise<RegistryItem[]>;
  listInstalled(): Promise<RegistryItem[]>;
  install(id: string): Promise<InstallResult>;
  uninstall(id: string): Promise<InstallResult>;
  getToolDef(id: string): Promise<ToolDef | null>;
  sync(): Promise<void>;
  installByCommand?(command: string): Promise<InstallResult>;
  update?(id: string): Promise<InstallResult>;
}

export interface ISkillRegistryProvider {
  listAvailable(): Promise<RegistryItem[]>;
  listInstalled(): Promise<RegistryItem[]>;
  install(id: string, targetDir: string): Promise<InstallResult>;
  uninstall(id: string, targetDir: string): Promise<InstallResult>;
  update?(id: string): Promise<InstallResult>;
  getContent?(id: string): Promise<string | null>;
}

export interface IPluginRegistryProvider {
  readonly registryKey?: string;
  listAvailable(): Promise<RegistryItem[]>;
  listInstalled(): Promise<RegistryItem[]>;
  resolveSource?(id: string): Promise<string | null>;
  /**
   * `expectedInstalledPluginName` is an identity assertion a caller supplies
   * when it has already committed to a specific `<plugins>/<name>` — an
   * update bound to a registry alias, or a dependency install that took that
   * path's content lock and will validate and possibly roll back that tree. A
   * provider derives its own write target from the manifest it fetched; when
   * the two disagree it must refuse BEFORE writing rather than rewrite a
   * different plugin's tree. Optional so a provider that cannot resolve a
   * name ahead of its write is still assignable; callers therefore treat it
   * as defence in depth, not as proof (archive#4309 follow-up review,
   * MEDIUM 3).
   */
  install(
    id: string,
    options?: { expectedInstalledPluginName?: string },
  ): Promise<InstallResult>;
  uninstall(id: string): Promise<InstallResult>;
  preview?(id: string): Promise<PluginPreview>;
  update?(id: string): Promise<InstallResult>;
}

export interface IAuthProvider {
  getStatus(): Promise<AuthStatus>;
  renew(): Promise<RenewResult>;
  getBadgePhoto?(id: string): Promise<ArrayBuffer | null>;
  getPrerequisites?(): Promise<Prerequisite[]>;
}

export interface IUserIdentityProvider {
  getIdentity(): Promise<UserIdentity>;
  enrichIdentity?(user: UserIdentity): Promise<UserIdentity>;
}

export interface IUserDirectoryProvider {
  lookupPerson(alias: string): Promise<UserDetailVM>;
  searchPeople(query: string): Promise<UserDetailVM[]>;
}

export interface IBrandingProvider {
  getAppName(): Promise<string>;
  getLogo?(): Promise<{ src: string; alt?: string } | null>;
  getTheme?(): Promise<Record<string, string> | null>;
  getWelcomeMessage?(): Promise<string | null>;
}

export interface ISettingsProvider {
  getDefaults(): Promise<Partial<AppConfig>>;
}

export interface ISchedulerProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: SchedulerCapability[];
  getFormFields?(): SchedulerFormField[];
  listJobs(): Promise<SchedulerJob[]>;
  addJob(opts: AddJobOpts): Promise<string>;
  editJob(target: string, opts: Record<string, unknown>): Promise<string>;
  removeJob(target: string): Promise<void>;
  /**
   * Legacy internally composed providers returned only user-facing output.
   * Keep that source-compatible while SchedulerService normalizes it to a
   * confirmed legacy result with no invented run identity or receipt.
   */
  runJob(target: string): Promise<string | SchedulerManualRunReceipt>;
  enableJob(target: string): Promise<void>;
  disableJob(target: string): Promise<void>;
  getJobLogs(target: string, count?: number): Promise<SchedulerLogEntry[]>;
  /** Durable receipts, including runs whose job definition was deleted. */
  listRunLogs?(): Promise<SchedulerLogEntry[]>;
  readRunFile?(path: string): Promise<string>;
  getStats(): Promise<SchedulerProviderStats>;
  getStatus(): Promise<SchedulerProviderStatus>;
  previewSchedule?(cron: string, count?: number): Promise<string[]>;
  subscribe?(send: (data: string) => void): () => void;
  getPrerequisites?(): Promise<Prerequisite[]>;
}

/** Context a work-item provider backend needs to resolve a project's
 * work items — the project id (for local-store scoping) and its
 * tilde-expanded workspace path (for settings-file / CLI resolution). */
export interface WorkItemProjectContext {
  projectId: string;
  workingDirectory: string;
}

/**
 * Work-item provider seam (roadmap archive#583, part of epic archive#580, S3). Follows the
 * `INotificationProvider` precedent: an additive provider interface
 * implemented by backends registered with `WorkItemProviderService`.
 * `listWorkItems` never throws for absence (no settings, no CLI, malformed
 * output) — it reports `available: false` with a `reason` instead; the
 * aggregator adds a defensive catch on top for genuine runtime errors.
 */
export interface IWorkItemProvider {
  readonly identity: WorkItemProviderIdentity;
  readonly capabilities: WorkItemProviderCapabilities;
  listWorkItems(
    context: WorkItemProjectContext,
  ): Promise<WorkItemProviderListResult>;
}

/** Additive forge integration seam. Providers are selected by their stable id. */
export type { IPullRequestProvider };

export interface INotificationProvider {
  readonly id: string;
  readonly displayName: string;
  readonly categories: string[];
  poll?(): Promise<ScheduleNotificationOpts[]>;
  /** Optional: emit status updates for previously-scheduled notifications.
   * Returned updates are matched by `dedupeTag` and applied via `markStatus`/`action`.
   */
  syncStatus?(): Promise<NotificationStatusUpdate[]>;
  handleAction?(
    notificationId: string,
    actionId: string,
    clientOrigin?: import('@kontourai/station-contracts/client-origin').ClientOrigin,
  ): Promise<void>;
  handleDismiss?(
    notificationId: string,
    clientOrigin?: import('@kontourai/station-contracts/client-origin').ClientOrigin,
  ): Promise<void>;
}

export interface NotificationStatusUpdate {
  /** Must match the `dedupeTag` used when the notification was originally scheduled. */
  dedupeTag: string;
  /** New status for the notification. */
  status: 'actioned' | 'expired' | 'dismissed';
  /** Optional: when `actioned`, which action was taken. */
  actionId?: string;
}

export interface ILayoutTypeProvider {
  readonly id: string;
  readonly displayName: string;
  readonly icon: string;
  getConfigSchema?(): unknown;
  getDefaultConfig(): Record<string, unknown>;
}

export interface IACPConnectionsProvider {
  getConnections(): ACPConnectionConfig[];
}

export interface IACPConnectionRegistryProvider {
  readonly id?: string;
  readonly displayName?: string;
  listAvailable(): ACPConnectionRegistryEntry[];
}

export interface Template {
  id: string;
  icon: string;
  label: string;
  description: string;
  type: 'agent' | 'layout';
  form: Record<string, any>;
  tabs?: Array<{ id: string; label: string; component: string }>;
  source?: string;
}

export interface ITemplateProvider {
  readonly id: string;
  readonly displayName: string;
  listTemplates(): Promise<Template[]>;
}

export interface IProviderAdapterRegistry {
  register(adapter: ProviderAdapterShape): void;
  get(provider: EngineId): ProviderAdapterShape | undefined;
  list(): ProviderAdapterShape[];
  onChange?(listener: () => void): () => void;
}

export type ProviderCardinality = 'singleton' | 'additive';

export const PROVIDER_TYPE_META: Record<string, ProviderCardinality> = {
  auth: 'singleton',
  userIdentity: 'singleton',
  userDirectory: 'singleton',
  branding: 'singleton',
  settings: 'singleton',
  scheduler: 'additive',
  agentRegistry: 'additive',
  integrationRegistry: 'additive',
  pluginRegistry: 'additive',
  acpConnections: 'additive',
  acpConnectionRegistry: 'additive',
  llmProvider: 'additive',
  embeddingProvider: 'additive',
  vectorDbProvider: 'additive',
  layoutType: 'additive',
  notification: 'additive',
  workItem: 'additive',
  pullRequest: 'additive',
  skillRegistry: 'additive',
  providerAdapter: 'additive',
};
