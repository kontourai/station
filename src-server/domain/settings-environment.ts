import {
  acceptsSettingValue,
  type SettingDefinition,
} from '@kontourai/station-contracts/settings-registry';

interface EnvironmentConfigurationNotice {
  code:
    | 'invalid_environment_value'
    | 'legacy_environment_alias'
    | 'environment_alias_conflict';
  envVar: string;
}

/** Values stay private to their caller; diagnostic notices contain names only. */
export function resolveEnvironmentValue<T>(
  canonical: string,
  aliases: readonly string[],
  environment: Record<string, string | undefined>,
  parse: (raw: string) => T | undefined,
) {
  let value: T | undefined;
  let envVar: string | undefined;
  const notices: EnvironmentConfigurationNotice[] = [];
  for (const name of [canonical, ...aliases]) {
    const raw = environment[name]?.trim();
    if (!raw) continue;
    const parsed = parse(raw);
    if (parsed === undefined) {
      notices.push({ code: 'invalid_environment_value', envVar: name });
      continue;
    }
    if (envVar === undefined) {
      value = parsed;
      envVar = name;
      if (name !== canonical)
        notices.push({ code: 'legacy_environment_alias', envVar: name });
    } else if (!Object.is(value, parsed)) {
      notices.push({ code: 'environment_alias_conflict', envVar: name });
    }
  }
  return { value, envVar, notices };
}

/** Effective settings and provenance use the same acceptance and alias order. */
export function resolveSettingEnvironment(
  definition: SettingDefinition,
  environment: Record<string, string | undefined> = process.env,
) {
  if (!definition.envFallback)
    return { value: undefined, envVar: undefined, notices: [] };
  return resolveEnvironmentValue<string | boolean>(
    definition.envFallback,
    definition.envAliases ?? [],
    environment,
    (raw) => {
      if (!acceptsSettingValue(definition, raw)) return undefined;
      return definition.descriptor.kind === 'boolean'
        ? ['1', 'true', 'on', 'enabled'].includes(raw.toLowerCase())
        : raw;
    },
  );
}
