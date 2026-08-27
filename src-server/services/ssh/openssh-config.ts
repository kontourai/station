import { execFile } from 'node:child_process';
import { glob, readFile, stat } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const SSH_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const MAX_CONFIG_FILES = 128;
const MAX_INCLUDE_MATCHES = 256;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TOTAL_CONFIG_BYTES = 8 * 1024 * 1024;

/**
 * How long `ssh -G` may take. Exported because it is one leg of the probe's
 * total wall-clock ceiling, which the admission gate's `Retry-After` has to
 * reflect — a second constant chosen independently would drift.
 */
export const OPENSSH_CONFIG_RESOLVE_TIMEOUT_MS = 10_000;

export interface OpenSshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type OpenSshCommandRunner = (
  args: readonly string[],
) => Promise<OpenSshCommandResult>;

export interface ResolvedOpenSshHost {
  alias: string;
  hostname: string;
  user: string;
  port: number;
  identityAgent: 'default' | 'configured' | 'disabled';
  proxyJump: string | null;
  strictHostKeyChecking: string;
  /**
   * The trust stores THIS host resolves to, in `ssh`'s own order, already
   * `~`- and token-expanded by `ssh -G`. Empty only when OpenSSH reported
   * none. Callers must consult these rather than assuming
   * `~/.ssh/known_hosts`: an operator who sets `UserKnownHostsFile` has a
   * different file, and a probe that reads the default one would answer a
   * question CONNECT is not asking.
   */
  userKnownHostsFiles: string[];
}

export interface OpenSshDiscoveryResult {
  hosts: ResolvedOpenSshHost[];
  unavailableAliases: string[];
}

export function requireOpenSshAlias(value: string): string {
  const alias = value.trim();
  if (!SSH_ALIAS.test(alias)) {
    throw new Error(
      'SSH host alias must contain only letters, numbers, dots, underscores, or hyphens',
    );
  }
  return alias;
}

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? '22', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('OpenSSH returned an invalid port');
  }
  return port;
}

export function parseOpenSshGOutput(
  alias: string,
  output: string,
): ResolvedOpenSshHost {
  const values = new Map<string, string[]>();
  for (const rawLine of output.split(/\r?\n/)) {
    const separator = rawLine.search(/\s/);
    if (separator <= 0) continue;
    const key = rawLine.slice(0, separator).toLowerCase();
    const value = rawLine.slice(separator).trim();
    if (!value) continue;
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const last = (key: string): string | undefined => values.get(key)?.at(-1);
  const hostname = last('hostname');
  const user = last('user');
  if (!hostname || !user) {
    throw new Error('OpenSSH did not return a concrete host and user');
  }
  const rawAgent = last('identityagent')?.toLowerCase();
  return {
    alias: requireOpenSshAlias(alias),
    hostname,
    user,
    port: parsePort(last('port')),
    identityAgent:
      rawAgent === 'none' ? 'disabled' : rawAgent ? 'configured' : 'default',
    proxyJump:
      last('proxyjump') && last('proxyjump')?.toLowerCase() !== 'none'
        ? (last('proxyjump') ?? null)
        : null,
    strictHostKeyChecking: last('stricthostkeychecking') ?? 'ask',
    // `ssh -G` prints the whole list on one line, space separated, with
    // `~` and `%d`-style tokens already expanded. Tokenized with the
    // config parser's own splitter so a quoted path containing spaces
    // survives, rather than a second splitting rule that disagrees with it.
    userKnownHostsFiles: tokenizeOpenSshLine(last('userknownhostsfile') ?? ''),
  };
}

export function createSystemOpenSshRunner(
  options: { sshPath?: string; timeoutMs?: number; maxBuffer?: number } = {},
): OpenSshCommandRunner {
  const sshPath = options.sshPath ?? 'ssh';
  const timeoutMs = options.timeoutMs ?? OPENSSH_CONFIG_RESOLVE_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? 256 * 1024;
  return (args) =>
    new Promise((resolvePromise, rejectPromise) => {
      execFile(
        sshPath,
        [...args],
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer },
        (error, stdout, stderr) => {
          if (error) {
            rejectPromise(
              new Error(
                stderr.trim() || 'The system OpenSSH client is unavailable',
              ),
            );
            return;
          }
          resolvePromise({ stdout, stderr, exitCode: 0 });
        },
      );
    });
}

