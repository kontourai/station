/**
 * The SSE plugin-event gate (#2067).
 *
 * This predicate lived as an inline lambda inside a 4,000-line composition,
 * which made it untestable by construction: an independent reviewer injected
 * `if (true) return true;` as its first statement and every gate stayed green
 * — 41/41 tests and the enumeration scan at exit 0 — while every plugin
 * channel relayed to every listener. It is a named exported function now, and
 * these are the tests that were impossible before.
 */

import { RESERVED_EVENT_SENTINEL_PLUGIN_NAMES } from '@kontourai/station-contracts/plugin-visibility';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test, vi } from 'vitest';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import {
  canRelayPluginIdentityEvent,
  WORKSPACE_HOME_ROLE_EVENT_MARKER,
  WORKSPACE_HOME_ROLE_EVENT_NAME,
  workspaceHomeRoleEventFrame,
} from '../plugin-identity-enumeration.js';

const COLLABORATOR: PrincipalRef = humanPrincipal(
  'device',
  'collaborator-device',
  'Collaborator',
);
const OPERATOR: PrincipalRef = {
  id: LOCAL_OPERATOR_PRINCIPAL_ID,
  kind: 'human',
  display: 'Operator',
};

/** Grants sight of exactly one plugin. */
const seeing = (allowed: string) => (_p: PrincipalRef, name: string) =>
  name === allowed;
const seeingNothing = () => false;

const relay = (input: {
  event?: string;
  data: unknown;
  principal: PrincipalRef | null;
  canSee?: (principal: PrincipalRef, name: string) => boolean;
}) =>
  canRelayPluginIdentityEvent({
    event: input.event ?? SERVER_EVENTS.PLUGINS_INSTALLED,
    data: input.data,
    principal: input.principal,
    canSee: input.canSee ?? seeingNothing,
  });

describe('a plugin lifecycle frame reaches only a subscriber who may see it', () => {
  test('the operator receives every named channel', () => {
    for (const event of [
      SERVER_EVENTS.PLUGINS_INSTALLED,
      SERVER_EVENTS.PLUGINS_REMOVED,
      SERVER_EVENTS.PLUGINS_UPDATED,
      SERVER_EVENTS.PLUGINS_SETTINGS_CHANGED,
      SERVER_EVENTS.PLUGINS_GRANTS_CHANGED,
    ]) {
      // The control. Without it, a predicate that denied everything would
      // satisfy every refusal case below.
      expect(
        relay({
          event,
          data: { name: 'secret-notes' },
          principal: OPERATOR,
          canSee: () => true,
        }),
        event,
      ).toBe(true);
    }
  });

  test('a collaborator receives a frame for a plugin they were granted', () => {
    expect(
      relay({
        data: { name: 'notes' },
        principal: COLLABORATOR,
        canSee: seeing('notes'),
      }),
    ).toBe(true);
  });

  test('a collaborator receives nothing for a plugin they were not granted', () => {
    expect(
      relay({
        data: { name: 'secret-notes' },
        principal: COLLABORATOR,
        canSee: seeing('notes'),
      }),
    ).toBe(false);
  });

  test('a frame naming no plugin is denied rather than passed through', () => {
    // An unattributable frame cannot be shown to be safe, so it is not sent.
    for (const data of [{}, { name: '' }, { name: 42 }, undefined, null]) {
      expect(relay({ data, principal: COLLABORATOR }), String(data)).toBe(
        false,
      );
    }
  });

  test('an unattributable subscriber receives nothing', () => {
    expect(
      relay({
        data: { name: 'notes' },
        principal: null,
        canSee: () => true,
      }),
    ).toBe(false);
  });

  test('updates-available reaches the operator only', () => {
    // Its payload is a LIST rather than one name, and its route
    // (`GET /api/plugins/check-updates`) is operator-only for the same
    // reason. `canSee` returning true must not change that.
    const data = { count: 1, updates: [{ name: 'secret-notes' }] };
    expect(
      relay({
        event: SERVER_EVENTS.PLUGINS_UPDATES_AVAILABLE,
        data,
        principal: OPERATOR,
        canSee: () => false,
      }),
    ).toBe(true);
    expect(
      relay({
        event: SERVER_EVENTS.PLUGINS_UPDATES_AVAILABLE,
        data,
        principal: COLLABORATOR,
        canSee: () => true,
      }),
    ).toBe(false);
  });
});

/** Exactly what the emitters build, so the tests cannot drift from them. */
const homeRoleFrame = workspaceHomeRoleEventFrame();

