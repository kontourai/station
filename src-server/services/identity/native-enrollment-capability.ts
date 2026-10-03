import { createHash } from 'node:crypto';
import {
  NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH,
  NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_CANCEL_PATH,
  NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH,
  NATIVE_RELAY_ENROLLMENT_LOGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_REGISTER_PATH,
  NATIVE_RELAY_ENROLLMENT_STATUS_PATH,
} from '@kontourai/station-contracts/native-relay-enrollment';
import type {
  ApprovedNativeSurface,
  NativeSurfaceRegistry,
} from '../connections/native-surface-registry.js';
import {
  readVerifiedNativeVirtualApplicationRequest,
  type VerifiedNativeVirtualApplicationRequestFacts,
} from '../connections/virtual-application.js';
import {
  nativeEnrollmentCanonical,
  nativeEnrollmentScopeSchema,
  nativeEnrollmentSurfaceSchema,
} from './native-relay-enrollment-schema.js';

const TOKEN = Symbol('verified-native-enrollment-capability');
const PATHS = new Set<string>([
  NATIVE_RELAY_ENROLLMENT_BEGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_LOGIN_PATH,
  NATIVE_RELAY_ENROLLMENT_REGISTER_PATH,
  NATIVE_RELAY_ENROLLMENT_FINALIZE_PATH,
  NATIVE_RELAY_ENROLLMENT_ACTIVATE_PATH,
  NATIVE_RELAY_ENROLLMENT_STATUS_PATH,
  NATIVE_RELAY_ENROLLMENT_CANCEL_PATH,
]);

/** Bootstrap-only authority from private Pion facts and an explicit operator transport approval. */
export class NativeEnrollmentCapability {
  private constructor(
    token: symbol,
    readonly request: Request,
    readonly facts: VerifiedNativeVirtualApplicationRequestFacts,
    private readonly admission: ApprovedNativeSurface,
  ) {
    if (token !== TOKEN)
      throw new Error('native_enrollment_capability_required');
    Object.freeze(this);
  }
  static forRequest(
    request: Request,
    input: {
      stationId: string;
      origin: string;
      registry: Pick<NativeSurfaceRegistry, 'approvedSurfaces'>;
    },
  ): NativeEnrollmentCapability {
    const facts = readVerifiedNativeVirtualApplicationRequest(request);
    const url = new URL(request.url);
    if (
      !facts ||
      facts.stationId !== input.stationId ||
      facts.requestOrigin !== input.origin ||
      url.origin !== input.origin ||
      request.method !== 'POST' ||
      !PATHS.has(url.pathname) ||
      url.search ||
      url.hash ||
      request.headers.get('content-type') !== 'application/json' ||
      [
        'authorization',
        'cookie',
        'cookie2',
        'origin',
        'x-station-native-device-proof',
        'x-station-native-account-proof',
        'x-station-native-account-continuation',
      ].some((name) => request.headers.has(name))
    )
      throw new Error('native_enrollment_capability_required');
    const scope = nativeEnrollmentScopeSchema.parse({
      stationId: facts.stationId,
      enrollmentId: facts.connectionEnrollmentId,
      routingGeneration: facts.routingGeneration,
    });
    const surface = nativeEnrollmentSurfaceSchema.parse(facts.surface);
    if (facts.connectionId !== surface.clientInstanceId)
      throw new Error('native_enrollment_capability_required');
    const admission = input.registry
      .approvedSurfaces()
      .find(
        (value) =>
          nativeEnrollmentCanonical(value.scope) ===
            nativeEnrollmentCanonical(scope) &&
          nativeEnrollmentCanonical(value.surface) ===
            nativeEnrollmentCanonical(surface),
      );
    if (!admission?.isCurrent())
      throw new Error('native_enrollment_capability_required');
    return new NativeEnrollmentCapability(TOKEN, request, facts, admission);
  }
  assertCurrent(): void {
    if (
      this.request.signal.aborted ||
      readVerifiedNativeVirtualApplicationRequest(this.request) !==
        this.facts ||
      !this.admission.isCurrent()
    )
      throw new Error('native_enrollment_capability_required');
  }
  installationBudgetKey(): string {
    this.assertCurrent();
    return `native-enrollment-install:${createHash('sha256')
      .update(
        nativeEnrollmentCanonical({
          stationId: this.facts.stationId,
          enrollmentId: this.facts.connectionEnrollmentId,
          routingGeneration: this.facts.routingGeneration,
          surface: this.facts.surface,
        }),
      )
      .digest('hex')}`;
  }
}