export async function resolveOpenSshHost(
  alias: string,
  runner: OpenSshCommandRunner = createSystemOpenSshRunner(),
): Promise<ResolvedOpenSshHost> {
  // `ssh -G` is the authority for effective config. The lightweight file scan
  // below only finds candidate names; it never reimplements Host/Match order,
  // canonicalization, Include inheritance, agent selection, or ProxyJump.
  const safeAlias = requireOpenSshAlias(alias);
  const result = await runner(['-G', '--', safeAlias]);
  if (result.exitCode !== 0) {
    throw new Error('OpenSSH could not resolve this host alias');
  }
  return parseOpenSshGOutput(safeAlias, result.stdout);
}

function tokenizeOpenSshLine(line: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#') break;
    if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = '';
      continue;
    }
    token += character;
  }
  if (token) tokens.push(token);
  return tokens;
}

function parseOpenSshDirective(line: string): string[] {
  const tokens = tokenizeOpenSshLine(line.trim());
  const first = tokens[0];
  if (!first) return [];
  const separator = first.indexOf('=');
  if (separator > 0) {
    return [
      first.slice(0, separator),
      first.slice(separator + 1),
      ...tokens.slice(1),
    ].filter(Boolean);
  }
  if (tokens[1] === '=') return [first, ...tokens.slice(2)];
  return tokens;
}

export function parseConcreteOpenSshAliases(content: string): string[] {
  const aliases = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const [keyword, ...values] = parseOpenSshDirective(line);
    if (keyword?.toLowerCase() !== 'host') continue;
    for (const value of values) {
      if (SSH_ALIAS.test(value)) aliases.add(value);
    }
  }
  return [...aliases];
}

interface OpenSshDiscoveryContext {
  env: NodeJS.ProcessEnv;
  homeDirectory: string;
  username: string;
  localHostname: string;
  localShortHostname: string;
  uid: number | undefined;
  includeRoot: string;
  includeMatches: number;
  totalBytes: number;
}

async function resolveTildeHome(
  username: string,
  context: OpenSshDiscoveryContext,
): Promise<string | null> {
  if (!username || username === context.username) return context.homeDirectory;
  if (process.platform === 'win32') return null;
  try {
    const passwd = await readFile('/etc/passwd', 'utf8');
    const entry = passwd
      .split('\n')
      .find((line) => line.split(':', 1)[0] === username);
    return entry?.split(':')[5] || null;
  } catch {
    return null;
  }
}

async function expandIncludeToken(
  token: string,
  context: OpenSshDiscoveryContext,
): Promise<string | null> {
  let expanded = token;
  const tilde = expanded.match(/^~([^/]*)/);
  if (tilde) {
    const home = await resolveTildeHome(tilde[1], context);
    if (!home) return null;
    expanded = `${home}${expanded.slice(tilde[0].length)}`;
  }
  let missingEnvironmentVariable = false;
  expanded = expanded.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, name: string) => {
      const value = context.env[name];
      if (value === undefined) missingEnvironmentVariable = true;
      return value ?? '';
    },
  );
  if (missingEnvironmentVariable) return null;
  const literalPercent = '\u0000';
  expanded = expanded
    .replace(/%%/g, literalPercent)
    .replace(/%d/g, context.homeDirectory)
    .replace(/%u/g, context.username)
    .replace(/%l/g, context.localHostname)
    .replace(/%L/g, context.localShortHostname)
    .replace(/%i/g, context.uid === undefined ? '' : String(context.uid));
  if (/%[A-Za-z%]/.test(expanded)) return null;
  expanded = expanded.replaceAll(literalPercent, '%');
  // OpenSSH uses glob(3), where adjacent stars do not recursively cross path
  // separators. Normalize them before Node's glob implementation.
  expanded = expanded.replace(/\*{2,}/g, '*');
  return isAbsolute(expanded)
    ? expanded
    : resolve(context.includeRoot, expanded);
}

