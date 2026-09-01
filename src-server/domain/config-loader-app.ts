import { randomUUID } from 'node:crypto';
import { renameSync, statSync } from 'node:fs';
import { chmod, mkdir, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  INTERNAL_APP_CONFIG_FIELDS,
  NULLABLE_APP_CONFIG_KEYS,
} from '@kontourai/station-contracts/settings-registry';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { assertSafeContextText } from '../services/orchestration/context-safety.js';
import { validator } from './validator.js';

export const DEFAULT_SYSTEM_PROMPT = [
  'You are {{AGENT_NAME}}, a helpful AI assistant.',
  '',
  'Be concise and direct. When you lack information, say so rather than guessing.',
  '',
  '## Environment',
  'Date: {{date}}',
  'Time: {{time}}',
].join('\n');

const DEFAULT_TEMPLATE_VARIABLES = [
  { key: 'AGENT_NAME', type: 'static' as const, value: 'Station' },
];

export const DEFAULT_MODEL = '';
const LEGACY_DEFAULT_MODELS = new Set([
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-sonnet-4-20250514-v1:0',
]);
const DEFAULT_INVOKE_MODEL = '';
const DEFAULT_STRUCTURE_MODEL = '';
export const APP_CONFIG_MAX_BYTES = 2 * 1024 * 1024;
const APP_CONFIG_LOAD_MAX_ATTEMPTS = 8;

function getAppConfigPath(projectHomeDir: string): string {
  return join(projectHomeDir, 'config', 'app.json');
}

export class AppConfigConflictError extends Error {
  constructor() {
    super('App configuration changed before the update could commit.');
    this.name = 'AppConfigConflictError';
  }
}

