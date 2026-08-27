import type { AppConfig } from '@kontourai/station-contracts/config';
import { getCachedUser } from '../../routes/system/auth.js';

export function replaceRuntimeTemplateVariables(
  text: string,
  // May be undefined when called before the runtime has assigned its appConfig
  // (e.g. the Strands adapter resolves agent instructions eagerly during agent
  // bootstrap, before StationRuntime.appConfig is set). Degrade gracefully —
  // built-in/user variables still apply; custom ones are skipped.
  appConfig: AppConfig | undefined,
): string {
  const now = new Date();
  const userVars = getRuntimeUserVariables();
  const builtInReplacements = getBuiltInTemplateVariables(now);
  const customReplacements = getCustomTemplateVariables(appConfig, now);

  let result = text;
  const allReplacements = {
    ...builtInReplacements,
    ...userVars,
    ...customReplacements,
  };

  for (const [key, value] of Object.entries(allReplacements)) {
    result = result.replace(
      new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      value,
    );
  }

  return result;
}

function getRuntimeUserVariables(): Record<string, string> {
  try {
    const user = getCachedUser();
    return {
      '{{user_alias}}': user.alias || '',
      '{{user_name}}': user.name || user.alias || '',
      '{{user_email}}': user.email || '',
      '{{user_title}}': user.title || '',
    };
  } catch (error) {
    console.debug('Auth module not loaded yet:', error);
    return {};
  }
}

function getBuiltInTemplateVariables(now: Date): Record<string, string> {
  return {
    '{{date}}': now.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    '{{time}}': now.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }),
    '{{datetime}}': now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }),
    '{{iso_date}}': now.toISOString().split('T')[0],
    '{{iso_datetime}}': now.toISOString(),
    '{{timestamp}}': now.getTime().toString(),
    '{{year}}': now.getFullYear().toString(),
    '{{month}}': (now.getMonth() + 1).toString(),
    '{{day}}': now.getDate().toString(),
    '{{weekday}}': now.toLocaleDateString('en-US', { weekday: 'long' }),
  };
}

function getCustomTemplateVariables(
  appConfig: AppConfig | undefined,
  now: Date,
): Record<string, string> {
  const replacements: Record<string, string> = {};

  for (const variable of appConfig?.templateVariables || []) {
    const key = `{{${variable.key}}}`;

    switch (variable.type) {
      case 'static':
        replacements[key] = variable.value || '';
        break;
      case 'date':
        replacements[key] = variable.format
          ? now.toLocaleDateString('en-US', JSON.parse(variable.format))
          : now.toLocaleDateString();
        break;
      case 'time':
        replacements[key] = variable.format
          ? now.toLocaleTimeString('en-US', JSON.parse(variable.format))
          : now.toLocaleTimeString();
        break;
      case 'datetime':
        replacements[key] = variable.format
          ? now.toLocaleString('en-US', JSON.parse(variable.format))
          : now.toLocaleString();
        break;
      case 'custom':
        replacements[key] = variable.value || '';
        break;
    }
  }

  return replacements;
}
