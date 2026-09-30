import {
  NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
  NATIVE_DEVICE_PROOF_SELF_RECEIPT_VERSION,
  type NativeDeviceProofSelfReceiptV1,
} from '@kontourai/station-contracts/native-device-proof';
import { type Context, Hono } from 'hono';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import type { NativeDeviceProofBindingService } from '../../services/ssh/native-device-proof-binding-service.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface SelfReceiptRouteDeps {
  readonly bindings: NativeDeviceProofBindingService;
  readonly security: Pick<
    EnvironmentSecurityService,
    'identifyDevice' | 'authorizeCredential' | 'resolveGrantedScope'
  >;
}

function currentDevice(request: Request, deps: SelfReceiptRouteDeps) {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (
    principal?.kind !== 'credential' ||
    principal.authority !== 'device-credential' ||
    principal.source !== 'bearer' ||
    principal.deviceKind !== 'device' ||
    !principal.deviceId ||
    !isRuntimeRequestPrincipalCurrent(request, deps.security)
  )
    return undefined;
  const device = deps.security.identifyDevice(principal.credential);
  return device?.kind === 'device' && device.id === principal.deviceId
    ? device
    : undefined;
}

export function createNativeDeviceProofSelfReceiptRoutes(
  deps: SelfReceiptRouteDeps,
) {
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });
  const readReceipt = (context: Context) => {
    const request = context.req.raw;
    try {
      const device = currentDevice(request, deps);
      if (!device)
        return context.json(
          {
            error: {
              version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
              code: 'device_required',
            },
          },
          403,
        );
      const bindingId = context.req.param('bindingId');
      if (typeof bindingId !== 'string' || !UUID_V4.test(bindingId))
        return context.json(
          {
            error: {
              version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
              code: 'invalid_request',
            },
          },
          400,
        );
      const receipt = deps.bindings.bindingReceiptForDevice({
        deviceId: device.id,
        bindingId,
      });
      const latest = currentDevice(request, deps);
      if (latest?.id !== device.id || latest.scope !== device.scope)
        return context.json(
          {
            error: {
              version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
              code: 'device_required',
            },
          },
          403,
        );
      if (!receipt)
        return context.json(
          {
            error: {
              version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
              code: 'not_found',
            },
          },
          404,
        );
      const { binding } = receipt;
      const data: NativeDeviceProofSelfReceiptV1 = {
        version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_VERSION,
        binding: {
          stationId: binding.stationId,
          deviceId: binding.deviceId,
          bindingId: binding.bindingId,
          surface: binding.surface,
          deviceProofJwk: binding.deviceProof.jwk,
          deviceProofKeyThumbprint: binding.deviceProof.thumbprint,
          state: binding.state,
          createdAt: binding.createdAt,
          approvedAt: binding.approvedAt,
          ...(binding.revokedAt === undefined
            ? {}
            : { revokedAt: binding.revokedAt }),
          ...(binding.revocationReason === undefined
            ? {}
            : { revocationReason: binding.revocationReason }),
        },
        currentDeviceBinding: receipt.currentDeviceBinding,
      };
      return context.json({ data });
    } catch {
      return context.json(
        {
          error: {
            version: NATIVE_DEVICE_PROOF_SELF_RECEIPT_ERROR_VERSION,
            code: 'unavailable',
          },
        },
        503,
      );
    }
  };
  app.get('/:bindingId/receipt', readReceipt);
  return app;
}
