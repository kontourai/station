import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type {
  GuidanceAgentExport,
  PortabilityImportLedgerEntry,
} from '@kontourai/station-contracts/portability';
import {
  isSafeToolServerCredentialKey,
  isSafeToolServerId,
  type ToolDef,
} from '@kontourai/station-contracts/tool';
import { publishJsonFileWithOwnedLock } from '@kontourai/station-shared/json-file-storage';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  ToolServerCredentialStore,
  toolServerIntegrationMutationLockPath,
} from '@kontourai/station-shared/tool-server-credential-store';
import { PROJECT_HOME } from './helpers.js';

export interface PortabilitySnapshot {
  appConfig: AppConfig;
  agents: GuidanceAgentExport[];
  integrations: ToolDef[];
}

export function readPortabilitySnapshot(
  projectHome = PROJECT_HOME,
  includeSecrets = false,
): PortabilitySnapshot {
  return {
    appConfig: readAppConfig(projectHome),
    agents: listAgents(projectHome),
    integrations: listIntegrations(projectHome, includeSecrets),
  };
}

export function readAppConfig(projectHome = PROJECT_HOME): AppConfig {
  const path = join(projectHome, 'config', 'app.json');
  if (!existsSync(path)) return {} as AppConfig;
  return JSON.parse(readFileSync(path, 'utf-8')) as AppConfig;
}

export function writeAppConfigGuidance(
  guidance: Partial<AppConfig>,
  projectHome = PROJECT_HOME,
): AppConfig {
  const next = {
    ...readAppConfig(projectHome),
    ...guidance,
  };
  mkdirSync(join(projectHome, 'config'), { recursive: true });
  writeFileSync(
    join(projectHome, 'config', 'app.json'),
    JSON.stringify(next, null, 2),
    'utf-8',
  );
  return next;
}

export function listAgents(projectHome = PROJECT_HOME): GuidanceAgentExport[] {
  if (!existsSync(AGENTS_DIR_FOR(projectHome))) return [];

  return readdirSync(AGENTS_DIR_FOR(projectHome), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      slug: entry.name,
      spec: readAgent(entry.name, projectHome),
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

export function readAgent(slug: string, projectHome = PROJECT_HOME): AgentSpec {
  return JSON.parse(
    readFileSync(
      join(AGENTS_DIR_FOR(projectHome), slug, 'agent.json'),
      'utf-8',
    ),
  ) as AgentSpec;
}

export function writeAgent(
  slug: string,
  spec: AgentSpec,
  projectHome = PROJECT_HOME,
): void {
  const agentDir = join(AGENTS_DIR_FOR(projectHome), slug);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify(spec, null, 2),
    'utf-8',
  );
}

export function listIntegrations(
  projectHome = PROJECT_HOME,
  includeSecrets = false,
): ToolDef[] {
  const integrationsDir = join(projectHome, 'integrations');
  if (!existsSync(integrationsDir)) return [];

  return readdirSync(integrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const def = JSON.parse(
        readFileSync(
          join(integrationsDir, entry.name, 'integration.json'),
          'utf-8',
        ),
      ) as ToolDef;
      // Directory identity is authoritative. A manifest field cannot select
      // another server's credential namespace during export.
      def.id = entry.name;
      const storedEnvNames = def.storedEnvNames ?? [];
      const bindingNames = new Set(Object.keys(def.secretEnvRefs ?? {}));
      const legacyNames = new Set([
        ...Object.keys(def.env ?? {}),
        ...storedEnvNames,
      ]);
      const allNames = new Set([...legacyNames, ...bindingNames]);
      if (allNames.size > 0) {
        if (includeSecrets) {
          const store =
            storedEnvNames.length > 0
              ? new ToolServerCredentialStore(projectHome)
              : null;
          const exportableLegacy = [...legacyNames].filter(
            (name) => !bindingNames.has(name),
          );
          if (exportableLegacy.length > 0) {
            def.env = Object.fromEntries(
              exportableLegacy.map((key) => {
                const inline = def.env?.[key];
                if (inline !== undefined) return [key, inline];
                if (!store)
                  throw new Error(
                    `Tool-server credential source is missing for ${entry.name} env ${key}`,
                  );
                return [key, store.get(entry.name, key)];
              }),
            );
          } else delete def.env;
          const hints = new Set([
            ...(def.requiredEnvNames ?? []),
            ...bindingNames,
          ]);
          if (hints.size > 0) def.requiredEnvNames = [...hints].sort();
          else delete def.requiredEnvNames;
        } else {
          def.requiredEnvNames = [
            ...new Set([...(def.requiredEnvNames ?? []), ...allNames]),
          ].sort();
          delete def.env;
        }
        const withheld = includeSecrets ? bindingNames : allNames;
        if (withheld.size > 0) {
          console.error(
            `Withheld tool-server environment keys for ${entry.name}: ${[...withheld].sort().join(', ')}`,
          );
        }
      }
      delete def.storedEnvNames;
      delete def.secretEnv;
      delete def.secretEnvRefs;
      return def;
    })
    .sort((a, b) => a.id.localeCompare(b.id)) as ToolDef[];
}

