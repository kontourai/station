import { describe, expect, it } from 'vitest';
import {
  isCiConfigPath,
  matchPullRequestWatchRefusal,
} from '../pull-request-watch-guard.js';

const bash = (command: string) =>
  matchPullRequestWatchRefusal('Bash', { command })?.kind;

describe('what a watching Task’s agent may not do (#5066)', () => {
  it.each([
    ['gh pr merge 42 --auto --squash', 'arm-auto-merge'],
    ['gh pr merge --auto=true', 'arm-auto-merge'],
    ['cd repo && GH_TOKEN=x gh pr merge 7 --auto', 'arm-auto-merge'],
    [
      'gh api graphql -f query="mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"',
      'arm-auto-merge',
    ],
    ['glab mr merge 3 --auto-merge', 'arm-auto-merge'],
    ['gh pr merge 42 --squash', 'merge'],
    ['gh api -X PUT repos/acme/widgets/pulls/42/merge', 'merge'],
    ['git push --force', 'force-push'],
    ['git push -f origin main', 'force-push'],
    ['git push -uf origin topic', 'force-push'],
    ['git push --force-with-lease=main:abc origin main', 'force-push'],
    ['git -C repo push origin +topic', 'force-push'],
    ['git push --mirror', 'force-push'],
    ['echo x > .github/workflows/ci.yml', 'ci-config'],
    ["sed -i 's/a/b/' .gitlab-ci.yml", 'ci-config'],
    ['rm .circleci/config.yml', 'ci-config'],
    ['git rm .github/actions/setup/action.yml', 'ci-config'],
  ])('%s → %s', (command, kind) => {
    expect(bash(command)).toBe(kind);
  });

  it.each([
    'git push',
    'git push origin HEAD',
    'git push --set-upstream origin topic',
    'git push --follow-tags',
    'git log -f',
    'git fetch -f && git status',
    'gh pr view 42',
    'gh pr create --fill',
    'gh pr checks 42',
    'cat .github/workflows/ci.yml',
    'grep -n node .github/workflows/ci.yml',
    'echo "gh pr merge --auto"',
    'npm test -- --force',
  ])('%s is ordinary work', (command) => {
    expect(bash(command)).toBeUndefined();
  });

  it('reads file writes by their target, in each engine’s naming', () => {
    expect(
      matchPullRequestWatchRefusal('Write', {
        file_path: '/repo/.github/workflows/ci.yml',
        content: 'x',
      })?.kind,
    ).toBe('ci-config');
    expect(
      matchPullRequestWatchRefusal(
        'apply_patch',
        '*** Begin Patch\n*** Update File: .github/workflows/release.yml\n*** End Patch',
      )?.kind,
    ).toBe('ci-config');
    expect(
      matchPullRequestWatchRefusal('Edit', { file_path: 'src/ci.ts' }),
    ).toBeUndefined();
    expect(
      matchPullRequestWatchRefusal('str_replace_editor', {
        command: 'view',
        path: '.github/workflows/ci.yml',
      }),
    ).toBeUndefined();
    // A read tool is never refused.
    expect(
      matchPullRequestWatchRefusal('Read', {
        file_path: '.github/workflows/ci.yml',
      }),
    ).toBeUndefined();
  });

  it('names CI configuration paths and nothing near them', () => {
    expect(isCiConfigPath('C:\\repo\\.github\\workflows\\ci.yml')).toBe(true);
    expect(isCiConfigPath('Jenkinsfile')).toBe(true);
    expect(isCiConfigPath('.github/CODEOWNERS')).toBe(false);
    expect(isCiConfigPath('docs/workflows/ci.md')).toBe(false);
  });
});