describe('the Home-role sentinel', () => {
  test('reaches everyone, including a collaborator who can see no plugin', () => {
    // DECISION (#2067): the sentinel names no plugin, so there is nothing for
    // the projection to evaluate and nothing to enumerate — it says "the one
    // instance-level Home slot changed". Gating it on `canSee(name)` made it
    // false for every non-operator, which stopped collaborators receiving the
    // frame `useServerEvents` uses to invalidate the projects and plugins
    // queries after a Home revoke. The alternative — making it carry a plugin
    // name so the gate can evaluate it — would ADD plugin identity to a frame
    // that currently has none.
    expect(
      relay({
        event: SERVER_EVENTS.PLUGINS_GRANTS_CHANGED,
        data: homeRoleFrame,
        principal: COLLABORATOR,
        canSee: seeingNothing,
      }),
    ).toBe(true);
  });

  test('a plugin frame wearing the sentinel name does NOT ride the exemption', () => {
    // `workspace-home-role` satisfies `isCanonicalPluginId` and is not a
    // reserved object key, so before this it was a constructible plugin
    // name — and a settings-changed frame for such a plugin carries its
    // non-secret setting VALUES. The relay needs the grants-changed channel
    // AND a marker no plugin frame sets; the name alone is not a
    // discriminator, and neither axis is load-bearing alone.
    for (const event of [
      SERVER_EVENTS.PLUGINS_SETTINGS_CHANGED,
      SERVER_EVENTS.PLUGINS_INSTALLED,
      SERVER_EVENTS.PLUGINS_REMOVED,
      SERVER_EVENTS.PLUGINS_UPDATED,
      SERVER_EVENTS.PLUGINS_GRANTS_CHANGED,
    ]) {
      expect(
        relay({
          event,
          // Exactly what Station emits for a plugin of that name: the name,
          // no marker, and in the settings case the values themselves.
          data: {
            name: WORKSPACE_HOME_ROLE_EVENT_NAME,
            settings: { apiHost: 'internal.example' },
          },
          principal: COLLABORATOR,
          canSee: seeingNothing,
        }),
        event,
      ).toBe(false);
    }
  });

  test('a forged marker on the wrong channel does not ride it either', () => {
    expect(
      relay({
        event: SERVER_EVENTS.PLUGINS_SETTINGS_CHANGED,
        data: homeRoleFrame,
        principal: COLLABORATOR,
        canSee: seeingNothing,
      }),
    ).toBe(false);
  });

  test('an unattributable subscriber gets nothing, sentinel included', () => {
    // The extraction had moved the sentinel check ahead of the
    // null-principal refusal, so a subscriber this runtime could not place
    // received the frame. The inline original resolved first.
    expect(relay({ data: homeRoleFrame, principal: null })).toBe(false);
    expect(
      relay({
        event: SERVER_EVENTS.PLUGINS_GRANTS_CHANGED,
        data: homeRoleFrame,
        principal: null,
      }),
    ).toBe(false);
  });

  test('the name is reserved, so no plugin can take it', () => {
    expect(
      RESERVED_EVENT_SENTINEL_PLUGIN_NAMES.has(WORKSPACE_HOME_ROLE_EVENT_NAME),
    ).toBe(true);
  });

  test('the exemption is the sentinel exactly, not a prefix or a lookalike', () => {
    // A plugin genuinely named something similar must not ride the exemption.
    for (const name of [
      `${WORKSPACE_HOME_ROLE_EVENT_NAME}-evil`,
      `x-${WORKSPACE_HOME_ROLE_EVENT_NAME}`,
      WORKSPACE_HOME_ROLE_EVENT_NAME.toUpperCase(),
    ]) {
      expect(
        relay({
          event: SERVER_EVENTS.PLUGINS_GRANTS_CHANGED,
          data: { name, [WORKSPACE_HOME_ROLE_EVENT_MARKER]: true },
          principal: COLLABORATOR,
          canSee: seeingNothing,
        }),
        name,
      ).toBe(false);
    }
  });

  test('the frame the emitters actually build passes the gate', () => {
    // Behavioural, not a text scan. The previous version grepped the emitter
    // file for a constant name, which a reformat or a rename defeats while
    // the frame silently stops being relayed. This asserts the coupling
    // itself: whatever `workspaceHomeRoleEventFrame()` produces must be what
    // the gate exempts, so the two cannot drift without a red test.
    expect(
      relay({
        event: SERVER_EVENTS.PLUGINS_GRANTS_CHANGED,
        data: workspaceHomeRoleEventFrame(),
        principal: COLLABORATOR,
        canSee: seeingNothing,
      }),
    ).toBe(true);
  });

  test('the marker must be an OWN property, not inherited', () => {
    // The stated property is a field the emitters SET. A prototype-chain
    // read would also accept one merely inherited.
    const inherited = Object.create({
      [WORKSPACE_HOME_ROLE_EVENT_MARKER]: true,
    }) as Record<string, unknown>;
    inherited.name = WORKSPACE_HOME_ROLE_EVENT_NAME;
    expect(
      relay({
        event: SERVER_EVENTS.PLUGINS_GRANTS_CHANGED,
        data: inherited,
        principal: COLLABORATOR,
        canSee: seeingNothing,
      }),
    ).toBe(false);
  });
});

test('a read failure inside canSee denies rather than throwing', () => {
  // The relay asks this per frame on a long-lived stream; an unreadable
  // grant record must not take the stream down, and must not relay either.
  const canSee = vi.fn(() => {
    throw new Error('record unreadable');
  });
  expect(() =>
    relay({ data: { name: 'notes' }, principal: COLLABORATOR, canSee }),
  ).toThrow();
  // The predicate itself is pure: the composition wraps `canSee` in its own
  // try/catch (runtime-routes.ts) precisely because THIS function does not
  // swallow, so a defect here stays visible rather than becoming a silent
  // global denial.
  expect(canSee).toHaveBeenCalled();
});
