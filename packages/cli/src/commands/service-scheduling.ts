import type { CommandRunner, ServiceRegistration } from './service.js';
import { LAUNCHD_INTERACTIVE_PROCESS_TYPE } from './service-launchd.js';
import { WINDOWS_INTERACTIVE_TASK_PRIORITY } from './service-windows.js';
import {
  encodePowerShellCommand,
  windowsSystemUtilityPath,
} from './windows-path-trust.js';

const SYSTEMD_SCHEDULING_DIRECTIVES = new Set([
  'Nice',
  'CPUWeight',
  'StartupCPUWeight',
  'CPUQuota',
  'CPUQuotaPeriodSec',
  'CPUAffinity',
  'CPUSchedulingPolicy',
  'CPUSchedulingPriority',
  'CPUSchedulingResetOnFork',
  'IOSchedulingClass',
  'IOSchedulingPriority',
  'IOWeight',
  'StartupIOWeight',
  'Slice',
]);

export interface ServiceSchedulingPolicy {
  expected: string;
  observed?: string;
  reason?: string;
  /** A systemd drop-in deliberately changes the effective operator policy. */
  status: 'current' | 'operator-override' | 'stale' | 'unknown';
}

function unknown(expected: string, error: unknown): ServiceSchedulingPolicy {
  return {
    expected,
    reason: error instanceof Error ? error.message : String(error),
    status: 'unknown',
  };
}

function launchdSchedulingPolicy(
  registration: ServiceRegistration,
  run: CommandRunner,
): ServiceSchedulingPolicy {
  const expected = `ProcessType=${LAUNCHD_INTERACTIVE_PROCESS_TYPE}`;
  try {
    const result = run('plutil', [
      '-convert',
      'json',
      '-o',
      '-',
      registration.unitPath,
    ]);
    if (result.error || result.status !== 0) {
      throw new Error(
        result.error?.message ??
          result.stderr?.trim() ??
          `plutil exited ${result.status}`,
      );
    }
    const parsed: unknown = JSON.parse(result.stdout ?? '');
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      typeof parsed !== 'object'
    ) {
      throw new Error('plutil did not produce a top-level plist dictionary');
    }
    const processType = (parsed as Record<string, unknown>).ProcessType;
    const observed = `ProcessType=${typeof processType === 'string' ? processType : 'unset'}`;
    return {
      expected,
      observed,
      status: observed === expected ? 'current' : 'stale',
    };
  } catch (error) {
    return unknown(expected, error);
  }
}

interface SystemdDirective {
  key: string;
  path: string;
  value: string;
}

function systemdLogicalLines(content: string): string[] {
  const lines: string[] = [];
  let pending = '';
  for (const rawLine of content.split(/\r?\n/u)) {
    const trailingBackslashes =
      rawLine.match(/\\+\s*$/u)?.[0].trim().length ?? 0;
    if (trailingBackslashes % 2 === 1) {
      pending += `${rawLine.replace(/\\\s*$/u, '')} `;
      continue;
    }
    lines.push(`${pending}${rawLine}`);
    pending = '';
  }
  if (pending.length > 0)
    throw new Error('unterminated systemd line continuation');
  return lines;
}

