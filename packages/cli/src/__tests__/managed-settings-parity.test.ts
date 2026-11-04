/**
 * #4517 round 2: the CLI's offline overlay (`effectiveAppConfigOffline`) and
 * the server's overlay (`overlayManagedAppSettings`) must reach the same
 * effective value for every stored state of a managed-default key. Both are
 * driven with one policy built by the real decoder; the server is given an
 * empty environment, because the offline readers never read one.
 */
import {
  APP_CONFIG_SEED,
  hasAppConfigStationDecision,
} from '@kontourai/station-contracts/config';
import { summarizeManagedPolicy } from '@kontourai/station-contracts/managed-policy';
import {
  decodeManagedPolicy,
  type LoadedManagedPolicy,
  managedPolicyDigest,
} from '@kontourai/station-shared/managed-policy';
import { describe, expect, test } from 'vitest';
import {
  managedAppSettingsOf,
  overlayManagedAppSettings,
} from '../../../../src-server/domain/managed-settings.js';
import { effectiveAppConfigOffline } from '../commands/managed-settings-guard.js';

function policy(
  settings: Record<string, { value: unknown; locked: boolean }>,
): LoadedManagedPolicy {
  const document = decodeManagedPolicy('/test/policy.json', {
    kind: 'value',
    value: { schemaVersion: 1, organization: 'Acme', settings },
  });
  return {
    source: { kind: 'test-override', location: '/test/policy.json' },
    document,
    digest: managedPolicyDigest(document),
    summary: summarizeManagedPolicy(document),
  };
}

const MANAGED = {
  builtinAgentEngineConnectionId: 'codex',
  systemPrompt: 'You are the Acme assistant.',
  templateVariables: [{ key: 'ORG', type: 'static', value: 'Acme' }],
  region: 'eu-west-1',
} as const;

type Key = keyof typeof MANAGED;

/** Each stored state, and whether it is a Station decision (intended). */
const STORED_STATES: ReadonlyArray<{
  name: string;
  key: Key;
  stored: Record<string, unknown>;
  decision: boolean;
}> = [
  ...(Object.keys(MANAGED) as Key[]).flatMap((key) => [
    { name: `${key} absent`, key, stored: {}, decision: false },
    { name: `${key} null`, key, stored: { [key]: null }, decision: true },
    { name: `${key} blank`, key, stored: { [key]: '  ' }, decision: false },
  ]),
  {
    name: 'systemPrompt seeded factory value',
    key: 'systemPrompt',
    stored: { systemPrompt: APP_CONFIG_SEED.systemPrompt },
    decision: false,
  },
  {
    name: 'templateVariables seeded factory value',
    key: 'templateVariables',
    stored: { templateVariables: APP_CONFIG_SEED.templateVariables },
    decision: false,
  },
  {
    // A hand edit or another serializer may reorder an entry's keys; the
    // seed is still the seed, so a managed default still fills it.
    name: 'templateVariables seed with reordered keys',
    key: 'templateVariables',
    stored: {
      templateVariables: [{ value: 'Station', type: 'static', key: 'AGENT_NAME' }],
    },
    decision: false,
  },
  {
    // Array order is meaningful: the same entries in another order are a
    // list the operator shaped.
    name: 'templateVariables reordered entries',
    key: 'templateVariables',
    stored: {
      templateVariables: [
        { key: 'TEAM', type: 'static', value: 'Ops' },
        ...APP_CONFIG_SEED.templateVariables,
      ],
    },
    decision: true,
  },
  {
    name: 'systemPrompt real user value',
    key: 'systemPrompt',
    stored: { systemPrompt: 'My own prompt.' },
    decision: true,
  },
  {
    name: 'builtinAgentEngineConnectionId real user value',
    key: 'builtinAgentEngineConnectionId',
    stored: { builtinAgentEngineConnectionId: 'claude' },
    decision: true,
  },
  {
    name: 'templateVariables seed plus the user entry',
    key: 'templateVariables',
    stored: {
      templateVariables: [
        ...APP_CONFIG_SEED.templateVariables,
        { key: 'TEAM', type: 'static', value: 'Ops' },
      ],
    },
    decision: true,
  },
  {
    name: 'region real user value',
    key: 'region',
    stored: { region: 'us-east-1' },
    decision: true,
  },
];

describe('offline and server managed overlays agree', () => {
  const loaded = policy(
    Object.fromEntries(
      Object.entries(MANAGED).map(([key, value]) => [
        key,
        { value, locked: false },
      ]),
    ),
  );
  const server = managedAppSettingsOf(loaded);

  test.each(STORED_STATES)('$name', ({ key, stored, decision }) => {
    expect(hasAppConfigStationDecision(stored, key)).toBe(decision);
    const serverValue = overlayManagedAppSettings(stored, server, {})[key];
    const offlineValue = effectiveAppConfigOffline(stored, () => loaded)[key];
    expect(offlineValue).toEqual(serverValue);
    // The intended outcome, not just agreement: a decision keeps the stored
    // value, anything else takes the managed default.
    expect(offlineValue).toEqual(decision ? stored[key] : MANAGED[key]);
  });
});