export async function writeIntegration(
  id: string,
  def: ToolDef,
  projectHome = PROJECT_HOME,
): Promise<void> {
  validateIntegrationImport(id, def);
  const secrets = { ...(def.env ?? {}), ...(def.secretEnv ?? {}) };
  const hints = sanitizeArtifactHints(def.requiredEnvNames);
  if (hints.length > 0)
    console.error(
      `Artifact says tool server ${JSON.stringify(sanitizeArtifactHint(id))} may require environment variables: ${hints.join(', ')}. This is an untrusted hint only; Station fails closed when a configured stored credential reference is missing during hydration.`,
    );
  mkdirSync(join(projectHome, 'integrations'), { recursive: true });
  const path = join(projectHome, 'integrations', id, 'integration.json');
  const release = await acquireFileMutationLockAsync(
    toolServerIntegrationMutationLockPath(projectHome, id),
  );
  try {
    const store = new ToolServerCredentialStore(projectHome);
    const previous = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as ToolDef)
      : undefined;
    const persisted = { ...def };
    const previousNames = previous?.storedEnvNames ?? [];
    const refs = new Set(previousNames);
    for (const [name, secret] of Object.entries(secrets)) {
      await store.upsert(id, name, secret);
      refs.add(name);
    }
    delete persisted.env;
    delete persisted.secretEnv;
    delete persisted.storedEnvNames;
    delete persisted.requiredEnvNames;
    if (refs.size > 0) persisted.storedEnvNames = [...refs].sort();
    const dir = join(projectHome, 'integrations', id);
    mkdirSync(dir, { recursive: true });
    await publishJsonFileWithOwnedLock(path, persisted);
    await store.reconcileServer(id, [...refs]);
    const preserved = previousNames.filter(
      (name) => !Object.hasOwn(secrets, name),
    );
    if (preserved.length > 0)
      console.log(
        `  ↳ preserved existing environment variables for ${id}: ${preserved.sort().join(', ')}`,
      );
  } finally {
    await release();
  }
}

export function validateIntegrationImport(id: string, def: ToolDef): void {
  if (!isSafeToolServerId(id))
    throw new Error(`Invalid tool-server import id: ${JSON.stringify(id)}`);
  const secrets = { ...(def.env ?? {}), ...(def.secretEnv ?? {}) };
  if (Object.keys(def.secretEnvRefs ?? {}).length > 0) {
    throw new Error(
      'Portable integration artifacts cannot import secret binding references; establish bindings through the destination operator flow.',
    );
  }
  for (const [name, secret] of Object.entries(secrets)) {
    if (!isSafeToolServerCredentialKey(name))
      throw new Error(
        `Invalid tool-server credential env name for ${JSON.stringify(id)}: ${JSON.stringify(name)}`,
      );
    if (
      typeof secret !== 'string' ||
      secret.length < 1 ||
      secret.length > 65536
    )
      throw new Error(
        `Invalid tool-server credential value for ${JSON.stringify(id)} env ${JSON.stringify(name)}`,
      );
    if (/^\[WITHHELD:[^\]]+\]$/.test(secret))
      throw new Error(
        `Refusing to import withheld credential marker for ${name}`,
      );
  }
}

function sanitizeArtifactHints(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const hints: string[] = [];
  let emittedLength = 0;
  for (const value of values.slice(0, 16)) {
    const hint = sanitizeArtifactHint(value);
    if (emittedLength + hint.length > 1024) break;
    hints.push(hint);
    emittedLength += hint.length;
  }
  return hints;
}

const ARTIFACT_HINT_MAX_LENGTH = 80;

/**
 * Bound BEFORE coercing. An artifact is untrusted input, so a hostile first
 * hint can be a multi-hundred-megabyte string or a deeply nested array:
 * `String(value)` and the control-character scan would each process the whole
 * value before any truncation, spending CPU and peak memory to emit 80
 * characters (review round 6). A non-string is named rather than stringified,
 * so no large structure is ever serialized.
 */
function sanitizeArtifactHint(value: unknown): string {
  // Strings are bounded before the control-character scan; other primitives
  // are small by construction; objects/arrays are NAMED rather than
  // serialized, since those are the shapes that can be arbitrarily large.
  if (typeof value === 'string')
    return value
      .slice(0, ARTIFACT_HINT_MAX_LENGTH)
      .replace(/[\p{Cc}\p{Cf}]/gu, '');
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  )
    return String(value).slice(0, ARTIFACT_HINT_MAX_LENGTH);
  return '<non-scalar entry>';
}

export function writeImportLedger(
  entry: PortabilityImportLedgerEntry,
  notes: string | null,
  projectHome = PROJECT_HOME,
): { ledgerPath: string; notesPath?: string } {
  const importsDir = join(projectHome, 'imports');
  mkdirSync(importsDir, { recursive: true });

  let notesPath: string | undefined;
  if (notes) {
    notesPath = join(importsDir, `${entry.id}.notes.md`);
    writeFileSync(notesPath, notes, 'utf-8');
  }

  const fullEntry = {
    ...entry,
    notesPath,
  };
  const ledgerPath = join(importsDir, `${entry.id}.json`);
  writeFileSync(ledgerPath, JSON.stringify(fullEntry, null, 2), 'utf-8');
  return { ledgerPath, notesPath };
}

function AGENTS_DIR_FOR(projectHome: string): string {
  return join(projectHome, 'agents');
}
