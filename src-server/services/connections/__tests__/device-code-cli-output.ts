/**
 * Byte-exact device-code output, captured live on macOS 2026-09-11 by running
 * each CLI against a throwaway config home and killing it before anything was
 * approved:
 *
 *   CODEX_HOME=$(mktemp -d)      codex login --device-auth
 *   XDG_CONFIG_HOME=$(mktemp -d) muse login
 *
 * Both codes below are from abandoned logins — never approved, and expired
 * within fifteen minutes of capture. They are kept verbatim because the point
 * of these fixtures is that the parser is proven against what the CLIs
 * actually emit, including the ANSI attributes codex writes even to a pipe,
 * rather than against a tidied-up transcription of them.
 *
 * `muse` is here for parser power, not because Station can enrol it: the muse
 * adapter has no `getAppHomeEnv`, so a muse credential profile would be signed
 * in and then never used by a session. Its output is a second, independently
 * shaped real example — no ANSI, code embedded in the URL query — which is
 * what makes the parser's structural assumptions testable rather than
 * codex-shaped by accident.
 */

/** `codex login --device-auth`, codex-cli 0.154.0. */
export const CODEX_DEVICE_CODE_STDOUT = [
  '',
  'Welcome to Codex [v[90m0.154.0[0m]',
  "[90mOpenAI's command-line coding agent[0m",
  '',
  'Follow these steps to sign in with ChatGPT using device code authorization:',
  '',
  '1. Open this link in your browser and sign in to your account',
  '   [94mhttps://auth.openai.com/codex/device[0m',
  '',
  '2. Enter this one-time code [90m(expires in 15 minutes)[0m',
  '   [94m7IEZ-B1FLE[0m',
  '',
  '[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.[0m',
  '',
  '',
].join('\n');

export const CODEX_DEVICE_CODE_EXPECTED = {
  verificationUri: 'https://auth.openai.com/codex/device',
  userCode: '7IEZ-B1FLE',
} as const;

/** `muse login`, Muse Code 1.1.1 (1.1.1-R2514.1). */
export const MUSE_DEVICE_CODE_STDOUT = [
  'Open this page to sign in:',
  '  https://auth.meta.com/oauth/device/?code=TVSX-HWFB',
  'confirm this code matches:',
  '  TVSX-HWFB',
  '',
  'Waiting for approval…',
  '',
].join('\n');

export const MUSE_DEVICE_CODE_EXPECTED = {
  verificationUri: 'https://auth.meta.com/oauth/device/?code=TVSX-HWFB',
  userCode: 'TVSX-HWFB',
} as const;

/**
 * `codex login --help`, captured the same way. The `--device-auth` entry has
 * an empty description in codex 0.154.0, which is why the capability probe
 * matches the flag rather than any prose around it.
 */
export const CODEX_LOGIN_HELP_STDOUT = [
  'Manage login',
  '',
  'Usage: codex login [OPTIONS] [COMMAND]',
  '',
  'Commands:',
  '  status  Show login status',
  '  help    Print this message or the help of the given subcommand(s)',
  '',
  'Options:',
  '      --with-api-key',
  '          Read the API key from stdin (e.g. `printenv OPENAI_API_KEY | codex login --with-api-key`)',
  '',
  '      --with-access-token',
  '          Read the access token from stdin',
  '',
  '      --device-auth',
  '          ',
  '',
  '  -h, --help',
  '          Print help (see a summary with `-h`)',
  '',
].join('\n');

/** `claude auth login --help`, Claude Code. No device or stdin token at all. */
export const CLAUDE_LOGIN_HELP_STDOUT = [
  'Usage: claude auth login [options]',
  '',
  'Sign in to your Anthropic account',
  '',
  'Options:',
  '  --claudeai       Use Claude subscription (default)',
  '  --console        Use Anthropic Console (API usage billing) instead of Claude',
  '                   subscription',
  '  --email <email>  Pre-populate email address on the login page',
  '  -h, --help       Display help for command',
  '  --sso            Force SSO login flow',
  '',
].join('\n');
