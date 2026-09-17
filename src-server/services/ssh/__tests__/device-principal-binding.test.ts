import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DevicePairingService } from '../device-pairing-service.js';

const homes: string[] = [];
const environmentId = '11111111-1111-4111-8111-111111111111';
const approver = { principalId: 'human:local:operator' };
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
function setup() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-person-binding-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const options = { homeDir, environmentId };
  return {
    service: new DevicePairingService(options),
    options,
    file: join(homeDir, 'security', 'paired-devices.json'),
  };
}
function request(service: DevicePairingService, verified = true) {
  const offer = service.createOffer({
    endpoint: 'https://station.example.test',
  });
  const pending = service.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Collaborator device',
    requesterPosition: 'off-box',
    ...(verified
      ? {
          source: 'tailnet' as const,
          requester: {
            provider: 'tailscale-serve' as const,
            login: 'collaborator@example.test',
          },
        }
      : { source: 'pairing-code' as const }),
  });
  return {
    pending,
    exchange: {
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    },
  };
}

test('explicit approval persists two independently revocable devices for one verified person', () => {
  const { service, options } = setup();
  const first = request(service);
  const second = request(service);
  for (const item of [first, second])
    service.confirmRequest(
      item.pending.requestId,
      { kind: 'presented-credential' },
      approver,
    );
  const a = service.exchange(first.exchange);
  const b = service.exchange(second.exchange);
  expect(a.device.id).not.toBe(b.device.id);
  expect(a.device.principalBinding).toMatchObject({
    provider: 'tailscale-serve',
    subject: 'collaborator@example.test',
    approvedBy: approver.principalId,
  });
  expect(a.device.principalBinding?.approvalId).not.toBe(
    b.device.principalBinding?.approvalId,
  );
  const reopened = new DevicePairingService(options);
  expect(reopened.identifyDevice(a.credential)?.principalBinding).toEqual(
    a.device.principalBinding,
  );
  reopened.revokeDevice(a.device.id, 'operator-credential');
  expect(reopened.identifyDevice(a.credential)).toBeNull();
  expect(reopened.identifyDevice(b.credential)?.principalBinding?.subject).toBe(
    'collaborator@example.test',
  );
  expect(
    new DevicePairingService(options).identifyDevice(a.credential),
  ).toBeNull();
});

test('verified provenance alone does not bind a device and old grants are not silently migrated', () => {
  const { service, options } = setup();
  const item = request(service);
  service.confirmRequest(item.pending.requestId, {
    kind: 'presented-credential',
  });
  const result = service.exchange(item.exchange);
  expect(result.device.requester?.login).toBe('collaborator@example.test');
  expect(result.device.principalBinding).toBeUndefined();
  expect(
    new DevicePairingService(options).identifyDevice(result.credential)
      ?.principalBinding,
  ).toBeUndefined();
});

test('unverified requests and non-credential approval cannot acquire person identity', () => {
  const { service } = setup();
  const unknown = request(service, false);
  const verified = request(service);
  expect(() =>
    service.confirmRequest(
      unknown.pending.requestId,
      { kind: 'presented-credential' },
      approver,
    ),
  ).toThrow('invalid_request');
  expect(() =>
    service.confirmRequest(
      verified.pending.requestId,
      { kind: 'ui-bootstrap' },
      approver,
    ),
  ).toThrow('invalid_request');
  expect(() => service.exchange(unknown.exchange)).toThrow(
    'request_not_confirmed',
  );
  expect(() => service.exchange(verified.exchange)).toThrow(
    'request_not_confirmed',
  );
});

test('public binding projections cannot mutate authoritative identity', () => {
  const { service } = setup();
  const item = request(service);
  service.confirmRequest(
    item.pending.requestId,
    { kind: 'presented-credential' },
    approver,
  );
  const result = service.exchange(item.exchange);
  Object.assign(result.device.principalBinding!, {
    subject: 'attacker@example.test',
  });
  const listed = service.listDevices()[0]!;
  Object.assign(listed.principalBinding!, { subject: 'another@example.test' });
  Object.assign(listed.requester!, { login: 'changed@example.test' });
  expect(service.identifyDevice(result.credential)?.requester?.login).toBe(
    'collaborator@example.test',
  );
  expect(
    service.identifyDevice(result.credential)?.principalBinding?.subject,
  ).toBe('collaborator@example.test');
});

test('a persistence failure exposes neither a credential nor a partially stored binding and permits exact retry', () => {
  const { service, file, options } = setup();
  const first = request(service);
  service.confirmRequest(first.pending.requestId, {
    kind: 'presented-credential',
  });
  const active = service.exchange(first.exchange);
  const next = request(service);
  service.confirmRequest(
    next.pending.requestId,
    { kind: 'presented-credential' },
    approver,
  );
  renameSync(file, `${file}.retained`);
  mkdirSync(file);
  expect(() => service.exchange(next.exchange)).toThrow();
  expect(service.listDevices()).toHaveLength(1);
  expect(service.identifyDevice(active.credential)).not.toBeNull();
  rmSync(file, { recursive: true });
  renameSync(`${file}.retained`, file);
  const result = service.exchange(next.exchange);
  expect(
    new DevicePairingService(options).identifyDevice(result.credential)
      ?.principalBinding,
  ).toEqual(result.device.principalBinding);
  expect(() => service.exchange(next.exchange)).toThrow();
});

test('a binding that no longer matches its verified requester fails closed on reopen', () => {
  const { service, file, options } = setup();
  const item = request(service);
  service.confirmRequest(
    item.pending.requestId,
    { kind: 'presented-credential' },
    approver,
  );
  service.exchange(item.exchange);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.devices[0].principalBinding.subject = 'attacker@example.test';
  writeFileSync(file, JSON.stringify(data));
  expect(() => new DevicePairingService(options)).toThrow();
});