async function collectAliasesFromFile(
  file: string,
  aliases: Set<string>,
  visited: Set<string>,
  context: OpenSshDiscoveryContext,
): Promise<void> {
  const absoluteFile = resolve(file);
  if (visited.has(absoluteFile) || visited.size >= MAX_CONFIG_FILES) return;
  visited.add(absoluteFile);
  let content: string;
  try {
    const fileStat = await stat(absoluteFile);
    if (
      !fileStat.isFile() ||
      fileStat.size > MAX_CONFIG_BYTES ||
      context.totalBytes + fileStat.size > MAX_TOTAL_CONFIG_BYTES
    ) {
      return;
    }
    context.totalBytes += fileStat.size;
    content = await readFile(absoluteFile, 'utf8');
  } catch {
    return;
  }
  for (const alias of parseConcreteOpenSshAliases(content)) aliases.add(alias);
  let conditionalScope = false;
  for (const line of content.split(/\r?\n/)) {
    const [keyword, ...patterns] = parseOpenSshDirective(line);
    if (keyword && /^(host|match)$/i.test(keyword)) conditionalScope = true;
    if (conditionalScope) continue;
    if (keyword?.toLowerCase() !== 'include') continue;
    for (const pattern of patterns) {
      const expanded = await expandIncludeToken(pattern, context);
      if (!expanded) continue;
      for await (const included of glob(expanded)) {
        context.includeMatches += 1;
        if (context.includeMatches > MAX_INCLUDE_MATCHES) return;
        await collectAliasesFromFile(included, aliases, visited, context);
        if (visited.size >= MAX_CONFIG_FILES) return;
      }
    }
  }
}

export async function discoverOpenSshAliases(
  options: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
  } = {},
): Promise<string[]> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const configPath =
    options.configPath ?? join(homeDirectory, '.ssh', 'config');
  const currentUser = userInfo();
  const localHostname = hostname();
  const aliases = new Set<string>();
  await collectAliasesFromFile(configPath, aliases, new Set(), {
    env: options.env ?? process.env,
    homeDirectory,
    username: currentUser.username,
    localHostname,
    localShortHostname: localHostname.split('.')[0],
    uid: process.getuid?.(),
    includeRoot: options.configPath
      ? dirname(resolve(configPath))
      : join(homeDirectory, '.ssh'),
    includeMatches: 0,
    totalBytes: 0,
  });
  return [...aliases].sort((left, right) => left.localeCompare(right));
}

export async function discoverOpenSshHosts(
  options: {
    aliases?: readonly string[];
    configPath?: string;
    runner?: OpenSshCommandRunner;
  } = {},
): Promise<OpenSshDiscoveryResult> {
  const aliases = options.aliases
    ? [...new Set(options.aliases.map(requireOpenSshAlias))]
    : await discoverOpenSshAliases({ configPath: options.configPath });
  const runner = options.runner ?? createSystemOpenSshRunner();
  const hosts: ResolvedOpenSshHost[] = [];
  const unavailableAliases: string[] = [];
  for (const alias of aliases) {
    try {
      hosts.push(await resolveOpenSshHost(alias, runner));
    } catch {
      unavailableAliases.push(alias);
    }
  }
  return { hosts, unavailableAliases };
}

export function redactOpenSshArgs(args: readonly string[]): string[] {
  const redacted: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const previous = args[index - 1];
    if (previous === '-S') {
      redacted.push('<control-path>');
    } else if (previous === '-L') {
      redacted.push('<loopback-forward>');
    } else if (previous === '-' && /^[A-Za-z0-9_-]+$/.test(value)) {
      redacted.push('<worker-payload>');
    } else if (/^(ControlPath|IdentityAgent|ProxyCommand)=/i.test(value)) {
      redacted.push(`${value.slice(0, value.indexOf('='))}=<redacted>`);
    } else {
      redacted.push(value);
    }
  }
  return redacted;
}
