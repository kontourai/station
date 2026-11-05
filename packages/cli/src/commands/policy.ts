import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  MANAGED_POLICY_SCHEMA_VERSION,
  type ManagedPolicyDigest,
  type ManagedPolicyDocument,
  type ManagedPolicyProblem,
  type ManagedPolicySourceDescriptor,
  type ManagedPolicyStatus,
  type ManagedPolicySummary,
  parseManagedPolicyStatus,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import {
  decodeManagedPolicy,
  loadInstalledManagedPolicy,
  ManagedPolicyInvalidError,
  managedPolicyDigest,
  managedPolicyFilePath,
  readManagedPolicyFile,
  SYSTEM_MANAGED_POLICY_OWNERSHIP,
} from '@kontourai/station-shared/managed-policy';
import {
  MANAGED_POLICY_TEMPLATE_FILES,
  managedPolicyAdml,
  managedPolicyAdmx,
  managedPolicyMobileconfig,
} from '@kontourai/station-shared/managed-policy-templates';
import {
  configureApiCredential,
  parseCoreArgs,
  requestJson,
  resolveApiBaseDetailed,
} from './core-api.js';

const USAGE =
  'Usage: station policy check <file> [--json] | station policy show [--json] | station policy templates <dir> [--policy <file>]';
/** The profile's document when no `--policy` is given; it names no real organization. */
const PLACEHOLDER_ORGANIZATION = 'Example Organization';
const MANAGED_POLICY_ROUTE = '/api/settings/managed-policy';

function describeEffect(
  document: ManagedPolicyDocument,
  summary: ManagedPolicySummary,
): string[] {
  const settings = Object.keys(document.settings ?? {}).length;
  const limits = Object.keys(document.limits ?? {}).length;
  return [
    `  Organization: ${summary.organization} (users see "Managed by ${summary.organization}")`,
    `  Support link: ${summary.supportUrl ?? 'none'}`,
    `  Managed settings: ${settings === 0 ? 'none' : settings}`,
    `  Limits: ${limits === 0 ? 'none' : limits}`,
  ];
}

interface CheckReport {
  valid: boolean;
  path: string;
  digest?: ManagedPolicyDigest;
  summary?: ManagedPolicySummary;
  reason?: string;
  problems?: readonly ManagedPolicyProblem[];
}

/**
 * `station policy check <file>`: offline. Runs the decoder the server runs at
 * startup. At the system policy path it also applies the server's ownership
 * rule; elsewhere it cannot, so a file checked before installation must still
 * be installed as root (see the managed policy guide).
 */
function runCheck(file: string, json: boolean): void {
  const path = isAbsolute(file) ? file : resolve(file);
  let report: CheckReport;
  let document: ManagedPolicyDocument | undefined;
  try {
    const raw = readManagedPolicyFile(
      path,
      path === managedPolicyFilePath()
        ? SYSTEM_MANAGED_POLICY_OWNERSHIP
        : undefined,
    );
    if (!raw)
      throw new ManagedPolicyInvalidError(path, 'no file exists at this path');
    document = decodeManagedPolicy(path, raw);
    report = {
      valid: true,
      path,
      digest: managedPolicyDigest(document),
      summary: summarizeManagedPolicy(document),
    };
  } catch (error) {
    if (!(error instanceof ManagedPolicyInvalidError)) throw error;
    report = {
      valid: false,
      path,
      reason: error.reason,
      ...(error.problems.length > 0 ? { problems: error.problems } : {}),
    };
  }
  if (!report.valid) process.exitCode = 1;
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!report.valid) {
    console.error(
      `Policy ${path} is not valid: Station would refuse to start.`,
    );
    if (report.problems)
      for (const problem of report.problems)
        console.error(
          `  ${problem.path ? `${problem.path}: ` : ''}${problem.message}`,
        );
    else console.error(`  ${report.reason}`);
    return;
  }
  console.log(`Policy ${path} is valid.`);
  for (const line of describeEffect(
    document as ManagedPolicyDocument,
    report.summary as ManagedPolicySummary,
  ))
    console.log(line);
  console.log(`  Fingerprint: ${report.digest}`);
  console.log(
    `Install it at ${managedPolicyFilePath()} and restart Station to apply it.`,
  );
}

