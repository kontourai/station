import { pairingScopePresetString } from '@kontourai/station-contracts/environment-security';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { configureRuntimeHttp } from '../../runtime/bootstrap/runtime-http.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import { createLogger } from '../../utils/logger.js';
import {
  createRuntimeNativeForkReadAdmissionDomain,
  type NativeForkReadAdmissionHandle,
} from '../native-fork-read-admission.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../runtime-request-security.js';

const makeTempDir = trackTempDirs();
const path = '/agents/continuity/conversations/source/fork';
const approval = { kind: 'presented-credential' as const };

async function securityFixture() {
  const security = new EnvironmentSecurityService({
    homeDir: makeTempDir('station-native-read-domain-'),
  });
  const operator = await security.initialize();
  const pairing = security.devicePairing;
  const offer = pairing.createOffer({
    endpoint: 'https://station.example.test',
    scope: pairingScopePresetString('standard'),
  });
  const pending = pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Native read fixture',
  });
  pairing.confirmRequest(pending.requestId, approval);
  const device = pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: pending.requestId,
  });
  return { security, operator, device };
}

function stampedRequest(credential: string, signal?: AbortSignal) {
  const request = new Request(`https://station.example.test${path}`, {
    method: 'POST',
    signal,
  });
  setRuntimeAuthenticatedRequestPrincipal(request, {
    kind: 'credential',
    credential,
    authority: 'device-credential',
    source: 'bearer',
  });
  return request;
}

