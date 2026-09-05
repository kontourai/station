/**
 * Declarative instruction topology. This models documented loader behavior;
 * it does not claim to observe a model session.
 */
export const TOKENIZER = Object.freeze({
  package: 'js-tiktoken@1.0.21',
  encoding: 'o200k_base',
});
export const ROOT_BUDGET = Object.freeze({
  bytes: 8_192,
  lines: 140,
  tokens: 2_048,
});
export const SCOPE_BUDGET = Object.freeze({
  bytes: 8_192,
  lines: 160,
  tokens: 2_048,
});
export const COMBINED_BUDGET = Object.freeze({
  bytes: 16_384,
  lines: 300,
  tokens: 4_096,
});

export const SCOPES = Object.freeze([
  Object.freeze({ directory: 'src-server', routes: ['src-server/'] }),
  Object.freeze({ directory: 'src-ui', routes: ['src-ui/'] }),
  Object.freeze({
    directory: 'scripts',
    routes: ['scripts/', '.github/', 'patches/'],
    rootFiles: [
      'package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.json',
      'vitest.config.ts',
      'biome.json',
      '.npmrc',
    ],
  }),
  Object.freeze({ directory: 'src-desktop', routes: ['src-desktop/'] }),
  Object.freeze({
    directory: 'packages/contracts',
    routes: ['packages/contracts/'],
  }),
  Object.freeze({ directory: 'packages/sdk', routes: ['packages/sdk/'] }),
  Object.freeze({ directory: 'tests', routes: ['tests/'] }),
]);

export const REQUIRED_INSTRUCTION_FILES = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  ...SCOPES.flatMap(({ directory }) => [
    `${directory}/AGENTS.md`,
    `${directory}/CLAUDE.md`,
  ]),
]);

export const GENERATED_BLOCK_OWNERS = Object.freeze({
  'verification-scheduling': 'docs/guides/testing.md',
  'verification-policy': 'docs/guides/testing.md',
});
export const GOVERNANCE_BLOCK = `<!-- veritas:governance-block:start -->\nThis repo uses Veritas for AI governance. Read \`.veritas/GOVERNANCE.md\` before making changes.\nAfter changes, run \`veritas readiness\` and address any FAIL lines before finishing.\n<!-- veritas:governance-block:end -->\n`;
export const ROOT_UNIVERSAL_MARKERS = Object.freeze([
  'Diagnose the failure rather than rerun-to-green',
  'signal to diagnose, not a request to rerun until green',
  'join or reuse the existing lease',
  'freeze the worktree',
  'Never use shell background or relaunch loops',
  'do not edit or remove a worktree with a live handoff',
]);
export const SCOPE_REQUIRED_MARKERS = Object.freeze({
  'src-server': ['windowsHide: true'],
  'src-ui': ['React Query', 'setLayout'],
  scripts: ['windowsHide: true'],
});

export function scopeForPath(path) {
  const normalized = String(path).replaceAll('\\', '/').replace(/^\.\//, '');
  return SCOPES.filter(
    (scope) =>
      scope.routes.some((prefix) => normalized.startsWith(prefix)) ||
      scope.rootFiles?.includes(normalized),
  );
}

export function instructionFilesForScope(scope) {
  return [`${scope.directory}/AGENTS.md`, `${scope.directory}/CLAUDE.md`];
}
