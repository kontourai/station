import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// The real (unmocked) implementation — this file's other tests mock
// '../commands/environment.js' only inside `loadCli()`'s per-test module
// registry, which does not affect this static top-level import.
import { runEnvironmentCommand } from '../commands/environment.js';
import {
  actionsFor,
  commandHelpText,
  didYouMean,
  knownCommands,
  suggest,
  usageText,
} from '../help.js';

let originalStationHome: string | undefined;
let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalStationHome = process.env.STATION_HOME;
  originalExitCode = process.exitCode;
  delete process.env.STATION_HOME;
  process.exitCode = undefined;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalStationHome === undefined) delete process.env.STATION_HOME;
  else process.env.STATION_HOME = originalStationHome;
  process.exitCode = originalExitCode;
  vi.resetModules();
  vi.restoreAllMocks();
});

/**
 * The CLI dispatcher with every side-effecting command module stubbed, so a
 * help/version/unknown-input assertion can never reach a real build, HTTP
 * request, or filesystem mutation.
 */
async function loadCli() {
  vi.doMock('../commands/build.js', () => ({ build: vi.fn() }));
  vi.doMock('../commands/config.js', () => ({
    configGet: vi.fn(),
    configSet: vi.fn(),
  }));
  vi.doMock('../commands/core.js', () => ({ runCoreCommand: vi.fn() }));
  vi.doMock('../commands/environment.js', () => ({
    runEnvironmentCommand: vi.fn(),
  }));
  vi.doMock('../commands/export.js', () => ({ exportConfig: vi.fn() }));
  vi.doMock('../commands/profile-command.js', () => ({
    runStationsCommand: vi.fn(),
  }));
  vi.doMock('../commands/import.js', () => ({ importConfig: vi.fn() }));
  vi.doMock('../commands/init.js', () => ({
    createPlugin: vi.fn(),
    init: vi.fn(),
  }));
  vi.doMock('../commands/install-registry.js', () => ({
    recordRegistryInstall: vi.fn(),
    resolveRegistryPluginSource: vi.fn(),
  }));
  vi.doMock('../commands/install.js', () => ({
    info: vi.fn(),
    install: vi.fn(),
    installRegistryPlugin: vi.fn(),
    list: vi.fn(),
    preview: vi.fn(),
    registry: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
  }));
  vi.doMock('../commands/lifecycle.js', () => ({
    buildApplication: vi.fn(),
    clean: vi.fn(),
    doctor: vi.fn(),
    doctorJson: vi.fn(),
    link: vi.fn(),
    readBuildManifest: vi.fn(() => null),
    shortcut: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    upgrade: vi.fn(),
    validateLifecyclePorts: vi.fn(),
  }));
  vi.doMock('../commands/service.js', () => ({ runServiceCommand: vi.fn() }));
  vi.doMock('../commands/surfaces.js', () => ({
    runRegistryCatalogCommand: vi.fn(),
    runSurfaceCommand: vi.fn(),
  }));
  vi.doMock('../dev/server.js', () => ({ startDevServer: vi.fn() }));

  const { runCli } = await import('../cli.js');
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const printed = () => stdout.mock.calls.map((call) => call[0]).join('\n');
  const errored = () => stderr.mock.calls.map((call) => call[0]).join('\n');
  return { runCli, stdout, stderr, printed, errored };
}

describe('--version', () => {
  test.each(['--version', '-v', 'version'])(
    '%s prints the CLI version and exits 0',
    async (flag) => {
      const { runCli, printed } = await loadCli();

      await runCli([flag]);

      expect(printed()).toMatch(/^station \d+\.\d+\.\d+/);
      expect(process.exitCode).toBeUndefined();
    },
  );

  test('labels a source checkout as development without reading a backend manifest', async () => {
    const { versionText } = await import('../commands/version.js');

    expect(versionText()).toContain('development source checkout');
  });

  test('reports source development provenance on a second line', async () => {
    const { versionText } = await import('../commands/version.js');

    expect(versionText()).toContain('immutable build timestamp unavailable');
    expect(versionText().trim().split('\n')).toHaveLength(3);
  });
});

