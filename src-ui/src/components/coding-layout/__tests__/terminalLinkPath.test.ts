import { describe, expect, it } from 'vitest';
import { terminalLinkRelativePath } from '../terminalLinkPath';

describe('terminalLinkRelativePath', () => {
  it('reads a relative path against the live working directory', () => {
    expect(
      terminalLinkRelativePath('/repo', '/repo/packages/app', 'src/main.ts'),
    ).toBe('packages/app/src/main.ts');
    expect(
      terminalLinkRelativePath('/repo', '/repo/packages/app', '../lib/x.ts'),
    ).toBe('packages/lib/x.ts');
  });

  it('falls back to the root when the working directory is unknown', () => {
    expect(terminalLinkRelativePath('/repo', null, './a/b.py')).toBe('a/b.py');
  });

  it('accepts absolute paths inside the root and refuses the rest', () => {
    expect(terminalLinkRelativePath('/repo', '/tmp', '/repo/x.go')).toBe(
      'x.go',
    );
    expect(
      terminalLinkRelativePath('/repo', '/repo', '/etc/passwd'),
    ).toBeNull();
    expect(
      terminalLinkRelativePath('/repo', '/repo', '../outside.ts'),
    ).toBeNull();
    expect(terminalLinkRelativePath('/repo', '/repo', '/repo')).toBeNull();
    expect(
      terminalLinkRelativePath('/repo', '/', '/repository/x.ts'),
    ).toBeNull();
  });

  it('handles Windows paths and drive letters', () => {
    expect(
      terminalLinkRelativePath(
        'C:\\work\\repo',
        'C:\\work\\repo\\src',
        'app.rs',
      ),
    ).toBe('src/app.rs');
    expect(
      terminalLinkRelativePath('C:\\work\\repo', null, 'c:\\work\\repo\\a.ts'),
    ).toBe('a.ts');
    expect(
      terminalLinkRelativePath('C:\\work\\repo', null, 'D:\\work\\repo\\a.ts'),
    ).toBeNull();
  });
});