type InstalledState =
  | { state: 'none'; path: string }
  | {
      state: 'installed';
      source: ManagedPolicySourceDescriptor;
      digest: ManagedPolicyDigest;
      summary: ManagedPolicySummary;
    }
  | { state: 'invalid'; error: string };

type RunningState =
  | { state: 'read'; apiBase: string; status: ManagedPolicyStatus }
  | { state: 'not-local'; apiBase: string }
  | { state: 'unavailable'; apiBase: string; reason: string };

function isLoopbackApiBase(apiBase: string): boolean {
  const host = new URL(apiBase).hostname;
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

async function readRunning(args: string[]): Promise<RunningState> {
  const parsed = parseCoreArgs(args);
  const { apiBase } = resolveApiBaseDetailed(parsed);
  // The installed policy is this machine's; another machine's server loaded
  // that machine's policy, so comparing the two would mislead.
  if (!isLoopbackApiBase(apiBase)) return { state: 'not-local', apiBase };
  try {
    configureApiCredential(parsed, apiBase);
    const data = await requestJson<unknown>(apiBase, MANAGED_POLICY_ROUTE);
    const status = parseManagedPolicyStatus(data);
    if (!status)
      return {
        state: 'unavailable',
        apiBase,
        reason: 'the server returned an unrecognized policy status',
      };
    return { state: 'read', apiBase, status };
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    return {
      state: 'unavailable',
      apiBase,
      reason:
        status === 404
          ? 'the running Station is older than managed policy; update it'
          : status === undefined
            ? `no Station answered (${error instanceof Error ? error.message : String(error)})`
            : `the server refused the read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

function readInstalled(): InstalledState {
  try {
    const loaded = loadInstalledManagedPolicy();
    if (!loaded) return { state: 'none', path: managedPolicyFilePath() };
    return {
      state: 'installed',
      source: loaded.source,
      digest: loaded.digest,
      summary: loaded.summary,
    };
  } catch (error) {
    if (!(error instanceof ManagedPolicyInvalidError)) throw error;
    return { state: 'invalid', error: error.message };
  }
}

/** Whether the running server must restart to load what is installed. */
function restartNeeded(
  installed: InstalledState,
  running: RunningState,
): boolean | null {
  if (running.state !== 'read' || installed.state === 'invalid') return null;
  const loaded = running.status;
  if (installed.state === 'none') return loaded.state !== 'none';
  return loaded.state !== 'loaded' || loaded.digest !== installed.digest;
}

/**
 * `station policy show`: the installed policy and its fingerprint, compared
 * with what the running local server loaded at its startup.
 */
async function runShow(args: string[], json: boolean): Promise<void> {
  const installed = readInstalled();
  const running = await readRunning(args);
  const restart = restartNeeded(installed, running);
  if (installed.state === 'invalid') process.exitCode = 1;
  if (json) {
    console.log(
      JSON.stringify({ installed, running, restartNeeded: restart }, null, 2),
    );
    return;
  }

  if (installed.state === 'none')
    console.log(`Installed policy: none (${installed.path} does not exist)`);
  else if (installed.state === 'invalid') {
    console.log('Installed policy: INVALID');
    console.log(`  ${installed.error}`);
  } else {
    console.log(
      `Installed policy: ${installed.source.location}${installed.source.kind === 'test-override' ? ' (test override)' : ''}`,
    );
    console.log(`  Organization: ${installed.summary.organization}`);
    console.log(`  Support link: ${installed.summary.supportUrl ?? 'none'}`);
    console.log(`  Fingerprint: ${installed.digest}`);
  }

  if (running.state === 'not-local') {
    console.log(
      `Running server: not compared; ${running.apiBase} is not on this machine.`,
    );
  } else if (running.state === 'unavailable') {
    console.log(
      `Running server: unknown at ${running.apiBase}; ${running.reason}.`,
    );
  } else if (running.status.state === 'none') {
    console.log(`Running server (${running.apiBase}): loaded no policy`);
  } else {
    console.log(
      `Running server (${running.apiBase}): loaded ${running.status.source.location}`,
    );
    console.log(`  Fingerprint: ${running.status.digest}`);
  }

  if (installed.state === 'invalid')
    console.log(
      'A restart would fail: Station refuses to start with this policy.',
    );
  else if (restart === true)
    console.log(
      'Restart needed: the running server did not load the installed policy.',
    );
  else if (restart === false)
    console.log(
      installed.state === 'none'
        ? 'The running server matches: no policy is installed or loaded.'
        : 'The running server loaded the installed policy.',
    );
}

/** `templates <dir> [--policy <file>]`, also accepting `--policy=<file>`. */
function parseTemplatesArgs(args: string[]): { dir: string; policy?: string } {
  const positionals: string[] = [];
  let policy: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--policy') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--') || policy !== undefined)
        throw new Error(USAGE);
      policy = next;
      i++;
    } else if (arg.startsWith('--policy=')) {
      if (policy !== undefined || arg.length === '--policy='.length)
        throw new Error(USAGE);
      policy = arg.slice('--policy='.length);
    } else if (arg.startsWith('--')) {
      throw new Error(USAGE);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) throw new Error(USAGE);
  return { dir: positionals[0], ...(policy === undefined ? {} : { policy }) };
}

/**
 * `station policy templates <dir>`: the Group Policy template (ADMX and its
 * en-US ADML) and a macOS configuration profile. With `--policy`, the
 * profile carries that file's document after the same validation as
 * `policy check`; without it, a placeholder organization to replace. Nothing
 * is written unless every file can be.
 */
function runTemplates(args: string[]): void {
  const { dir, policy } = parseTemplatesArgs(args);
  const root = resolve(dir);
  let document: ManagedPolicyDocument = {
    schemaVersion: MANAGED_POLICY_SCHEMA_VERSION,
    organization: PLACEHOLDER_ORGANIZATION,
  };
  if (policy !== undefined) {
    const path = resolve(policy);
    try {
      const raw = readManagedPolicyFile(path);
      if (!raw)
        throw new ManagedPolicyInvalidError(
          path,
          'no file exists at this path',
        );
      document = decodeManagedPolicy(path, raw);
    } catch (error) {
      if (!(error instanceof ManagedPolicyInvalidError)) throw error;
      console.error(`Policy ${path} is not valid; no templates were written.`);
      console.error(`  ${error.reason}`);
      process.exitCode = 1;
      return;
    }
  }
  const profile = managedPolicyMobileconfig(document);
  if (!profile.ok) {
    console.error(`Cannot make a configuration profile: ${profile.reason}.`);
    process.exitCode = 1;
    return;
  }
  const files: Array<[string, string]> = [
    [MANAGED_POLICY_TEMPLATE_FILES.mobileconfig, profile.profile],
    [MANAGED_POLICY_TEMPLATE_FILES.admx, managedPolicyAdmx()],
    [MANAGED_POLICY_TEMPLATE_FILES.adml, managedPolicyAdml()],
  ];
  for (const [relative, content] of files) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    console.log(`Wrote ${target}`);
  }
  if (policy === undefined)
    console.log(
      `The profile names "${PLACEHOLDER_ORGANIZATION}". Run again with --policy <file> to put your policy in it.`,
    );
  console.log(
    'Copy station.admx and en-US\\station.adml to PolicyDefinitions; see docs/guides/managed-policy.md.',
  );
}

export async function runPolicyCommand(args: string[]): Promise<void> {
  const parsed = parseCoreArgs(args);
  const [action, ...rest] = parsed.positionals;
  const json = parsed.flags.json === true;
  if (parsed.flags.json !== undefined && !json) throw new Error(USAGE);
  const flags = Object.keys(parsed.flags);
  if (action === 'check') {
    if (rest.length !== 1 || flags.some((flag) => flag !== 'json'))
      throw new Error(USAGE);
    runCheck(rest[0], json);
    return;
  }
  if (action === 'templates') {
    runTemplates(args.slice(args.indexOf('templates') + 1));
    return;
  }
  if (action === 'show') {
    if (
      rest.length !== 0 ||
      flags.some(
        (flag) => !['json', 'api-base', 'station', 'credential'].includes(flag),
      )
    )
      throw new Error(USAGE);
    await runShow(args, json);
    return;
  }
  throw new Error(USAGE);
}