describe('top-level help', () => {
  test('is a grouped one-line-per-command summary, not a flag wall', async () => {
    const text = usageText();

    expect(text.split('\n').length).toBeLessThan(80);
    for (const group of [
      'Lifecycle:',
      'Stations:',
      'Configuration:',
      'Plugins:',
      'Core Workspace:',
      'Setup:',
    ]) {
      expect(text).toContain(group);
    }
    expect(text).toContain('station <command> --help');
    expect(text).toContain('station --version');
    // The per-command flag detail moved into per-command help.
    expect(text).not.toContain('--allow-default-home-clean');
  });

  test('every documented command still appears', async () => {
    const text = usageText();
    for (const command of knownCommands()) {
      if (command === 'version') continue;
      expect(text).toContain(`station ${command}`);
    }
  });
});

describe('lifecycle runtime defaults', () => {
  test('uses the shared stable channel contract and never presents the root as a runtime home', () => {
    const start = commandHelpText('start');
    const service = commandHelpText('service');
    const home = commandHelpText('home');
    const fresh = commandHelpText('fresh');

    for (const text of [start, service, home, fresh]) {
      expect(text).toContain('<STATION_ROOT>/instances/stable');
      expect(text).not.toContain('default: ~/.station');
    }
    for (const text of [start, service]) {
      expect(text).toContain('resolved default: 18141');
      expect(text).toContain('resolved default: 18000');
      expect(text).not.toContain('Server port (default: 3141)');
      expect(text).not.toContain('UI port (default: 3000)');
    }
    expect(commandHelpText('dev')).toContain(
      '<STATION_ROOT>/instances/dev/<worktree-id>',
    );
    expect(commandHelpText('dev')).not.toContain('~/.station-dev');
    expect(fresh).toContain('selected channel default home');
  });
});

describe('tasks help inventory', () => {
  test('keeps the complete protected-reference command surface exact', () => {
    expect(commandHelpText('tasks')).toContain(
      'List, get, create, attach exact answers, inputs, or tool results, support them, and keep immutable task outputs',
    );
    expect(actionsFor('tasks')).toEqual([
      'list',
      'get',
      'create',
      'attach-turn',
      'show-turn',
      'attach-input',
      'show-inputs',
      'attach-result',
      'show-results',
      'basis',
      'show-support',
      'list-support-bundles',
      'list-support-claims',
      'attach-support',
      'replace-support',
      'remove-support',
      'list-outputs',
      'get-output',
      'keep-output',
      'download-output',
      'delete-output',
    ]);
    for (const usage of [
      'station tasks list|get|create [options]',
      'station tasks attach-turn <taskId> --session=<sessionId> --turn=<turnId>',
      'station tasks show-turn <taskId>',
      'station tasks attach-input <taskId> --session=<sessionId> --event=<eventId>',
      'station tasks show-inputs <taskId> [--json]',
      'station tasks attach-result <taskId> --session=<sessionId> --event=<eventId>',
      'station tasks show-results <taskId> [--json]',
      'station tasks show-support <taskId>',
      'station tasks list-support-bundles <taskId> --reference=<referenceId>',
      'station tasks list-support-claims <taskId> --reference=<referenceId> --bundle=<bundleId>',
      'station tasks attach-support <taskId> --reference=<referenceId> --bundle=<bundleId> --claim=<claimId>',
      'station tasks replace-support <taskId> --reference=<referenceId> --bundle=<bundleId> --claim=<claimId> --revision=<revision>',
      'station tasks remove-support <taskId> --reference=<referenceId> --revision=<revision>',
      'station tasks list-outputs|get-output <taskId> [outputId]',
      'station tasks keep-output <taskId> --path=<relativePath> --title=<title> --operation=<operationId>',
      'station tasks download-output <taskId> <outputId> --out=<absolute destination>',
      'station tasks delete-output <taskId> <outputId>',
    ]) {
      expect(commandHelpText('tasks')).toContain(usage);
    }
  });
});

