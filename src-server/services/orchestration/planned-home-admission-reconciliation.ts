import type { RuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import { plainDataObject } from './bounded-json.js';
import {
  pairedHomeRef,
  personalControllerTenantId,
} from './personal-home-authority-identity.js';
import {
  PLANNED_HOME_ADMISSION_SCHEMA_SQL,
  type PlannedHomeAdmissionRecord,
  plannedHomeAdmissionIdentifier,
  plannedHomeAdmissionRecordValid,
  readPlannedHomeAdmissionJournal,
} from './planned-home-admission-schema.js';
import { createPlannedHomeAdmissionStore } from './planned-home-admission-store.js';
import {
  assertDurableHomeTransferDatabase,
  type HomeTransferDurableDatabase,
} from './planned-home-transfer-store.js';

type OperatorPrincipal = Readonly<
  Pick<RuntimeAuthenticatedRequestPrincipal, 'authority' | 'credential'>
>;
type FinishedAdmission = PlannedHomeAdmissionRecord & {
  state: 'finished';
  receiptDigest: string;
};
export type PlannedHomeAdmissionReconciliationResult =
  | { kind: 'settled'; admission: FinishedAdmission }
  | { kind: 'denied' | 'not-found' | 'conflict' | 'unavailable' };

export interface PlannedHomeAdmissionReceiptVerifier {
  /** Trusted owner adapter: read and verify the actual durable effect receipt.
   * Never echo a caller-supplied digest or infer completion from absence/time. */
  verify(
    admission: Readonly<PlannedHomeAdmissionRecord>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

function exact(value: unknown, keys: string[]): boolean {
  return (
    plainDataObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Private operator recovery. It settles existing evidence only: no new effect,
 * session, replacement, or execution authority can be created here. */
export function createPlannedHomeAdmissionReconciliation(options: {
  database: HomeTransferDurableDatabase;
  security: Pick<
    EnvironmentSecurityService,
    'verifyOperatorCredential' | 'devicePairing'
  >;
  controllerEnvironmentId: string;
  receipts: PlannedHomeAdmissionReceiptVerifier;
  /** A smaller test/adapter budget is allowed; never exceed the five-second cap. */
  receiptTimeoutMs?: number;
}) {
  const { database, security, controllerEnvironmentId } = options;
  const verify = options.receipts?.verify;
  const timeoutMs = options.receiptTimeoutMs ?? 5000;
  if (
    !plannedHomeAdmissionIdentifier(controllerEnvironmentId) ||
    typeof verify !== 'function' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000
  )
    throw new Error('A bounded controller and receipt verifier are required');
  const verifyReceipt = verify.bind(options.receipts);
  const tenantId = personalControllerTenantId(controllerEnvironmentId);
  assertDurableHomeTransferDatabase(database);
  database.exec(PLANNED_HOME_ADMISSION_SCHEMA_SQL);

  async function observe(
    admission: Readonly<PlannedHomeAdmissionRecord>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, timeoutMs);
      });
      const result = await Promise.race([
        Promise.resolve().then(() =>
          verifyReceipt(admission, controller.signal),
        ),
        timeout,
      ]);
      return performance.now() - started < timeoutMs ? result : undefined;
    } catch {
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  return Object.freeze({
    async reconcile(
      principal: OperatorPrincipal,
      input: { deviceId: string; admissionId: string },
    ): Promise<PlannedHomeAdmissionReconciliationResult> {
      try {
        if (
          !exact(input, ['deviceId', 'admissionId']) ||
          !plannedHomeAdmissionIdentifier(input.deviceId) ||
          !plannedHomeAdmissionIdentifier(input.admissionId)
        )
          return { kind: 'conflict' };
        const actor = Object.freeze({
          authority: principal.authority,
          credential: principal.credential,
        });
        const homeRef = pairedHomeRef(input.deviceId);
        const admissionId = input.admissionId;
        const authorized = () =>
          security.devicePairing.environmentId() === controllerEnvironmentId &&
          actor.authority === 'operator-credential' &&
          security.verifyOperatorCredential(actor.credential);
        if (!authorized()) return { kind: 'denied' };
        assertDurableHomeTransferDatabase(database);
        const record = readPlannedHomeAdmissionJournal(database).find(
          (entry) =>
            entry.tenantId === tenantId && entry.admissionId === admissionId,
        );
        if (!authorized()) return { kind: 'denied' };
        if (!record) return { kind: 'not-found' };
        if (record.homeRef !== homeRef) return { kind: 'conflict' };
        if (
          record.state === 'finished' &&
          typeof record.receiptDigest === 'string'
        )
          return {
            kind: 'settled',
            admission: {
              ...record,
              state: 'finished',
              receiptDigest: record.receiptDigest,
            },
          };

        const admission = Object.freeze({ ...record });
        const observation = await observe(admission);
        if (!authorized()) return { kind: 'denied' };
        if (
          !exact(observation, ['kind', 'admission']) ||
          (observation as { kind: unknown }).kind !== 'verified'
        )
          return { kind: 'unavailable' };
        const proof = (observation as { admission: unknown }).admission;
        if (
          !plannedHomeAdmissionRecordValid(proof) ||
          proof.state !== 'finished' ||
          typeof proof.receiptDigest !== 'string'
        )
          return { kind: 'conflict' };
        const identityKeys = Object.keys(admission).filter(
          (key) => key !== 'state',
        ) as Array<keyof PlannedHomeAdmissionRecord>;
        if (!identityKeys.every((key) => admission[key] === proof[key]))
          return { kind: 'conflict' };
        const result = createPlannedHomeAdmissionStore(
          database,
          authorized,
        ).finish({
          tenantId: admission.tenantId,
          channelId: admission.channelId,
          admissionId: admission.admissionId,
          ownerRevision: admission.ownerRevision,
          homeRef: admission.homeRef,
          kind: admission.kind,
          intentDigest: admission.intentDigest,
          receiptDigest: proof.receiptDigest,
        });
        if (result.kind !== 'stored') return result;
        if (
          result.value.state !== 'finished' ||
          typeof result.value.receiptDigest !== 'string'
        )
          return { kind: 'unavailable' };
        return {
          kind: 'settled',
          admission: {
            ...result.value,
            state: 'finished',
            receiptDigest: result.value.receiptDigest,
          },
        };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  });
}