describe('per-runtime native fork stored-read admission', () => {
  test('a service-domain verifier rejects a second factory and forged callbacks', async () => {
    const { security, device } = await securityFixture();
    const request = stampedRequest(device.credential);
    const authority = sessionReadAuthorityFromRequest(
      'fixture-owner',
      undefined,
      undefined,
    );
    const domainA = createRuntimeNativeForkReadAdmissionDomain(security);
    const fakeAuthorize = vi.fn(() => true);
    const fakeScope = vi.fn(() => pairingScopePresetString('standard'));
    const domainB = createRuntimeNativeForkReadAdmissionDomain({
      authorizeCredential: fakeAuthorize,
      resolveGrantedScope: fakeScope,
    });
    const mountA = domainA.bindAtConversationMount(() => authority);
    const mountB = domainB.bindAtConversationMount(() => authority);
    expect(mountA.kind).toBe('bound');
    expect(mountB.kind).toBe('bound');
    if (mountA.kind !== 'bound' || mountB.kind !== 'bound')
      throw new Error('mount refused');
    const a = mountA.capture(request);
    const b = mountB.capture(request);
    expect(a.kind).toBe('captured');
    expect(b.kind).toBe('captured');
    if (a.kind !== 'captured' || b.kind !== 'captured')
      throw new Error('capture refused');
    expect(domainA.verifyForService(a.handle)).toEqual({
      kind: 'current',
      authority,
    });
    fakeAuthorize.mockClear();
    fakeScope.mockClear();
    expect(domainA.verifyForService(b.handle).kind).toBe('unavailable');
    expect(fakeAuthorize).not.toHaveBeenCalled();
    expect(fakeScope).not.toHaveBeenCalled();
    const checkCurrent = vi.fn(() => true);
    expect(domainA.verifyForService({ checkCurrent }).kind).toBe('unavailable');
    expect(checkCurrent).not.toHaveBeenCalled();
    expect(domainA.verifyForService({ ...a.handle }).kind).toBe('unavailable');
    mountA.release(a.handle);
    mountA.release(a.handle);
    expect(domainA.verifyForService(a.handle).kind).toBe('unavailable');
  });

  test('pins the mount and original scope/principal objects without renewal', async () => {
    const { security, device } = await securityFixture();
    const request = stampedRequest(device.credential);
    let authority = sessionReadAuthorityFromRequest(
      'fixture-owner',
      undefined,
      undefined,
    );
    const resolver = () => authority;
    const domain = createRuntimeNativeForkReadAdmissionDomain(security);
    expect(domain.verifyForService({}).kind).toBe('unavailable');
    const mount = domain.bindAtConversationMount(resolver);
    if (mount.kind !== 'bound') throw new Error('mount refused');
    expect(domain.bindAtConversationMount(resolver)).toBe(mount);
    expect(domain.bindAtConversationMount(() => authority)).toEqual({
      kind: 'unavailable',
      reason: 'mount-binding-mismatch',
    });
    const captured = mount.capture(request);
    if (captured.kind !== 'captured') throw new Error('capture refused');
    const original = authority;
    authority = sessionReadAuthorityFromRequest(
      'fixture-owner',
      undefined,
      undefined,
    );
    expect(domain.verifyForService(captured.handle).kind).toBe('unavailable');
    authority = original;
    expect(domain.verifyForService(captured.handle).kind).toBe('unavailable');
    const second = mount.capture(request);
    if (second.kind !== 'captured') throw new Error('capture refused');
    const principal = getRuntimeAuthenticatedRequestPrincipal(request);
    if (!principal) throw new Error('principal missing');
    setRuntimeAuthenticatedRequestPrincipal(request, principal);
    expect(domain.verifyForService(second.handle).kind).toBe('unavailable');
  });

  test('aborted requests and resolver failure cannot leave a reusable handle', async () => {
    const { security, device } = await securityFixture();
    const abort = new AbortController();
    const request = stampedRequest(device.credential, abort.signal);
    const authority = sessionReadAuthorityFromRequest(
      'fixture-owner',
      undefined,
      undefined,
    );
    let throwFromResolver = false;
    const domain = createRuntimeNativeForkReadAdmissionDomain(security);
    const mount = domain.bindAtConversationMount(() => {
      if (throwFromResolver) throw new Error('scope owner unavailable');
      return authority;
    });
    if (mount.kind !== 'bound') throw new Error('mount refused');
    const captured = mount.capture(request);
    if (captured.kind !== 'captured') throw new Error('capture refused');
    expect(domain.verifyForService(captured.handle).kind).toBe('current');
    throwFromResolver = true;
    expect(domain.verifyForService(captured.handle).kind).toBe('unavailable');
    throwFromResolver = false;
    expect(domain.verifyForService(captured.handle).kind).toBe('unavailable');
    const next = mount.capture(request);
    if (next.kind !== 'captured') throw new Error('capture refused');
    abort.abort();
    expect(domain.verifyForService(next.handle).kind).toBe('unavailable');
    expect(mount.capture(request).kind).toBe('unavailable');
  });

  test.each([
    'unchanged',
    'device-revoked',
    'scope-narrowed',
    'operator-rotated',
  ] as const)(
    'rechecks actual middleware-admitted final Request after an await: %s',
    async (change) => {
      const { security, operator, device } = await securityFixture();
      const credential =
        change === 'operator-rotated' ? operator.credential : device.credential;
      const domain = createRuntimeNativeForkReadAdmissionDomain(security);
      const authorities = new WeakMap<
        Request,
        ReturnType<typeof sessionReadAuthorityFromRequest>
      >();
      const mount = domain.bindAtConversationMount((request) => {
        const authority = authorities.get(request);
        if (!authority) throw new Error('ingress scope missing');
        return authority;
      });
      if (mount.kind !== 'bound') throw new Error('mount refused');
      const app = new Hono();
      configureRuntimeHttp({
        app,
        logger: createLogger({
          name: 'native-read-admission-test',
          level: 'error',
        }),
        eventBus: new EventBus(),
        security: {
          verifyCredential: (candidate, route) =>
            route
              ? security.authorizeCredential(candidate, route)
              : security.verifyCredential(candidate),
          recognizeCredential: (candidate) =>
            security.verifyCredential(candidate),
          resolveGrantedScope: (candidate) =>
            security.resolveGrantedScope(candidate),
          resolveCredentialAuthority: (candidate) =>
            security.verifyOperatorCredential(candidate)
              ? 'operator-credential'
              : security.devicePairing.identifyDevice(candidate)
                ? 'device-credential'
                : undefined,
        },
      });
      let continueRead!: () => void;
      const resume = new Promise<void>((resolve) => {
        continueRead = resolve;
      });
      let handle: NativeForkReadAdmissionHandle | undefined;
      app.post(path, async (c) => {
        // Runtime HTTP has already buffered/rebound this JSON Request. The
        // real conversation mount's identity resolver remains a separate cut.
        const finalRequest = c.req.raw;
        expect(
          getRuntimeAuthenticatedRequestPrincipal(finalRequest)?.credential,
        ).toBe(credential);
        await c.req.json();
        authorities.set(
          finalRequest,
          sessionReadAuthorityFromRequest(
            'fixture-owner',
            undefined,
            undefined,
          ),
        );
        const captured = mount.capture(finalRequest);
        expect(captured.kind).toBe('captured');
        if (captured.kind !== 'captured') throw new Error('capture refused');
        handle = captured.handle;
        try {
          expect(domain.verifyForService(handle).kind).toBe('current');
          await resume;
          const result = domain.verifyForService(handle);
          return c.json(
            { kind: result.kind },
            result.kind === 'current' ? 200 : 409,
          );
        } finally {
          mount.release(captured.handle);
          authorities.delete(finalRequest);
        }
      });
      const pending = app.request(`https://station.example.test${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ target: 'not-executed' }),
      });
      try {
        await vi.waitFor(() => expect(handle).toBeDefined());
        if (change === 'device-revoked')
          security.devicePairing.revokeDevice(
            device.device.id,
            'operator-credential',
          );
        if (change === 'scope-narrowed')
          security.devicePairing.setDeviceScope(
            device.device.id,
            ['orchestration:read'],
            approval,
          );
        if (change === 'operator-rotated') await security.rotateCredential();
      } finally {
        continueRead();
      }
      const response = await pending;
      expect(response.status).toBe(change === 'unchanged' ? 200 : 409);
      expect(await response.json()).toEqual({
        kind: change === 'unchanged' ? 'current' : 'unavailable',
      });
      expect(handle).toBeDefined();
      expect(domain.verifyForService(handle).kind).toBe('unavailable');
    },
  );
});
