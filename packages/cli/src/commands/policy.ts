import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  MANAGED_POLICY_SCHEMA_VERSION,
  MANAGED_SETTING_NARROWER_SCOPES,
  type ManagedPolicyDigest,
  type ManagedPolicyDocument,
  type ManagedPolicyProblem,
  type ManagedPolicySourceDescriptor,
  type ManagedPolicyStatus,
  type ManagedPolicySummary,
  managedApprovalModeName,
  managedSettingsSchemaError,
  parseManagedPolicyStatus,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import {
  decodeManagedPolicy,
  ManagedPolicyInvalidError,
  managedPolicyDigest,
  managedPolicyFilePath,
  readManagedPolicyFile,
  SYSTEM_MANAGED_POLICY_OWNERSHIP,
  systemManagedPolicySources,
} from '@kontourai/station-shared/managed-policy';
import {
  MANAGED_POLICY_TEMPLATE_FILES,
  managedPolicyAdml,
  managedPolicyAdmx,
  managedPolicyMobileconfig,
} from '@kontourai/station-shared/managed-policy-templates';
import {
  loadInstalledManagedPolicyChecked,
  validateAppConfigOffline,
} from './app-config-schema.js';
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

/**
 * #4518: each limit the policy enforces, by name and value, e.g.
 * "Approval ceiling: Ask first (maxApprovalMode: ask)".
 */
/**
 * The names of the limits a policy sets, never their values (a value can name
 * an internal endpoint: a mirror, a gateway), as `summary.engines` lists
 * field names. The approval ceiling (#4518), which clients see anyway, is
 * spelled out below.
 */
function describeLimits(
  names: readonly string[],
  limits: ManagedPolicySummary['limits'],
): string[] {
  if (names.length === 0) return ['  Limits: none'];
  const lines = [`  Limits: ${names.join(', ')}`];
  if (limits.maxApprovalMode)
    lines.push(
      `    Approval ceiling: ${managedApprovalModeName(limits.maxApprovalMode)} (maxApprovalMode: ${limits.maxApprovalMode})${
        limits.maxApprovalMode === 'never' ? ', restricts nothing' : ''
      }`,
    );
  return lines;
}

const SETTING_VALUE_DISPLAY_MAX_CHARS = 80;

function displaySettingValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length > SETTING_VALUE_DISPLAY_MAX_CHARS
    ? `${text.slice(0, SETTING_VALUE_DISPLAY_MAX_CHARS)}… (${text.length} characters)`
    : text;
}

/** One line per managed setting saying what it does (#4517). */
function describeSettings(document: ManagedPolicyDocument): string[] {
  const entries = Object.entries(document.settings ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (entries.length === 0) return ['  Managed settings: none'];
  const lines = [`  Managed settings: ${entries.length}`];
  for (const [key, entry] of entries) {
    const definition = APP_SETTINGS_REGISTRY.find(
      (candidate) => candidate.key === key,
    );
    const label = definition ? ` (${definition.label})` : '';
    lines.push(
      entry.locked
        ? `    ${key}${label}: locked to ${displaySettingValue(entry.value)}; the Station value and project overrides cannot be changed`
        : `    ${key}${label}: defaults to ${displaySettingValue(entry.value)} where nothing closer is set; users can change it`,
    );
    // What the lock does not cover: narrower values that still decide.
    const narrower = Object.hasOwn(MANAGED_SETTING_NARROWER_SCOPES, key)
      ? MANAGED_SETTING_NARROWER_SCOPES[key]
      : undefined;
    if (entry.locked && narrower) lines.push(`      Not covered: ${narrower}`);
  }
  return lines;
}

function describeEffect(
  document: ManagedPolicyDocument,
  summary: ManagedPolicySummary,
): string[] {
  return [
    `  Organization: ${summary.organization} (users see "Managed by ${summary.organization}")`,
    `  Support link: ${summary.supportUrl ?? 'none'}`,
    ...describeSettings(document),
    ...describeLimits(Object.keys(document.limits ?? {}), summary.limits),
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
 * `station policy check <file>`: offline. Runs the decoder and the managed
 * settings schema check the server runs at startup. At the system policy path it also applies the server's ownership
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
    // #4517: the settings schema check server startup runs before it
    // listens (`assertManagedSettingsValid`), with the same schema and rules.
    const schemaProblem = managedSettingsSchemaError(
      document.settings,
      validateAppConfigOffline,
    );
    if (schemaProblem)
      throw new ManagedPolicyInvalidError(
        path,
        `a managed setting does not match the settings schema (${schemaProblem})`,
      );
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
  | { state: 'none'; path: string; checked: string[] }
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

/**
 * The installed policy as `show` reports it, and its document for the
 * human-readable lines. The document stays out of the JSON report: it can
 * carry values the summary withholds (a mirror URL, a pinned gateway).
 */
function readInstalled(): {
  installed: InstalledState;
  document?: ManagedPolicyDocument;
} {
  try {
    const loaded = loadInstalledManagedPolicyChecked();
    if (!loaded)
      return {
        installed: {
          state: 'none',
          path: managedPolicyFilePath(),
          checked: systemManagedPolicySources().map(
            (source) => source.descriptor.location,
          ),
        },
      };
    return {
      installed: {
        state: 'installed',
        source: loaded.source,
        digest: loaded.digest,
        summary: loaded.summary,
      },
      document: loaded.document,
    };
  } catch (error) {
    if (!(error instanceof ManagedPolicyInvalidError)) throw error;
    return { installed: { state: 'invalid', error: error.message } };
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
  const { installed, document } = readInstalled();
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
    console.log(
      `Installed policy: none (nothing at ${installed.checked.join(' or ')})`,
    );
  else if (installed.state === 'invalid') {
    console.log('Installed policy: INVALID');
    console.log(`  ${installed.error}`);
  } else {
    console.log(
      `Installed policy: ${installed.source.location}${installed.source.kind === 'test-override' ? ' (test override)' : ''}`,
    );
    // The same lines `policy check` prints for the file (#4515).
    for (const line of describeEffect(
      document as ManagedPolicyDocument,
      installed.summary,
    ))
      console.log(line);
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
      // #4517: the settings schema check `check` and server startup run,
      // so a profile never carries a policy every server would refuse.
      const schemaProblem = managedSettingsSchemaError(
        document.settings,
        validateAppConfigOffline,
      );
      if (schemaProblem)
        throw new ManagedPolicyInvalidError(
          path,
          `a managed setting does not match the settings schema (${schemaProblem})`,
        );
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
