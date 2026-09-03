import {
  type PluginCommandArgument,
  type PluginCommandContribution,
  type PluginCommandIntent,
  type PluginCommandRequirement,
  STATION_PLUGIN_EXTENSION_ID,
} from '@kontourai/station-contracts/plugin';

const COMMAND_LOCAL_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const HOST_SURFACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const OPERATION_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
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
const MAX_COMMANDS = 32;
const MAX_KEYWORDS = 12;

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

function boundedText(value: unknown, label: string, maxLength: number): string {
  const hasControlCharacter = [...String(value)].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    value !== value.trim() ||
    hasControlCharacter
  ) {
    throw new Error(
      `${label} must be trimmed text between 1 and ${maxLength} characters`,
    );
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
  const argumentLabel = boundedText(candidate.label, `${label}.label`, 64);
  if (
    candidate.required !== undefined &&
    typeof candidate.required !== 'boolean'
  ) {
    throw new Error(`${label}.required must be a boolean`);
  }
  const base = {
    kind,
    label: argumentLabel,
    ...(candidate.required === undefined
      ? {}
      : { required: candidate.required }),
  };
  if (kind !== 'url') return base as PluginCommandArgument;

  if (
    !Array.isArray(candidate.allowedHosts) ||
    candidate.allowedHosts.length === 0 ||
    candidate.allowedHosts.length > 16
  ) {
    throw new Error(`${label}.allowedHosts must contain 1 to 16 exact hosts`);
  }
  const allowedHosts = candidate.allowedHosts.map((host, index) => {
    const exactHost = boundedText(host, `${label}.allowedHosts[${index}]`, 253);
    if (
      exactHost !== exactHost.toLowerCase() ||
      exactHost.includes('*') ||
      exactHost.includes('/') ||
      exactHost.includes('@')
    ) {
      throw new Error(`${label}.allowedHosts[${index}] must be an exact host`);
    }
    try {
      const parsed = new URL(`https://${exactHost}`);
      if (parsed.host !== exactHost || parsed.pathname !== '/')
        throw new Error();
    } catch {
      throw new Error(`${label}.allowedHosts[${index}] must be an exact host`);
    }
    return exactHost;
  });
  if (new Set(allowedHosts).size !== allowedHosts.length) {
    throw new Error(`${label}.allowedHosts must not contain duplicates`);
  }
  return { ...base, kind: 'url', allowedHosts } as PluginCommandArgument;
}

