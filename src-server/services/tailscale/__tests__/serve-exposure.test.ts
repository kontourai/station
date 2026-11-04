/**
 * #4519: the startup Tailscale Serve check proves "nothing forwards to this
 * server" or says it cannot. Every case drives the real classifier through
 * an injected command that answers the way the Tailscale CLI does; the
 * Serve shapes are the CLI's `serve status --json` output (hosts scrubbed).
 */
import { describe, expect, test } from 'vitest';
import {
  createTailscaleCommand,
  inspectTailscaleServeExposure,
  type TailscaleCommandResult,
} from '../serve-exposure.js';

const ok = (stdout: string): TailscaleCommandResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
});
const running = ok(JSON.stringify({ BackendState: 'Running', Self: {} }));

/** Answers `status` then `serve status`; records what was asked. */
function cli(
  status: TailscaleCommandResult,
  serve: TailscaleCommandResult = ok('{}'),
) {
  const asked: string[] = [];
  const command = async (args: readonly string[]) => {
    asked.push(args.join(' '));
    return args[0] === 'serve' ? serve : status;
  };
  return { command, asked };
}

/** A Serve configuration shaped like the CLI's, proxying HTTPS 443 to `port`. */
function serveTo(target: string) {
  return JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: {
      'node.example.ts.net:443': { Handlers: { '/': { Proxy: target } } },
    },
  });
}

describe('inspectTailscaleServeExposure', () => {
  test('clear when nothing can forward: not installed, daemon not running, stopped, logged out', async () => {
    expect(
      await inspectTailscaleServeExposure(
        [43141],
        cli({ exitCode: null, stdout: '', stderr: '', unavailable: true })
          .command,
      ),
    ).toEqual({ state: 'clear', reason: 'not-installed' });
    expect(
      await inspectTailscaleServeExposure(
        [43141],
        cli({
          exitCode: 1,
          stdout: '',
          stderr:
            "failed to connect to local tailscaled; it doesn't appear to be running (sudo systemctl start tailscaled ?)\n",
        }).command,
      ),
    ).toEqual({ state: 'clear', reason: 'not-running' });
    for (const [state, reason] of [
      ['Stopped', 'not-running'],
      ['NeedsLogin', 'logged-out'],
    ] as const) {
      const { command, asked } = cli(
        ok(JSON.stringify({ BackendState: state })),
      );
      expect(await inspectTailscaleServeExposure([43141], command)).toEqual({
        state: 'clear',
        reason,
      });
      // Serve cannot forward while idle, so it is not consulted.
      expect(asked).toEqual(['status --json']);
    }
  });

  test('clear when Serve is running but every route targets another port, or none exists', async () => {
    expect(
      await inspectTailscaleServeExposure(
        [43141, 43143],
        cli(running, ok(serveTo('http://127.0.0.1:3773'))).command,
      ),
    ).toEqual({ state: 'clear', reason: 'no-route' });
    // An unconfigured Serve prints nothing.
    expect(
      await inspectTailscaleServeExposure(
        [43141],
        cli(running, ok('')).command,
      ),
    ).toEqual({ state: 'clear', reason: 'no-route' });
  });

  test('mapped when a route forwards to one of the ports, whatever host it names', async () => {
    expect(
      await inspectTailscaleServeExposure(
        [43141, 43143, 43144],
        cli(running, ok(serveTo('http://127.0.0.1:43144'))).command,
      ),
    ).toEqual({ state: 'mapped', ports: [43144] });
    // A name can resolve to this server, so it counts.
    expect(
      await inspectTailscaleServeExposure(
        [43141],
        cli(running, ok(serveTo('http://localhost:43141'))).command,
      ),
    ).toEqual({ state: 'mapped', ports: [43141] });
    expect(
      await inspectTailscaleServeExposure(
        [43141],
        cli(
          running,
          ok(
            JSON.stringify({
              TCP: { '8443': { TCPForward: '127.0.0.1:43141' } },
            }),
          ),
        ).command,
      ),
    ).toEqual({ state: 'mapped', ports: [43141] });
  });

  test('fails closed when Tailscale is installed but its state cannot be read', async () => {
    const unreadable: Array<[string, ReturnType<typeof cli>]> = [
      // Installed but not answering: a timeout or signal has no exit code.
      ['no answer', cli({ exitCode: null, stdout: '', stderr: '' })],
      [
        'an unexplained error',
        cli({
          exitCode: 1,
          stdout: '',
          stderr: 'The Tailscale GUI failed to start\n',
        }),
      ],
      ['not JSON', cli(ok('Tailscale is starting…'))],
      ['no backend state', cli(ok('{}'))],
      ['an unknown backend state', cli(ok('{"BackendState":"Rebooting"}'))],
      [
        'a failing serve status',
        cli(running, { exitCode: 1, stdout: '', stderr: 'access denied\n' }),
      ],
      ['a serve status that is not JSON', cli(running, ok('nope'))],
      [
        'a Serve feature this build does not know',
        cli(running, ok(JSON.stringify({ Services: { 'svc:x': {} } }))),
      ],
    ];
    for (const [name, { command }] of unreadable) {
      const result = await inspectTailscaleServeExposure([43141], command);
      expect(result.state, name).toBe('unverifiable');
    }
    // The message on a "not running" exit is only trusted with an exit code.
    expect(
      (
        await inspectTailscaleServeExposure(
          [43141],
          cli({
            exitCode: null,
            stdout: '',
            stderr: "it doesn't appear to be running",
          }).command,
        )
      ).state,
    ).toBe('unverifiable');
  });
});

describe('createTailscaleCommand', () => {
  test('skips an absent executable, answers with the first installed one, even when it fails', async () => {
    const tried: string[] = [];
    const command = createTailscaleCommand('darwin', async (executable) => {
      tried.push(executable);
      return executable === 'tailscale'
        ? { exitCode: 1, stdout: '', stderr: 'boom' }
        : { exitCode: null, stdout: '', stderr: '', unavailable: true };
    });
    expect(await command(['status', '--json'])).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: 'boom',
    });
    expect(tried).toEqual([
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      'tailscale',
    ]);
  });

  test('reports unavailable only when no executable exists', async () => {
    const command = createTailscaleCommand('linux', async () => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      unavailable: true,
    }));
    expect((await command(['status'])).unavailable).toBe(true);
  });
});
