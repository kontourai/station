import { afterEach, describe, expect, test } from 'vitest';
import { ACPProbe } from '../../services/acp/acp-probe.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import {
  createFakeEngineHarnessFactory,
  DEFAULT_PERMISSION_OPTIONS,
  type FakeEngineHarness,
  fakeEngineConnection,
  loadEngineProfiles,
  quietLogger,
  waitFor,
} from './acp-engine-qualification-harness.js';

/**
 * Every profile in `fixtures/acp-engine-profiles` runs through the real
 * `ACPProcess` spawn, `AcpAdapter` and `ACPProbe`. A profile's shapes are
 * only as good as their provenance (that directory's README); what this
 * proves is that Station turns those shapes into the canonical events and
 * capability facts it claims for every command-backed engine.
 */
const PROFILES = loadEngineProfiles();
const { harness, makeTempDir } = createFakeEngineHarnessFactory();

function probeFor(connection: ReturnType<typeof fakeEngineConnection>) {
  return new ACPProbe(
    connection,
    quietLogger,
    makeTempDir('station-acp-qualify-home-'),
  );
}

/** Sends one turn, answers its permission request, and waits for the end. */
async function turn(
  h: FakeEngineHarness,
  threadId: string,
  answer: 'accept' | 'decline',
) {
  const from = h.events.length;
  const { turnId } = await h.adapter.sendTurn({
    provider: 'acp',
    threadId,
    input: 'Run the probe command.',
    confinement: 'workspace',
  } as never);
  const since = () => h.events.slice(from);
  const asked = await waitFor(
    () =>
      since().find((event) => event.method === 'request.opened') as
        | (CanonicalRuntimeEvent & { requestId: string })
        | undefined,
    'request.opened',
  );
  await h.adapter.respondToRequest(threadId, asked.requestId, answer);
  const completed = await waitFor(
    () =>
      since().find(
        (event) =>
          event.method === 'turn.completed' &&
          (event as { turnId?: string }).turnId === turnId,
      ),
    'turn.completed',
  );
  return { asked, completed, events: since() };
}

const text = (events: CanonicalRuntimeEvent[]) =>
  events
    .filter((event) => event.method === 'content.text-delta')
    .map((event) => (event as { delta?: string }).delta ?? '')
    .join('');

const profilePath = (engine: string) => {
  const found = PROFILES.find(({ profile }) => profile.engine === engine);
  if (!found) throw new Error(`No ${engine} profile`);
  return found.path;
};

