// @vitest-environment jsdom

/**
 * #481 slice A tripwire — the app-side Project list/detail scope migration.
 *
 * Every `src-ui` read of the Project list/detail must go through the
 * canonical scoped wrappers in `contexts/ProjectsContext.tsx`
 * (`useScopedProjectsQuery` / `useScopedProjectQuery`), which capture the
 * host request authority and fail closed when it is missing. The raw SDK
 * hooks (`useProjectsQuery` / `useProjectQuery`) keep an ambient
 * `_getApiBase()` fallback for single-connection SDK consumers, so a direct
 * `src-ui` import of them silently reintroduces a cross-home ambient read.
 *
 * This is a STRUCTURAL tripwire, not the primary evidence: the mounted
 * Home/ProjectPage switching tests and the SDK authority-query tests prove
 * the behavior. This scan only guards against future call sites appearing.
 */
import { describe, expect, test } from 'vitest';

const sources = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const CANONICAL_OWNER = 'contexts/ProjectsContext.tsx';

function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*')
      );
    })
    .join('\n');
}

describe('Project query scope migration tripwire (#481 slice A)', () => {
  test('no src-ui source outside the canonical owner imports the ambient SDK Project hooks', () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      if (path.includes('__tests__') || /\.test\.(ts|tsx)$/.test(path))
        continue;
      if (path.endsWith(CANONICAL_OWNER)) continue;
      const code = stripCommentLines(source);
      if (/\buseProjectsQuery\b|\buseProjectQuery\b/.test(code)) {
        offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the canonical owner itself still passes through the SDK hooks', () => {
    const owner = Object.entries(sources).find(([path]) =>
      path.endsWith(CANONICAL_OWNER),
    );
    expect(owner).toBeDefined();
    expect(stripCommentLines(owner![1])).toMatch(
      /\buseProjectsQuery\b[\s\S]*\buseProjectQuery\b/,
    );
  });
});
