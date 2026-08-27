export interface ProjectDirectoryEntry {
  name: string;
  isDirectory: boolean;
}

function titleCaseSegment(segment: string): string {
  if (!segment) return segment;
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

export function normalizeWorkingDirectory(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/' || trimmed === '~') {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * The slug a New Project submission will actually POST. Exported so the
 * modal's pre-POST duplicate check (4-HOME-007) tests the same string the
 * request carries — a check against a differently-derived slug would clear a
 * name the server then refuses.
 */
export function deriveProjectSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function getWorkingDirectoryLeaf(value: string): string {
  const normalized = normalizeWorkingDirectory(value);
  if (!normalized || normalized === '/' || normalized === '~') {
    return '';
  }

  const pathWithoutHome = normalized.startsWith('~/')
    ? normalized.slice(2)
    : normalized;
  const parts = pathWithoutHome.split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

export function inferProjectNameFromPath(value: string): string {
  const leaf = getWorkingDirectoryLeaf(value);
  if (!leaf) return '';

  return leaf
    .split(/[-_.\s]+/g)
    .filter(Boolean)
    .map(titleCaseSegment)
    .join(' ');
}

export function inferProjectIconFromPath(
  value: string,
  entries: ProjectDirectoryEntry[] = [],
): string {
  const leaf = getWorkingDirectoryLeaf(value).toLowerCase();
  const pathTokens = leaf.split(/[-_.\s]+/g).filter(Boolean);
  const entryTokens = entries.map((entry) => entry.name.toLowerCase());
  const tokens = new Set([...pathTokens, ...entryTokens]);

  const hasAny = (...candidates: string[]) =>
    candidates.some((candidate) => tokens.has(candidate));

  if (hasAny('agent', 'agents', 'ai', 'llm', 'model', 'models', 'prompt')) {
    return '🤖';
  }
  if (
    hasAny(
      'web',
      'site',
      'frontend',
      'ui',
      'public',
      'app',
      'apps',
      'components',
      'pages',
    )
  ) {
    return '🌐';
  }
  if (hasAny('mobile', 'ios', 'android', 'expo')) {
    return '📱';
  }
  if (hasAny('api', 'backend', 'server', 'service', 'services')) {
    return '🧩';
  }
  if (hasAny('docs', 'doc', 'wiki', 'knowledge', 'notes', 'blog')) {
    return '📚';
  }
  if (hasAny('design', 'brand', 'assets')) {
    return '🎨';
  }
  if (hasAny('data', 'analytics', 'metrics', 'dashboard')) {
    return '📊';
  }
  if (hasAny('cli', 'tool', 'tools', 'scripts', 'bin', 'infra')) {
    return '🛠️';
  }
  if (hasAny('test', 'tests', 'spec', 'demo', 'sandbox')) {
    return '🧪';
  }

  return '📁';
}