describe.skipIf(process.platform === 'win32')(
  'engine qualification (real process, profile-driven engine)',
  () => {
    let h: FakeEngineHarness | undefined;
    afterEach(async () => {
      await h?.stop();
      h = undefined;
    });

    test('every profile in the directory is exercised', () => {
      // Pinned independently so a profile that stops loading, or an emptied
      // directory, cannot quietly shrink the qualification set.
      expect(PROFILES.map(({ profile }) => profile.engine)).toEqual([
        'antigravity',
        'auggie',
        'cline',
        'cursor',
        'devin',
        'factory-droid',
        'goose',
        'grok-build',
        'hermes',
        'kimi',
        'kiro',
        'opencode',
        'pi-acp',
      ]);
    });

    describe.each(PROFILES)('$profile.engine', ({ path, profile }) => {
      test('the probe records the handshake and session capabilities the engine declares', async () => {
        const probe = probeFor(fakeEngineConnection(path));
        try {
          expect(await probe.probe()).toBe(true);
          expect(probe.lastError).toBeNull();
          expect(probe.cachedAgentCapabilities).toEqual(
            profile.initialize.agentCapabilities,
          );
          expect(probe.cachedModes.map((mode) => mode.id)).toEqual(
            (profile.sessionNew?.modes?.availableModes ?? []).map(
              (mode) => mode.id,
            ),
          );
          expect(
            probe.cachedConfigOptions.map(
              (option: { id: string }) => option.id,
            ),
          ).toEqual(
            (profile.sessionNew?.configOptions ?? []).map(
              (option) => option.id,
            ),
          );
        } finally {
          await probe.dispose();
        }
      });

      test('a turn streams text, a plan, a permission round trip and vendor notifications', async () => {
        h = harness(path);
        await h.startSession('turn');
        expect(
          h.events.some((event) => event.method === 'session.started'),
        ).toBe(true);

        const accepted = await turn(h, 'turn', 'accept');
        expect(accepted.asked).toMatchObject({
          method: 'request.opened',
          title: 'echo STATION_PROBE',
        });
        expect(text(accepted.events)).toContain('STATION_SMOKE_OK');
        expect(
          accepted.events.find((event) => event.method === 'plan.updated'),
        ).toMatchObject({
          entries: [
            { content: 'Run the probe command', status: 'in_progress' },
            { content: 'Report the result', status: 'pending' },
          ],
        });
        const notifications = accepted.events
          .filter((event) => event.method === 'extension.notification')
          .map((event) => {
            const { namespace, type, payload } = event as {
              namespace: string;
              type: string;
              payload: unknown;
            };
            return { method: `${namespace}/${type}`, params: payload };
          });
        expect(notifications).toEqual(
          (profile.vendorNotifications ?? []).map(({ method, params }) => ({
            method,
            params: params ?? {},
          })),
        );

        const declined = await turn(h, 'turn', 'decline');
        expect(declined.completed).toBeDefined();
        // A one-time accept and decline reach the engine as exactly its own
        // once options; an "always" option would outlive this request.
        const options = profile.permissionOptions ?? DEFAULT_PERMISSION_OPTIONS;
        const once = (kind: 'allow_once' | 'reject_once') => {
          const option = options.find((candidate) => candidate.kind === kind);
          if (!option) throw new Error(`${profile.engine} offers no ${kind}`);
          return option.optionId;
        };
        expect(
          h
            .engineRecord()
            .filter((entry) => 'permission' in entry)
            .map((entry) => entry.permission),
        ).toEqual([
          { outcome: 'selected', optionId: once('allow_once') },
          { outcome: 'selected', optionId: once('reject_once') },
        ]);
      });
    });

    describe('onboarding failures surface as failures with a reason', () => {
      const goose = () => profilePath('goose');

      test('an engine that exits on start fails the probe at initialize', async () => {
        const probe = probeFor(
          fakeEngineConnection(goose(), { fail: 'exit-on-start' }),
        );
        try {
          expect(await probe.probe()).toBe(false);
          expect(probe.lastSuccess).toBe(false);
          expect(probe.lastError).toMatchObject({ phase: 'initialize' });
          expect(probe.lastError?.message).toBeTruthy();
        } finally {
          await probe.dispose();
        }
      });

      test('auth_required on session/new fails the probe with the engine’s reason', async () => {
        const probe = probeFor(
          fakeEngineConnection(goose(), {
            fail: 'auth-required-on-session-new',
          }),
        );
        try {
          expect(await probe.probe()).toBe(false);
          expect(probe.lastError).toEqual({
            phase: 'session creation',
            message: 'Authentication required: Sign in to goose first',
          });
          expect(probe.cachedAgentCapabilities).toBeNull();
        } finally {
          await probe.dispose();
        }
      });

      test('auth_required on session/new refuses the chat session start', async () => {
        h = harness(goose(), 'auth-required-on-session-new');
        await expect(h.startSession('auth')).rejects.toThrow(
          'Authentication required: Sign in to goose first',
        );
      });

      test('auth_required on the first prompt ends the turn in a runtime error, never a completion', async () => {
        h = harness(goose(), 'auth-required-on-prompt');
        await h.startSession('auth-prompt');
        const { turnId } = await h.adapter.sendTurn({
          provider: 'acp',
          threadId: 'auth-prompt',
          input: 'hello',
          confinement: 'workspace',
        } as never);
        const failure = await waitFor(
          () =>
            h?.events.find(
              (event) =>
                event.method === 'runtime.error' &&
                (event as { turnId?: string }).turnId === turnId,
            ),
          'runtime.error',
        );
        // A completion would arrive with or right after the error; give it
        // the chance to, so its absence is observed rather than assumed.
        await h.adapter.stopSession('auth-prompt');
        expect(failure).toMatchObject({
          severity: 'error',
          message: 'Authentication required: Sign in to goose first',
        });
        expect(
          h.events.some(
            (event) =>
              event.method === 'turn.completed' &&
              (event as { turnId?: string }).turnId === turnId,
          ),
        ).toBe(false);
      });

      test('a slow initialize fails a request probe but fits the cold background budget', async () => {
        const slow = () =>
          new ACPProbe(
            fakeEngineConnection(goose(), { initializeDelayMs: 1_500 }),
            quietLogger,
            makeTempDir('station-acp-qualify-home-'),
            undefined,
            500,
          );
        const requested = slow();
        const background = slow();
        try {
          expect(await requested.probe('request')).toBe(false);
          expect(requested.lastError?.phase).toBe('initialize');
          expect(requested.lastError?.message).toContain('500ms');
          expect(await background.probe('background')).toBe(true);
          expect(background.lastError).toBeNull();
        } finally {
          await requested.dispose();
          await background.dispose();
        }
      });
    });
  },
);
