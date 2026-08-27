import { beforeEach, describe, expect, test } from 'vitest';
import { codingFilesContextProvider as provider } from '../CodingFilesContextProvider';

const preview = (content: string, start?: number, end?: number) => ({
  path: 'src/app.ts',
  status: 'ready' as const,
  renderKind: 'source' as const,
  content,
  ...(start && end ? { lineRange: { start, end } } : {}),
});
const intent = (path = 'src/app.ts', start?: number, end?: number) => ({
  projectSlug: 'project',
  path,
  ...(start && end ? { lineRange: { start, end } } : {}),
});

beforeEach(() => {
  provider.clear();
  provider.enabled = true;
});

describe('codingFilesContextProvider', () => {
  test('getContext is null with no attached files', () => {
    expect(provider.getContext()).toBeNull();
  });

  test('attaching a file composes its content into the context', () => {
    expect(provider.addFile(intent(), preview('const x = 1;'))).toBe(true);
    expect(provider.has(intent())).toBe(true);
    const ctx = provider.getContext();
    expect(ctx).toContain('Project file: project/src/app.ts');
    expect(ctx).toContain('const x = 1;');
  });

  test('multiple files are composed together', () => {
    provider.addFile(intent('a.ts'), { ...preview('A'), path: 'a.ts' });
    provider.addFile(intent('b.ts'), { ...preview('B'), path: 'b.ts' });
    expect(provider.list()).toHaveLength(2);
    const ctx = provider.getContext() ?? '';
    expect(ctx).toContain('Project file: project/a.ts');
    expect(ctx).toContain('Project file: project/b.ts');
  });

  test('re-attaching the same path replaces its content', () => {
    provider.addFile(intent(), preview('old'));
    provider.addFile(intent(), preview('new'));
    expect(provider.list()).toHaveLength(1);
    expect(provider.getContext()).toContain('new');
    expect(provider.getContext()).not.toContain('old');
  });

  test('removing a file drops it from the context', () => {
    provider.addFile(intent(), preview('A'));
    provider.removeFile(intent());
    expect(provider.has(intent())).toBe(false);
    expect(provider.getContext()).toBeNull();
  });

  test('removes only the exact Project/path/inclusive-range attachment', () => {
    provider.addFile(intent('src/app.ts'), preview('whole file'));
    provider.addFile(
      intent('src/app.ts', 8, 12),
      preview('first range', 8, 12),
    );
    provider.addFile(
      intent('src/app.ts', 20, 24),
      preview('second range', 20, 24),
    );

    provider.removeFile(intent('src/app.ts', 8, 12));

    expect(provider.has(intent('src/app.ts'))).toBe(true);
    expect(provider.has(intent('src/app.ts', 8, 12))).toBe(false);
    expect(provider.has(intent('src/app.ts', 20, 24))).toBe(true);
    expect(provider.getContext()).toContain('whole file');
    expect(provider.getContext()).not.toContain('first range');
    expect(provider.getContext()).toContain('second range');
  });

  test('removes all same-path attachments only through the explicit bulk operation', () => {
    provider.addFile(intent('src/app.ts'), preview('whole file'));
    provider.addFile(intent('src/app.ts', 8, 12), preview('range', 8, 12));
    provider.addFile(
      { ...intent('src/app.ts'), projectSlug: 'other-project' },
      { ...preview('other project'), path: 'src/app.ts' },
    );

    provider.removeFilesAtPath('project', 'src/app.ts');

    expect(provider.list()).toHaveLength(1);
    expect(provider.has(intent('src/app.ts'))).toBe(false);
    expect(provider.has(intent('src/app.ts', 8, 12))).toBe(false);
    expect(
      provider.has({ ...intent('src/app.ts'), projectSlug: 'other-project' }),
    ).toBe(true);
  });

  test('disabling suppresses the context but keeps the list', () => {
    provider.addFile(intent(), preview('A'));
    provider.enabled = false;
    expect(provider.getContext()).toBeNull();
    expect(provider.list()).toHaveLength(1);
  });

  test('list() returns a stable reference between mutations', () => {
    provider.addFile(intent(), preview('A'));
    expect(provider.list()).toBe(provider.list());
  });

  test('subscribers are notified on mutation', () => {
    let calls = 0;
    const unsub = provider.subscribe(() => {
      calls += 1;
    });
    provider.addFile(intent(), preview('A'));
    provider.removeFile(intent());
    unsub();
    provider.addFile(intent('b.ts'), { ...preview('B'), path: 'b.ts' });
    expect(calls).toBe(2);
  });

  test('keeps the exact selected range and rejects a response with different lines', () => {
    expect(
      provider.addFile(intent('src/app.ts', 8, 12), preview('x', 8, 12)),
    ).toBe(true);
    expect(provider.getContext()).toContain('lines 8-12');
    expect(
      provider.addFile(intent('src/app.ts', 8, 12), preview('x', 8, 11)),
    ).toBe(false);
  });
});
