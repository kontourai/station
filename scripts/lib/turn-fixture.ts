import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLabCommand } from './local-collaboration-process.mjs';

export const TURN_FIXTURE_IMAGE =
  'coturn/coturn@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3';

/** One pinned, loopback-only TURN container. Ownership exists before allocation. */
export function createTurnFixture(input: {
  directory: string;
  username: string;
  password: string;
  signal: AbortSignal;
  lifetimeSeconds?: number;
  failAfterCreate?: boolean;
}) {
  const lifetime = input.lifetimeSeconds ?? 120;
  assert(Number.isSafeInteger(lifetime) && lifetime >= 30 && lifetime <= 600);
  const owner = randomBytes(16).toString('hex');
  const name = `station-turn-${owner}`;
  let id: string | undefined;
  let started = false;
  let stopping: Promise<void> | undefined;
  const docker = async (args: string[]) => {
    const host =
      process.platform === 'win32'
        ? 'npipe:////./pipe/docker_engine'
        : 'unix:///var/run/docker.sock';
    const result = await runLabCommand(
      'docker',
      [
        '--host',
        host,
        '--config',
        join(input.directory, 'docker-config'),
        ...args,
      ],
      input.directory,
    );
    return args[0] === 'logs' ? result.stdout + result.stderr : result.stdout;
  };
  const stop = () =>
    (stopping ??= (async () => {
      if (!started) return;
      const ids = (
        await docker([
          'ps',
          '-a',
          '--no-trunc',
          '--filter',
          `label=station.fixture.owner=${owner}`,
          '--format',
          '{{.ID}}',
        ])
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      if (!ids.length) return;
      assert.equal(ids.length, 1, 'Ambiguous container ownership');
      const current = ids[0]!;
      assert.match(current, /^[a-f0-9]{64}$/);
      if (id) assert.equal(current, id);
      const fact = JSON.parse(
        await docker(['inspect', '--format', '{{json .}}', current]),
      );
      assert.equal(fact.Config.Image, TURN_FIXTURE_IMAGE);
      assert.equal(fact.Name, `/${name}`);
      assert.equal(fact.Config.Labels['station.fixture.owner'], owner);
      const errors: unknown[] = [];
      try {
        writeFileSync(
          join(input.directory, 'turn.log'),
          await docker(['logs', current]),
          { mode: 0o600 },
        );
      } catch (error) {
        errors.push(error);
      }
      try {
        if (fact.State.Running) await docker(['stop', '--time', '3', current]);
      } catch (error) {
        errors.push(error);
      }
      try {
        await docker(['rm', current]);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, 'TURN fixture cleanup failed');
    })());
  return {
    stop,
    async start() {
      if (started || stopping) throw new Error('TURN fixture already used');
      input.signal.throwIfAborted();
      writeFileSync(
        join(input.directory, 'container-owner.json'),
        JSON.stringify({ owner, name, image: TURN_FIXTURE_IMAGE }),
        { flag: 'wx', mode: 0o600 },
      );
      started = true;
      try {
        id = (
          await docker([
            'create',
            '--label',
            'station.fixture=browser-transport',
            '--label',
            `station.fixture.owner=${owner}`,
            '--name',
            name,
            '--init',
            '--read-only',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=16m',
            '--cap-drop',
            'ALL',
            '--cap-add',
            'NET_BIND_SERVICE',
            '--security-opt',
            'no-new-privileges',
            '--pids-limit',
            '64',
            '--memory',
            '128m',
            '--cpus',
            '1',
            '--publish',
            '127.0.0.1::3478/tcp',
            '--publish',
            '127.0.0.1::3478/udp',
            '--entrypoint',
            '/bin/sh',
            TURN_FIXTURE_IMAGE,
            '-c',
            `exec timeout -s TERM -k 5 ${lifetime} turnserver "$@"`,
            '--',
            '-n',
            '-v',
            '--log-file=stdout',
            '--simple-log',
            '--no-tls',
            '--relay-threads=1',
            '--listening-port=3478',
            '--lt-cred-mech',
            '--realm=station-fixture.invalid',
            `--user=${input.username}:${input.password}`,
            '--no-multicast-peers',
            '--min-port=50000',
            '--max-port=50031',
            '--pidfile=/tmp/turn.pid',
          ])
        ).trim();
        assert.match(id, /^[a-f0-9]{64}$/);
        if (input.failAfterCreate) {
          id = undefined;
          throw new Error('Injected failure after owned container allocation');
        }
        input.signal.throwIfAborted();
        await docker(['start', id]);
        const port = async (protocol: 'tcp' | 'udp') => {
          const published = (
            await docker(['port', id!, `3478/${protocol}`])
          ).trim();
          assert.match(published, /^127\.0\.0\.1:\d+$/);
          return Number(published.split(':').at(-1));
        };
        return { tcp: await port('tcp'), udp: await port('udp') };
      } catch (primary) {
        try {
          await stop();
        } catch (cleanup) {
          throw new AggregateError(
            [primary, cleanup],
            'TURN fixture startup failed',
          );
        }
        throw primary;
      }
    },
  };
}
