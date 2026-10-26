import type {
  CommandRunner,
  ServiceFs,
  ServiceRegistration,
} from './service.js';

/**
 * What an installed launchd or systemd unit itself records: the program and
 * arguments it starts and the environment it sets. Both units are named by
 * instance id alone, machine-wide, so the unit may have been written by an
 * install from another Station home than the one whose manifest a command
 * read (#4189). Guidance that must reproduce the running service reads it
 * here rather than trusting that manifest.
 */
export interface InstalledServiceUnit {
  /** The unit file read, so guidance can name what to inspect. */
  path: string;
  /**
   * The program and its arguments, unquoted; null when the unit names none,
   * or names it in a form Station never writes (systemd `%` specifiers).
   */
  argv: string[] | null;
  environment: Record<string, string>;
}

/**
 * Reverse of `unitQuote` in service-systemd.ts, generalized to the
 * whitespace-separated word list systemd accepts on one `Environment=` or
 * `ExecStart=` line.
 */
function systemdWords(value: string, directive: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/u.test(value[index])) index += 1;
    if (index >= value.length) break;
    let token = '';
    if (value[index] === '"') {
      index += 1;
      while (index < value.length && value[index] !== '"') {
        if (value[index] === '\\' && index + 1 < value.length) index += 1;
        token += value[index];
        index += 1;
      }
      if (index >= value.length) {
        throw new Error(`unterminated quote in the unit ${directive}= line`);
      }
      index += 1;
    } else {
      while (index < value.length && !/\s/u.test(value[index])) {
        token += value[index];
        index += 1;
      }
    }
    words.push(token);
  }
  return words;
}

/**
 * The `[Service]` section of the unit file Station wrote. Later assignments
 * win, as they do for systemd.
 */
function readSystemdUnit(
  registration: ServiceRegistration,
  fs: Pick<ServiceFs, 'readFileSync'>,
): InstalledServiceUnit {
  const content = fs.readFileSync(registration.unitPath, 'utf8');
  let section: string | undefined;
  let argv: string[] | null = null;
  const environment: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([A-Za-z][A-Za-z0-9]*)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== 'Service') continue;
    if (line.startsWith('Environment=')) {
      for (const word of systemdWords(
        line.slice('Environment='.length),
        'Environment',
      )) {
        const separator = word.indexOf('=');
        if (separator > 0) {
          environment[word.slice(0, separator)] = word.slice(separator + 1);
        }
      }
    } else if (line.startsWith('ExecStart=')) {
      const value = line.slice('ExecStart='.length);
      // Station's unitQuote refuses `%`, so a specifier means someone else
      // wrote this line and its words are not the literal arguments.
      // A malformed command is reported as absent rather than thrown, so it
      // does not also hide the unit's environment from the PATH check.
      try {
        argv = value.includes('%') ? null : systemdWords(value, 'ExecStart');
      } catch {
        argv = null;
      }
    }
  }
  return { argv, environment, path: registration.unitPath };
}

function readLaunchdUnit(
  registration: ServiceRegistration,
  run: CommandRunner,
): InstalledServiceUnit {
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
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('plutil did not produce a top-level plist dictionary');
  }
  const dictionary = parsed as Record<string, unknown>;
  const programArguments = dictionary.ProgramArguments;
  const argv =
    Array.isArray(programArguments) &&
    programArguments.every((argument) => typeof argument === 'string')
      ? (programArguments as string[])
      : null;
  const rawEnvironment = dictionary.EnvironmentVariables;
  const environment: Record<string, string> = {};
  if (
    rawEnvironment !== null &&
    !Array.isArray(rawEnvironment) &&
    typeof rawEnvironment === 'object'
  ) {
    for (const [key, value] of Object.entries(rawEnvironment)) {
      if (typeof value === 'string') environment[key] = value;
    }
  }
  return { argv, environment, path: registration.unitPath };
}

/**
 * Reads the installed unit of a launchd or systemd registration. Windows
 * keeps its wrapper under the home's own service directory, beside the
 * manifest written with it, so there is no machine-wide unit to read there.
 * Throws when the unit cannot be read.
 */
export function readInstalledServiceUnit(
  registration: ServiceRegistration,
  dependencies: { fs: Pick<ServiceFs, 'readFileSync'>; run: CommandRunner },
): InstalledServiceUnit {
  if (registration.platform === 'linux') {
    return readSystemdUnit(registration, dependencies.fs);
  }
  if (registration.platform === 'darwin') {
    return readLaunchdUnit(registration, dependencies.run);
  }
  throw new Error('Windows services have no machine-wide unit to read');
}