/** Parse the fragments that systemd itself selected for `systemctl cat`. */
function parseSystemdCat(content: string): {
  directives: SystemdDirective[];
  paths: string[];
} {
  let path: string | undefined;
  let section: string | undefined;
  const directives: SystemdDirective[] = [];
  const paths: string[] = [];
  for (const rawLine of systemdLogicalLines(content)) {
    const line = rawLine.trim();
    const fragment = line.match(/^#\s+(\/\S.*)$/u);
    if (fragment) {
      path = fragment[1];
      paths.push(path);
      section = undefined;
      continue;
    }
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const sectionMatch = line.match(/^\[([A-Za-z][A-Za-z0-9]*)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const separator = line.indexOf('=');
    if (path === undefined || section === undefined || separator <= 0) {
      throw new Error('malformed systemd output from systemctl cat');
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) {
      throw new Error('malformed systemd output from systemctl cat');
    }
    if (section === 'Service' && SYSTEMD_SCHEDULING_DIRECTIVES.has(key)) {
      directives.push({ key, path, value: line.slice(separator + 1).trim() });
    }
  }
  return { directives, paths };
}

function systemdSchedulingPolicy(
  registration: ServiceRegistration,
  run: CommandRunner,
): ServiceSchedulingPolicy {
  const expected = 'systemd defaults';
  try {
    const unitName =
      registration.unitName ?? registration.unitPath.split('/').at(-1);
    if (!unitName)
      throw new Error('systemd registration is missing a unit name');
    // `systemctl cat` asks the user manager for the exact main fragment and
    // every loaded drop-in.  Unlike a directory scan, it includes the systemd
    // hierarchy (including dash-prefix and type drop-ins) without guessing
    // search paths ourselves.
    const result = run('systemctl', ['--user', 'cat', unitName]);
    if (result.error || result.status !== 0) {
      throw new Error(
        result.error?.message ??
          result.stderr?.trim() ??
          `systemctl exited ${result.status}`,
      );
    }
    const parsed = parseSystemdCat(result.stdout ?? '');
    if (!parsed.paths.includes(registration.unitPath)) {
      throw new Error('systemctl cat did not report the registered unit');
    }
    const { directives } = parsed;
    const mainDirectives = directives.filter(
      (directive) => directive.path === registration.unitPath,
    );
    if (mainDirectives.length > 0) {
      return {
        expected,
        observed: mainDirectives
          .map(({ key, value }) => `${key}=${value}`)
          .join(', '),
        status: 'stale',
      };
    }
    const overrides = directives.filter(
      (directive) => directive.path !== registration.unitPath,
    );
    if (overrides.length > 0) {
      return {
        expected,
        observed: `${overrides.map(({ key, value }) => `${key}=${value}`).join(', ')} (from ${overrides[0].path})`,
        status: 'operator-override',
      };
    }
    return {
      expected,
      observed: expected,
      status: 'current',
    };
  } catch (error) {
    return unknown(expected, error);
  }
}

function windowsSchedulingPolicy(
  registration: ServiceRegistration,
  run: CommandRunner,
): ServiceSchedulingPolicy {
  const expected = `Priority=${WINDOWS_INTERACTIVE_TASK_PRIORITY}`;
  if (!registration.taskName) {
    return unknown(
      expected,
      new Error('Windows task registration is missing a task name'),
    );
  }
  const payload = Buffer.from(
    JSON.stringify({ taskName: registration.taskName }),
    'utf8',
  ).toString('base64');
  const program = `$ErrorActionPreference = 'Stop'; $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json; $task = Get-ScheduledTask -TaskName $request.taskName.TrimStart('\\') -TaskPath '\\'; [int]$task.Settings.Priority`;
  const result = run(windowsSystemUtilityPath('powershell'), [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodePowerShellCommand(program),
  ]);
  if (result.error || result.status !== 0) {
    return unknown(
      expected,
      result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`,
    );
  }
  const priority = result.stdout?.match(/^\s*(\d+)\s*$/u)?.[1];
  if (priority === undefined) {
    return unknown(
      expected,
      new Error('Task Scheduler priority could not be parsed'),
    );
  }
  const observed = `Priority=${priority}`;
  return {
    expected,
    observed,
    status: observed === expected ? 'current' : 'stale',
  };
}

/** Read the scheduling policy recorded by an installed service registration. */
export function inspectServiceSchedulingPolicy(
  registration: ServiceRegistration,
  dependencies: {
    run: CommandRunner;
  },
): ServiceSchedulingPolicy {
  if (registration.platform === 'darwin')
    return launchdSchedulingPolicy(registration, dependencies.run);
  if (registration.platform === 'linux')
    return systemdSchedulingPolicy(registration, dependencies.run);
  return windowsSchedulingPolicy(registration, dependencies.run);
}

export function isSchedulingPolicyHealthy(
  scheduling: ServiceSchedulingPolicy,
): boolean {
  return (
    scheduling.status === 'current' || scheduling.status === 'operator-override'
  );
}
