import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import { describe, expect, test } from 'vitest';
import { peerChatRuntime } from '../../../__test-utils__/peer-chat-runtime.js';
import { pairedStationImportCaller } from '../peer-conversation-handoff.js';

/**
 * The real import-caller decision behind the production admission: a route at
 * the import's own path, so the scope table, credential verification and
 * principal resolution all run, answering who `pairedStationImportCaller`
 * says is calling.
 */
async function runtime(
  identify?: (credential: string) => { id: string; name: string } | null,
) {
  const station = await peerChatRuntime();
  const decide = pairedStationImportCaller(
    identify ?? ((credential) => station.security.identifyDevice(credential)),
  );
  let beforeDecide: () => void = () => {};
  station.app.post('/agents/:slug/conversation-imports', (c) => {
    beforeDecide();
    return c.json({ caller: decide(c.req.raw) ?? null });
  });
  const ask = async (credential: string) => {
    const response = await station.call(
      '/agents/codex/conversation-imports',
      credential,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  return {
    station,
    ask,
    setBeforeDecide: (hook: () => void) => {
      beforeDecide = hook;
    },
  };
}

describe('who may import a conversation', () => {
  test("a paired Station's delegation Device, named as it named itself", async () => {
    const { station, ask } = await runtime();
    const paired = station.pair(
      pairingScopePresetString('delegation'),
      'delegation',
    );
    const answer = await ask(paired.credential);
    expect(answer.status).toBe(200);
    expect(answer.body.caller).toEqual({
      deviceId: paired.device.id,
      stationName: 'Source Station',
    });
  });

  test("not a person's Device, even with the operate scope", async () => {
    const { station, ask } = await runtime();
    const phone = station.pair(pairingScopePresetString('standard'), 'device');
    const answer = await ask(phone.credential);
    expect(answer.status).toBe(200);
    expect(answer.body.caller).toBeNull();
  });

  test('not a Device the re-read no longer names, or names as another Device', async () => {
    const revoked = await runtime();
    const paired = revoked.station.pair(
      pairingScopePresetString('delegation'),
      'delegation',
    );
    revoked.setBeforeDecide(() =>
      revoked.station.security.devicePairing.revokeDevice(
        paired.device.id,
        'operator-credential',
      ),
    );
    expect((await revoked.ask(paired.credential)).body.caller).toBeNull();

    const swapped = await runtime(() => ({
      id: 'another-device',
      name: 'Impostor',
    }));
    const other = swapped.station.pair(
      pairingScopePresetString('delegation'),
      'delegation',
    );
    expect((await swapped.ask(other.credential)).body.caller).toBeNull();
  });
});