export async function appConfigFileSignature(
  projectHomeDir: string,
): Promise<string | null> {
  try {
    const stats = await stat(getAppConfigPath(projectHomeDir), {
      bigint: true,
    });
    return [
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function appConfigFileSignatureSync(projectHomeDir: string): string | null {
  try {
    const stats = statSync(getAppConfigPath(projectHomeDir), {
      bigint: true,
    });
    return [
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
    ].join(':');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertSafeAppConfig(config: AppConfig): void {
  if (
    typeof config.systemPrompt === 'string' &&
    config.systemPrompt.length > 0
  ) {
    assertSafeContextText(config.systemPrompt, {
      source: 'app system prompt',
    });
  }
}

async function readAppConfigBounded(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    if ((await handle.stat()).size > APP_CONFIG_MAX_BYTES) {
      throw new Error('app config exceeds the byte limit.');
    }
    const bytes = Buffer.alloc(APP_CONFIG_MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > APP_CONFIG_MAX_BYTES) {
      throw new Error('app config exceeds the byte limit.');
    }
    return bytes.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface AppConfigFileMutationOptions {
  expectedSourceSignature?: string | null;
  /**
   * The caller already owns this app file's mutation lock. This is only for
   * ConfigLoader's read-derive-write authority, so load-time migration can
   * persist without trying to acquire its own non-reentrant lock.
   */
  mutationLockHeld?: boolean;
}

export async function saveAppConfigFile(
  projectHomeDir: string,
  config: AppConfig,
  options: AppConfigFileMutationOptions = {},
): Promise<void> {
  validator.validateAppConfig(config);
  assertSafeAppConfig(config);

  const path = getAppConfigPath(projectHomeDir);
  const configDirectory = join(projectHomeDir, 'config');
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });
  await chmod(configDirectory, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(config, null, 2);
  if (Buffer.byteLength(serialized) > APP_CONFIG_MAX_BYTES) {
    throw new Error('app config exceeds the byte limit.');
  }
  try {
    const temporary = await open(temporaryPath, 'wx', 0o600);
    try {
      await temporary.writeFile(serialized, 'utf-8');
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    const commit = (): void => {
      if (
        Object.hasOwn(options, 'expectedSourceSignature') &&
        appConfigFileSignatureSync(projectHomeDir) !==
          options.expectedSourceSignature
      ) {
        throw new AppConfigConflictError();
      }
      renameSync(temporaryPath, path);
    };
    if (options.mutationLockHeld) {
      commit();
      return;
    }
    // Async acquisition (archive#2646): a contended cross-process lock wait must not
    // freeze the server's event loop. The held section stays synchronous.
    const release = await acquireFileMutationLockAsync(`${path}.mutation`);
    try {
      commit();
    } finally {
      await release();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function loadAppConfigFile(
  projectHomeDir: string,
  options: Pick<AppConfigFileMutationOptions, 'mutationLockHeld'> = {},
): Promise<AppConfig> {
  const path = getAppConfigPath(projectHomeDir);
  for (let attempt = 0; attempt < APP_CONFIG_LOAD_MAX_ATTEMPTS; attempt += 1) {
    const sourceSignature = await appConfigFileSignature(projectHomeDir);
    if (sourceSignature === null) {
      const defaultConfig: AppConfig = {
        defaultModel: DEFAULT_MODEL,
        invokeModel: DEFAULT_INVOKE_MODEL,
        structureModel: DEFAULT_STRUCTURE_MODEL,
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        templateVariables: [...DEFAULT_TEMPLATE_VARIABLES],
        // The ONLY place `pending` is ever written (UX audit RT-02). This
        // branch runs when there is no `config/app.json` at all, i.e. for a
        // home being created right now — so `pending` means exactly "this
        // home is new and nobody has answered the first-run chapter yet".
        //
        // Deliberately NOT a self-healing back-fill like the migrations
        // below: adding the field to an EXISTING home would claim a home
        // already in use had never been set up, and re-run the guided chapter
        // on every Station that upgrades. Absent stays absent, and the UI
        // reads absent as "not offered" (`resolveFirstRunOffer`).
        firstRun: { status: 'pending' },
      };
      try {
        await saveAppConfigFile(projectHomeDir, defaultConfig, {
          expectedSourceSignature: null,
          mutationLockHeld: options.mutationLockHeld,
        });
        return defaultConfig;
      } catch (error) {
        if (error instanceof AppConfigConflictError) continue;
        throw error;
      }
    }

    const content = await readAppConfigBounded(path);
    if ((await appConfigFileSignature(projectHomeDir)) !== sourceSignature) {
      continue;
    }
    const data = JSON.parse(content) as AppConfig & {
      templateVariables?: Array<{ key: string }>;
    };
    let shouldPersist = false;

    // station#settings-revamp slice-1 fix (finding 1): purge any
    // runtime-derived field that ended up persisted in the file — e.g. a
    // client that GETs `/config/app` (which injects `mcpUiFrameOrigin`/
    // `managedChatOrchestration`) and PUTs the response straight back,
    // before `sanitizeAppConfigUpdate` existed to strip them. Self-healing,
    // same pattern as the migrations below: delete on read, persist once.
    // Without this, a polluted file leaks a stale `managedChatOrchestration:
    // true` back out of GET even with the live feature flag off, and the
    // sanitizer (which now always ignores these keys on PUT) can never be
    // used to clear it.
    for (const internalKey of INTERNAL_APP_CONFIG_FIELDS) {
      if (data[internalKey] !== undefined) {
        delete data[internalKey];
        shouldPersist = true;
      }
    }

    if (
      LEGACY_DEFAULT_MODELS.has(data.defaultModel || '') &&
      !data.defaultLLMProvider
    ) {
      data.defaultModel = DEFAULT_MODEL;
      shouldPersist = true;
    }
    if (typeof data.invokeModel !== 'string') {
      data.invokeModel = DEFAULT_INVOKE_MODEL;
      shouldPersist = true;
    }
    if (typeof data.structureModel !== 'string') {
      data.structureModel = DEFAULT_STRUCTURE_MODEL;
      shouldPersist = true;
    }
    if (!data.systemPrompt) {
      data.systemPrompt = DEFAULT_SYSTEM_PROMPT;
      if (!data.templateVariables?.some((v) => v.key === 'AGENT_NAME')) {
        data.templateVariables = [
          ...(data.templateVariables || []),
          ...DEFAULT_TEMPLATE_VARIABLES,
        ];
      }
      shouldPersist = true;
    }

    validator.validateAppConfig(data);
    assertSafeAppConfig(data);
    if (!shouldPersist) return data;
    try {
      await saveAppConfigFile(projectHomeDir, data, {
        expectedSourceSignature: sourceSignature,
        mutationLockHeld: options.mutationLockHeld,
      });
      return data;
    } catch (error) {
      if (error instanceof AppConfigConflictError) continue;
      throw error;
    }
  }
  throw new AppConfigConflictError();
}

/**
 * Merges a partial update onto an existing app config, treating an own key
 * in `updates` whose value is `null` or `undefined` as a request to CLEAR
 * that field rather than assign it. `{ ...existing, ...updates }` alone
 * would instead persist a literal `null`, which then fails AJV validation
 * deep inside `saveAppConfigFile` — a 400 from the wrong layer, and nothing
 * actually cleared (station#settings-revamp slice-1 finding 2). Required
 * keys (`sanitizeAppConfigUpdate`'s registry-driven guard) are rejected
 * before persistence and never reach here as null/undefined.
 */
export function mergeAppConfigUpdate(
  existing: AppConfig,
  updates: Partial<AppConfig>,
): AppConfig {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete merged[key];
    } else if (value === null) {
      // For most keys `null` means "clear this field". For registry-declared
      // nullable keys (e.g. `builtinAgentEngineConnectionId`, where absent =
      // re-derived each boot but null = sticky explicit Station), `null` is
      // the stored value itself and must be persisted, not deleted.
      if (NULLABLE_APP_CONFIG_KEYS.has(key as keyof AppConfig)) {
        merged[key] = null;
      } else {
        delete merged[key];
      }
    } else {
      merged[key] = value;
    }
  }
  return merged as unknown as AppConfig;
}

export async function updateAppConfigFile(
  projectHomeDir: string,
  updates: Partial<AppConfig>,
): Promise<AppConfig> {
  await loadAppConfigFile(projectHomeDir);
  const expectedSourceSignature = await appConfigFileSignature(projectHomeDir);
  const existing = await loadAppConfigFile(projectHomeDir);
  if (
    (await appConfigFileSignature(projectHomeDir)) !== expectedSourceSignature
  ) {
    throw new AppConfigConflictError();
  }
  const updated = mergeAppConfigUpdate(existing, updates);
  await saveAppConfigFile(projectHomeDir, updated, {
    expectedSourceSignature,
  });
  return updated;
}
