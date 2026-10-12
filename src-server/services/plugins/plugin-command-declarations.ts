import type {
  PluginCommandArgument,
  PluginCommandContribution,
  PluginCommandIntent,
  PluginCommandRequirement,
} from '@kontourai/station-contracts/agent-plugin';

/**
 * Validation of `PluginManifest.commands` for BOTH manifest formats.
 *
 * Agent Plugins manifests already satisfy `$defs/command` in
 * `schemas/agent-plugins/io.kontourai.station-1.0.schema.json`; legacy
 * manifests reach this function unvalidated. The shape checks below mirror
 * that schema so the two formats accept the same declarations, and the
 * semantic checks are the ones a JSON schema cannot express: owner-qualified
 * ids, uniqueness, and an argument that its intent actually consumes.
 *
 * A destination id is checked for SHAPE only. The destination registry is a
 * client concern; existence is decided where the effect is applied.
 */

const MAX_PLUGIN_COMMANDS = 32;
const COMMAND_LOCAL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
/** `$defs/id` in the Station extension schema. */
const DECLARATION_ID = /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/;
const EXACT_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::[0-9]{1,5})?$/;
const COMMAND_ICONS = new Set([
  'agent',
  'chat',
  'command',
  'plugin',
  'project',
  'search',
]);
const COMMAND_REQUIREMENTS = new Set<PluginCommandRequirement>([
  'active-chat',
  'plugin-server',
  'project',
  'session',
  'task',
]);
const ARGUMENT_KINDS = new Set([
  'text',
  'url',
  'project',
  'task',
  'session',
  'file',
  'registry-item',
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} contains unknown field '${unknown}'`);
}

function boundedText(
  value: unknown,
  label: string,
  minLength: number,
  maxLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minLength ||
    value.length > maxLength ||
    value !== value.trim() ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error(
      `${label} must be trimmed text between ${minLength} and ${maxLength} characters`,
    );
  }
  return value;
}

function declarationId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !DECLARATION_ID.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseArgument(value: unknown, label: string): PluginCommandArgument {
  const candidate = record(value, label);
  const kind = candidate.kind;
  if (typeof kind !== 'string' || !ARGUMENT_KINDS.has(kind)) {
    throw new Error(`${label}.kind is invalid`);
  }
  exactKeys(
    candidate,
    kind === 'url'
      ? ['kind', 'label', 'required', 'allowedHosts']
      : ['kind', 'label', 'required'],
    label,
  );
  const argumentLabel = boundedText(candidate.label, `${label}.label`, 1, 64);
  if (
    candidate.required !== undefined &&
    typeof candidate.required !== 'boolean'
  ) {
    throw new Error(`${label}.required must be a boolean`);
  }
  const base = {
    label: argumentLabel,
    ...(candidate.required === undefined
      ? {}
      : { required: candidate.required }),
  };
  if (kind !== 'url') {
    return { ...base, kind } as PluginCommandArgument;
  }
  if (
    !Array.isArray(candidate.allowedHosts) ||
    candidate.allowedHosts.length === 0 ||
    candidate.allowedHosts.length > 16
  ) {
    throw new Error(`${label}.allowedHosts must contain 1 to 16 exact hosts`);
  }
  const allowedHosts = candidate.allowedHosts.map((host, index) => {
    const exactHost = boundedText(
      host,
      `${label}.allowedHosts[${index}]`,
      1,
      253,
    );
    let parsedHost: string | null = null;
    try {
      const parsed = new URL(`https://${exactHost}`);
      if (parsed.pathname === '/' && !parsed.search && !parsed.hash)
        parsedHost = parsed.host;
    } catch {
      parsedHost = null;
    }
    // Exactly one DNS host (optional port), spelled the way URL parsing
    // spells it. URL parsing alone is not enough: it accepts `*` in a host.
    if (!EXACT_HOST.test(exactHost) || parsedHost !== exactHost) {
      throw new Error(`${label}.allowedHosts[${index}] must be an exact host`);
    }
    return exactHost;
  });
  if (new Set(allowedHosts).size !== allowedHosts.length) {
    throw new Error(`${label}.allowedHosts must not contain duplicates`);
  }
  return { ...base, kind: 'url', allowedHosts };
}

function parseIntent(value: unknown, label: string): PluginCommandIntent {
  const candidate = record(value, label);
  switch (candidate.kind) {
    case 'navigate':
      exactKeys(candidate, ['kind', 'surfaceId'], label);
      return {
        kind: 'navigate',
        // The published field name is `surfaceId`; its value is a destination id.
        surfaceId: declarationId(candidate.surfaceId, `${label}.surfaceId`),
      };
    case 'seed-composer': {
      exactKeys(candidate, ['kind', 'text', 'argumentMode'], label);
      const text = boundedText(candidate.text, `${label}.text`, 1, 4_000);
      if (
        candidate.argumentMode !== undefined &&
        candidate.argumentMode !== 'append' &&
        candidate.argumentMode !== 'replace'
      ) {
        throw new Error(`${label}.argumentMode is invalid`);
      }
      return {
        kind: 'seed-composer',
        text,
        ...(candidate.argumentMode
          ? { argumentMode: candidate.argumentMode }
          : {}),
      };
    }
    case 'invoke-declared-plugin-operation':
      exactKeys(candidate, ['kind', 'operationId', 'argumentMode'], label);
      if (
        candidate.argumentMode !== undefined &&
        candidate.argumentMode !== 'body'
      ) {
        throw new Error(`${label}.argumentMode is invalid`);
      }
      return {
        kind: 'invoke-declared-plugin-operation',
        operationId: declarationId(
          candidate.operationId,
          `${label}.operationId`,
        ),
        ...(candidate.argumentMode ? { argumentMode: 'body' as const } : {}),
      };
    default:
      throw new Error(`${label}.kind is unknown`);
  }
}