describe('per-command help', () => {
  test.each([
    ['agents', 'station agents <action> [options]'],
    ['chat', 'station chat <agent> <message...>'],
    ['plugin', 'station plugin install <source>'],
    ['runs', 'station runs read <run-id>'],
    ['config', 'station config get <key>'],
    ['delegate', 'station delegate status <task-id>'],
  ])('station %s --help describes the command', async (command, expected) => {
    const { runCli, printed, stderr } = await loadCli();

    await runCli([command, '--help']);

    expect(printed()).toContain(expected);
    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test('-h is intercepted at any depth, not read as a positional', async () => {
    const { runCli, printed } = await loadCli();

    await runCli(['agents', 'get', 'my-agent', '-h']);

    expect(printed()).toContain('station agents —');
  });

  test('station help <verb> is the same help', async () => {
    const { runCli, printed } = await loadCli();

    await runCli(['help', 'knowledge']);

    expect(printed()).toContain('station knowledge —');
  });

  test('names the valid actions it will accept', async () => {
    const { runCli, printed } = await loadCli();

    await runCli(['connections', '--help']);

    for (const action of actionsFor('connections') ?? []) {
      expect(printed()).toContain(action);
    }
  });

  test('documents the manual-first credential recovery workflow', () => {
    const help = commandHelpText('connections');

    expect(help).toContain('station connections recovery <connection-id>');
    expect(help).toContain('station connections profiles <connection-id>');
    expect(help).toContain('profile-enroll');
    expect(help).toContain('recovery-policy');
    expect(help).toContain('--include-credentials');
    expect(help).toContain('profile-apply');
    expect(help).toContain('--confirm');
    expect(help).toContain('manual-first');
  });

  test('every action-bearing command documents its actions', () => {
    for (const command of knownCommands()) {
      const help = commandHelpText(command);
      expect(help, `missing help for ${command}`).toBeDefined();
      for (const action of actionsFor(command) ?? []) {
        expect(help, `${command} help omits ${action}`).toContain(action);
      }
    }
  });

  test('help for an unknown verb fails loudly rather than printing nothing', async () => {
    const { runCli, errored } = await loadCli();

    await runCli(['help', 'nonsense']);

    expect(process.exitCode).toBe(1);
    expect(errored()).toContain('Unknown command: nonsense');
  });
});

/**
 * station#4515 review M5: the usage-honesty audit in `environment.test.ts`
 * only reads `environment.ts`'s OWN thrown USAGE text — it cannot see
 * `help.ts`'s separate, hand-maintained `environment` entry (`station
 * environment --help` / `station help environment`), which is a second,
 * independent place the same "advertised flag the verb actually rejects (or
 * a flag the verb accepts that nothing advertises)" defect can live. This
 * closes that structural blind spot for the access family specifically —
 * the exact verbs station#4515 was filed about.
 */
describe('environment access family: help.ts and environment.ts agree (station#4515 review M5)', () => {
  const FAMILY_LINE_PATTERN =
    /station environment access ((?:[a-z]+\|)*[a-z]+)\b(.*)/;
  const FAMILY_VERBS = ['list', 'approve', 'deny', 'request'];

  function extractFamilyFlags(text: string): Record<string, Set<string>> {
    const result: Record<string, Set<string>> = {};
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      const match = FAMILY_LINE_PATTERN.exec(line);
      if (!match) continue;
      const verbs = match[1]!.split('|');
      const flags = new Set(
        Array.from(line.matchAll(/--([a-z][a-z0-9-]*)/g), (m) => m[1]!),
      );
      for (const verb of verbs) {
        if (!FAMILY_VERBS.includes(verb)) continue;
        result[verb] = flags;
      }
    }
    return result;
  }

  /** `environment.ts`'s own thrown USAGE text — the ground truth for what actually parses. */
  async function environmentUsageText(): Promise<string> {
    try {
      await runEnvironmentCommand(['not-a-real-verb'], {
        projectHome: '/tmp/station-home',
        stdout: () => {},
        stderr: () => {},
        isInteractive: false,
      });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('Expected the unknown-verb invocation to reject.');
  }

  test('help.ts advertises exactly the flags environment.ts actually parses for access list/approve/deny/request', async () => {
    const envUsage = await environmentUsageText();
    const helpUsage = commandHelpText('environment');
    expect(helpUsage).toBeDefined();

    const fromEnvironmentTs = extractFamilyFlags(envUsage);
    const fromHelpTs = extractFamilyFlags(helpUsage!);

    // Guards the parity check itself: fails loudly rather than silently
    // comparing two empty sets if either source's line shape ever changes
    // (e.g. a reformat that stops matching FAMILY_LINE_PATTERN).
    for (const verb of FAMILY_VERBS) {
      expect(
        fromEnvironmentTs[verb],
        `environment.ts USAGE names no "access ${verb}" line`,
      ).toBeDefined();
      expect(
        fromHelpTs[verb],
        `help.ts usage names no "access ${verb}" line`,
      ).toBeDefined();
      expect(
        [...fromHelpTs[verb]!].sort(),
        `help.ts advertises different flags than environment.ts parses for access ${verb}`,
      ).toEqual([...fromEnvironmentTs[verb]!].sort());
    }
  });
});

/**
 * #765 D3: `peers` was implemented, dispatched, and documented in
 * docs/reference/cli.md, yet absent from help.ts's `environment` entry — so
 * `station environment --help` disowned the exact command the Computers page
 * tells users to copy (`station environment peers add`, see
 * src-ui/src/views/connections-hub/peer-credential-command.ts and its parity
 * test). Same structural blind spot station#4515 review M5 closed for the
 * access family above: nothing compared help.ts's hand-maintained entry to
 * environment.ts's own USAGE.
 */
describe('environment peers family: help.ts and environment.ts agree (#765 D3)', () => {
  const PEERS_LINE_PATTERN = /station environment peers ([a-z]+)\b(.*)/;
  const PEERS_VERBS = ['list', 'add', 'remove'];

  function extractPeersFlags(text: string): Record<string, Set<string>> {
    const result: Record<string, Set<string>> = {};
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      const match = PEERS_LINE_PATTERN.exec(line);
      if (!match) continue;
      result[match[1]!] = new Set(
        Array.from(line.matchAll(/--([a-z][a-z0-9-]*)/g), (m) => m[1]!),
      );
    }
    return result;
  }

  /** `environment.ts`'s own thrown USAGE text — the ground truth for what actually parses. */
  async function environmentUsageText(): Promise<string> {
    try {
      await runEnvironmentCommand(['not-a-real-verb'], {
        projectHome: '/tmp/station-home',
        stdout: () => {},
        stderr: () => {},
        isInteractive: false,
      });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('Expected the unknown-verb invocation to reject.');
  }

  test('help.ts advertises exactly the flags environment.ts actually parses for peers list/add/remove', async () => {
    const fromEnvironmentTs = extractPeersFlags(await environmentUsageText());
    const fromHelpTs = extractPeersFlags(commandHelpText('environment')!);

    for (const verb of PEERS_VERBS) {
      expect(
        fromEnvironmentTs[verb],
        `environment.ts USAGE names no "peers ${verb}" line`,
      ).toBeDefined();
      expect(
        fromHelpTs[verb],
        `help.ts usage names no "peers ${verb}" line`,
      ).toBeDefined();
      expect(
        [...fromHelpTs[verb]!].sort(),
        `help.ts advertises different flags than environment.ts parses for peers ${verb}`,
      ).toEqual([...fromEnvironmentTs[verb]!].sort());
    }
  });

  test('the actions vocabulary owns peers, so help and unknown-action suggestions agree', () => {
    expect(actionsFor('environment')).toContain('peers');
  });
});

describe('unknown input', () => {
  test('suggests the nearest command instead of dumping the manual', async () => {
    const { runCli, errored } = await loadCli();

    await runCli(['agnts']);

    expect(process.exitCode).toBe(1);
    expect(errored()).toContain('Unknown command: agnts');
    expect(errored()).toContain("Did you mean 'agents'?");
    expect(errored()).toContain('Run `station --help`');
    // The old behavior reprinted the whole usage text on stderr.
    expect(errored()).not.toContain('Core Workspace:');
  });

  test('an unknown plugin action names the valid ones', async () => {
    const { runCli, errored } = await loadCli();

    await runCli(['plugin', 'bogus']);

    expect(process.exitCode).toBe(1);
    expect(errored()).toContain('Unknown command: plugin bogus');
    expect(errored()).toContain('Valid plugin actions:');
    expect(errored()).toContain('install');
  });

  test('an unknown plugin action close to a real one suggests it', async () => {
    const { runCli, errored } = await loadCli();

    await runCli(['plugin', 'instal']);

    expect(errored()).toContain("Did you mean 'install'?");
  });

  test('an unknown config action names get/set', async () => {
    const { runCli, errored } = await loadCli();

    await runCli(['config', 'sett', 'key', 'value']);

    expect(process.exitCode).toBe(1);
    expect(errored()).toContain('Unknown command: config sett');
    expect(errored()).toContain('Valid config actions: get, set');
    expect(errored()).toContain("Did you mean 'set'?");
  });
});

describe('did-you-mean', () => {
  test('matches a prefix outright', () => {
    expect(suggest('conn', knownCommands())).toBe('connections');
  });

  test('tolerates a typo proportional to the word length', () => {
    expect(suggest('agnts', ['agents', 'auth'])).toBe('agents');
    expect(suggest('notificatons', ['notifications'])).toBe('notifications');
  });

  test('stays silent rather than guessing wildly', () => {
    expect(suggest('zzzzzzzz', knownCommands())).toBeUndefined();
    expect(didYouMean('zzzzzzzz', knownCommands())).toBe('');
  });
});
