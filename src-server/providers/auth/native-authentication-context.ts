import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { observeExecutableInvocation } from './executable-observation.js';
import { observeNativeAuthenticationFiles } from './native-authentication-files.js';

export interface NativeAuthenticationLaunch {
  command: string;
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
}

export interface NativeAuthenticationContinuation {
  assertCurrent(): void;
  invoke<T>(
    adapter: object,
    threadId: string,
    assertAdmissionCurrent: () => void,
    work: () => T,
  ): T;
}

const continuations = new WeakMap<object, NativeAuthenticationContinuation>();

export function retainNativeAuthenticationContinuation<T extends object>(
  observation: T,
  continuation: NativeAuthenticationContinuation | undefined,
): T {
  if (continuation) continuations.set(observation, continuation);
  return observation;
}

export function nativeAuthenticationContinuation(
  observation: object,
): NativeAuthenticationContinuation | undefined {
  return continuations.get(observation);
}

interface NativeAuthenticationScope {
  cwd: string;
  adapter: object;
  threadId: string;
  assertLaunch(launch: NativeAuthenticationLaunch): void;
  assertProfile(profileRef: string | null, cwd: string | undefined): void;
}

const nativeAuthentication = new AsyncLocalStorage<NativeAuthenticationScope>();

export function assertNativeAuthenticationProfile(
  adapter: object,
  threadId: string,
  profileRef: string | null,
  cwd: string | undefined,
): void {
  const scope = nativeAuthentication.getStore();
  if (!scope) return;
  if (scope.adapter !== adapter || scope.threadId !== threadId)
    throw new Error('ensemble_auth_receiver_changed');
  scope.assertProfile(profileRef, cwd);
}

/** Capture before lazy SDK work; the resulting guard belongs to this receiver only. */
export function captureNativeAuthenticationLaunch(
  adapter: object,
  threadId: string,
): ((launch: NativeAuthenticationLaunch) => void) | undefined {
  const scope = nativeAuthentication.getStore();
  if (!scope) return undefined;
  if (scope.adapter !== adapter || scope.threadId !== threadId)
    throw new Error('ensemble_auth_receiver_changed');
  return scope.assertLaunch;
}

export function nativeAuthenticationSpawnCwd(): string | undefined {
  return nativeAuthentication.getStore()?.cwd;
}

/** The default Codex factory resolves its actual executable synchronously here. */
export function assertNativeAuthenticationLaunch(
  launch: NativeAuthenticationLaunch,
): void {
  nativeAuthentication.getStore()?.assertLaunch(launch);
}

function environment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        ![
          'TMPDIR',
          'ENABLE_TOOL_SEARCH',
          'CLAUDE_CODE_ENTRYPOINT',
          'CLAUDE_AGENT_SDK_VERSION',
          'DEBUG',
        ].includes(entry[0]),
    ),
  );
}

function assertArguments(
  engine: 'codex' | 'claude',
  args: readonly string[],
  script?: string,
): void {
  if (engine === 'codex') {
    if (args[0] !== 'app-server')
      throw new Error('ensemble_auth_arguments_changed');
    const allowed = new Set([
      'mcp_servers',
      'permissions',
      'default_permissions',
      'sandbox_workspace_write',
      'approvals_reviewer',
    ]);
    for (let index = 1; index < args.length; index += 2) {
      if (
        !['-c', '--config'].includes(args[index]) ||
        args[index + 1] === undefined
      )
        throw new Error('ensemble_auth_arguments_changed');
      const override = parseToml(args[index + 1]);
      const keys = Object.keys(override);
      if (keys.length !== 1 || !allowed.has(keys[0]))
        throw new Error('ensemble_auth_arguments_changed');
    }
    return;
  }
  for (let index = script ? 1 : 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith('--')) continue;
    const [name] = argument.split('=', 1);
    if (
      /^--(?:config|profile|api-key|oauth-token|base-url|proxy|env|managed-settings|setting-sources|project-config-root)(?:$|-)/.test(
        name,
      )
    )
      throw new Error('ensemble_auth_arguments_changed');
    if (name !== '--settings') continue;
    const value = argument.includes('=')
      ? argument.slice(argument.indexOf('=') + 1)
      : args[++index];
    const settings: unknown = JSON.parse(value);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      throw new Error('ensemble_auth_arguments_changed');
    for (const [key, setting] of Object.entries(settings)) {
      if (
        !(
          (key === 'fastMode' && typeof setting === 'boolean') ||
          (key === 'disableAutoMode' && setting === 'disable')
        )
      )
        throw new Error('ensemble_auth_arguments_changed');
    }
  }
}

/** Private continuation of an executable/environment observation, never a grant. */
export async function observeNativeAuthenticationLaunch(input: {
  engine: 'codex' | 'claude';
  profileRef: string | null;
  command: string;
  script?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  assertCurrent(): void;
}): Promise<NativeAuthenticationContinuation | undefined> {
  const executable = await observeExecutableInvocation(
    input.command,
    input.script,
  );
  if (!executable) return undefined;
  const assertFiles = await observeNativeAuthenticationFiles(input);
  const expected = environment(
    input.engine === 'claude' &&
      !Object.keys(input.env).some(
        (key) => key.toUpperCase() === 'CLAUDE_CODE_SDK_READS_SESSION_STATE',
      )
      ? { ...input.env, CLAUDE_CODE_SDK_READS_SESSION_STATE: '1' }
      : input.env,
  );
  const assertCurrent = () => {
    input.assertCurrent();
    executable.assertCurrent();
    assertFiles();
    executable.assertCurrent();
    input.assertCurrent();
  };
  return {
    assertCurrent,
    invoke(adapter, threadId, assertAdmissionCurrent, work) {
      assertAdmissionCurrent();
      assertCurrent();
      assertAdmissionCurrent();
      return nativeAuthentication.run(
        {
          cwd: input.cwd,
          adapter,
          threadId,
          assertProfile(profileRef, cwd) {
            assertAdmissionCurrent();
            assertCurrent();
            if (profileRef !== input.profileRef || cwd !== input.cwd)
              throw new Error('ensemble_auth_native_context_changed');
            assertAdmissionCurrent();
          },
          assertLaunch(launch) {
            assertAdmissionCurrent();
            assertCurrent();
            if (
              launch.command !== input.command ||
              (input.script !== undefined && launch.args[0] !== input.script) ||
              launch.cwd !== input.cwd ||
              !isDeepStrictEqual(environment(launch.env), expected)
            )
              throw new Error('ensemble_auth_native_context_changed');
            try {
              assertArguments(input.engine, launch.args, input.script);
            } catch {
              throw new Error('ensemble_auth_arguments_changed');
            }
            assertAdmissionCurrent();
          },
        },
        work,
      );
    },
  };
}