function parseStringSet<T extends string>(
  value: unknown,
  label: string,
  maxItems: number,
  item: (entry: unknown, entryLabel: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} may contain at most ${maxItems} entries`);
  }
  const items = value.map((entry, index) => item(entry, `${label}[${index}]`));
  if (new Set(items).size !== items.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return items;
}

/**
 * Returns normalized declarations or throws an Error whose message is bounded
 * and names the offending field. Callers classify the failure.
 */
export function parsePluginCommandDeclarations(
  value: unknown,
  pluginName: string,
): PluginCommandContribution[] {
  if (!Array.isArray(value)) {
    throw new Error('Plugin commands must be an array');
  }
  if (value.length > MAX_PLUGIN_COMMANDS) {
    throw new Error(
      `Plugin commands may contain at most ${MAX_PLUGIN_COMMANDS} entries`,
    );
  }
  const prefix = `${pluginName}.`;
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const label = `Plugin commands[${index}]`;
    const candidate = record(entry, label);
    exactKeys(
      candidate,
      [
        'version',
        'id',
        'title',
        'subtitle',
        'icon',
        'keywords',
        'requires',
        'argument',
        'intent',
      ],
      label,
    );
    if (candidate.version !== '1.0') {
      throw new Error(`${label}.version must be '1.0'`);
    }
    const id = boundedText(candidate.id, `${label}.id`, 3, 127);
    if (
      !id.startsWith(prefix) ||
      !COMMAND_LOCAL_ID.test(id.slice(prefix.length))
    ) {
      throw new Error(
        `${label}.id must be '${pluginName}.' followed by a command name`,
      );
    }
    if (ids.has(id)) {
      throw new Error(`Plugin commands contains duplicate id '${id}'`);
    }
    ids.add(id);
    const title = boundedText(candidate.title, `${label}.title`, 1, 80);
    const subtitle =
      candidate.subtitle === undefined
        ? undefined
        : boundedText(candidate.subtitle, `${label}.subtitle`, 1, 160);
    if (
      candidate.icon !== undefined &&
      (typeof candidate.icon !== 'string' || !COMMAND_ICONS.has(candidate.icon))
    ) {
      throw new Error(`${label}.icon is invalid`);
    }
    const keywords =
      candidate.keywords === undefined
        ? undefined
        : parseStringSet(
            candidate.keywords,
            `${label}.keywords`,
            12,
            (keyword, keywordLabel) =>
              boundedText(keyword, keywordLabel, 1, 32),
          );
    const requires =
      candidate.requires === undefined
        ? undefined
        : parseStringSet(
            candidate.requires,
            `${label}.requires`,
            COMMAND_REQUIREMENTS.size,
            (requirement, requirementLabel) => {
              if (
                typeof requirement !== 'string' ||
                !COMMAND_REQUIREMENTS.has(
                  requirement as PluginCommandRequirement,
                )
              ) {
                throw new Error(`${requirementLabel} is invalid`);
              }
              return requirement as PluginCommandRequirement;
            },
          );
    const argument =
      candidate.argument === undefined
        ? undefined
        : parseArgument(candidate.argument, `${label}.argument`);
    const intent = parseIntent(candidate.intent, `${label}.intent`);
    const usesArgument =
      (intent.kind === 'seed-composer' ||
        intent.kind === 'invoke-declared-plugin-operation') &&
      intent.argumentMode !== undefined;
    if (argument && !usesArgument) {
      throw new Error(`${label}.argument is declared but unused by its intent`);
    }
    if (!argument && usesArgument) {
      throw new Error(
        `${label}.intent declares an argument mode without an argument`,
      );
    }
    return {
      version: '1.0' as const,
      id,
      title,
      ...(subtitle !== undefined ? { subtitle } : {}),
      ...(candidate.icon !== undefined
        ? { icon: candidate.icon as PluginCommandContribution['icon'] }
        : {}),
      ...(keywords ? { keywords } : {}),
      ...(requires ? { requires } : {}),
      ...(argument ? { argument } : {}),
      intent,
    };
  });
}

/**
 * The only intents Station executes today: argument-free navigation and
 * composer seeding. Everything else stays a visible, unavailable row.
 */
export function isExecutablePluginCommand(
  command: PluginCommandContribution,
): command is PluginCommandContribution & {
  intent: Extract<PluginCommandIntent, { kind: 'navigate' | 'seed-composer' }>;
} {
  return (
    command.argument === undefined &&
    (command.intent.kind === 'navigate' ||
      command.intent.kind === 'seed-composer')
  );
}