function parseIntent(value: unknown, label: string): PluginCommandIntent {
  const candidate = record(value, label);
  switch (candidate.kind) {
    case 'navigate': {
      exactKeys(candidate, ['kind', 'surfaceId'], label);
      if (
        typeof candidate.surfaceId !== 'string' ||
        !HOST_SURFACE_ID.test(candidate.surfaceId)
      ) {
        throw new Error(`${label}.surfaceId is invalid`);
      }
      return { kind: 'navigate', surfaceId: candidate.surfaceId };
    }
    case 'seed-composer': {
      exactKeys(candidate, ['kind', 'text', 'argumentMode'], label);
      const text = boundedText(candidate.text, `${label}.text`, 4_000);
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
    case 'invoke-declared-plugin-operation': {
      exactKeys(candidate, ['kind', 'operationId', 'argumentMode'], label);
      if (
        typeof candidate.operationId !== 'string' ||
        !OPERATION_ID.test(candidate.operationId)
      ) {
        throw new Error(`${label}.operationId is invalid`);
      }
      if (
        candidate.argumentMode !== undefined &&
        candidate.argumentMode !== 'body'
      ) {
        throw new Error(`${label}.argumentMode is invalid`);
      }
      return {
        kind: 'invoke-declared-plugin-operation',
        operationId: candidate.operationId,
        ...(candidate.argumentMode ? { argumentMode: 'body' as const } : {}),
      };
    }
    default:
      throw new Error(`${label}.kind is unknown`);
  }
}

/**
 * Parse only Station's reserved Agent Plugins extension namespace. Other
 * extension namespaces stay opaque and receive no Station semantics.
 */
export function parsePluginCommandContributions(
  extensions: unknown,
  pluginName: string,
): PluginCommandContribution[] {
  if (extensions === undefined) return [];
  const extensionMap = record(extensions, 'Plugin manifest extensions');
  const stationExtension = extensionMap[STATION_PLUGIN_EXTENSION_ID];
  if (stationExtension === undefined) return [];
  const station = record(
    stationExtension,
    `Plugin extension '${STATION_PLUGIN_EXTENSION_ID}'`,
  );
  if (station.commands === undefined) return [];
  if (!Array.isArray(station.commands)) {
    throw new Error(
      `Plugin extension '${STATION_PLUGIN_EXTENSION_ID}'.commands must be an array`,
    );
  }
  if (station.commands.length > MAX_COMMANDS) {
    throw new Error(
      `Plugin commands may contain at most ${MAX_COMMANDS} entries`,
    );
  }

  const ids = new Set<string>();
  return station.commands.map((value, index) => {
    const label = `Plugin commands[${index}]`;
    const candidate = record(value, label);
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
    const id = boundedText(candidate.id, `${label}.id`, 127);
    const prefix = `${pluginName}.`;
    if (
      !id.startsWith(prefix) ||
      !COMMAND_LOCAL_ID.test(id.slice(prefix.length))
    ) {
      throw new Error(
        `${label}.id must be namespaced to plugin '${pluginName}'`,
      );
    }
    if (ids.has(id))
      throw new Error(`Plugin commands contains duplicate id '${id}'`);
    ids.add(id);

    const title = boundedText(candidate.title, `${label}.title`, 80);
    const subtitle =
      candidate.subtitle === undefined
        ? undefined
        : boundedText(candidate.subtitle, `${label}.subtitle`, 160);
    if (
      candidate.icon !== undefined &&
      (typeof candidate.icon !== 'string' || !COMMAND_ICONS.has(candidate.icon))
    ) {
      throw new Error(`${label}.icon is invalid`);
    }

    let keywords: string[] | undefined;
    if (candidate.keywords !== undefined) {
      if (
        !Array.isArray(candidate.keywords) ||
        candidate.keywords.length > MAX_KEYWORDS
      ) {
        throw new Error(
          `${label}.keywords may contain at most ${MAX_KEYWORDS} entries`,
        );
      }
      keywords = candidate.keywords.map((keyword, keywordIndex) =>
        boundedText(keyword, `${label}.keywords[${keywordIndex}]`, 32),
      );
      if (
        new Set(keywords.map((keyword) => keyword.toLowerCase())).size !==
        keywords.length
      ) {
        throw new Error(`${label}.keywords must not contain duplicates`);
      }
    }

    let requires: PluginCommandRequirement[] | undefined;
    if (candidate.requires !== undefined) {
      if (
        !Array.isArray(candidate.requires) ||
        candidate.requires.length > COMMAND_REQUIREMENTS.size ||
        !candidate.requires.every(
          (requirement): requirement is PluginCommandRequirement =>
            typeof requirement === 'string' &&
            COMMAND_REQUIREMENTS.has(requirement as PluginCommandRequirement),
        )
      ) {
        throw new Error(`${label}.requires is invalid`);
      }
      requires = [...candidate.requires];
      if (new Set(requires).size !== requires.length) {
        throw new Error(`${label}.requires must not contain duplicates`);
      }
    }

    const argument =
      candidate.argument === undefined
        ? undefined
        : parseArgument(candidate.argument, `${label}.argument`);
    const intent = parseIntent(candidate.intent, `${label}.intent`);
    const usesArgument =
      intent.kind === 'seed-composer'
        ? intent.argumentMode !== undefined
        : intent.kind === 'invoke-declared-plugin-operation'
          ? intent.argumentMode === 'body'
          : false;
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
      ...(subtitle ? { subtitle } : {}),
      ...(candidate.icon
        ? { icon: candidate.icon as PluginCommandContribution['icon'] }
        : {}),
      ...(keywords ? { keywords } : {}),
      ...(requires ? { requires } : {}),
      ...(argument ? { argument } : {}),
      intent,
    };
  });
}
