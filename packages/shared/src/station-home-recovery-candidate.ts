/**
 * Offline classification only. Inputs are already detached UTF-8 JSON records,
 * not paths or an observed home. Nothing here establishes capture consistency,
 * ownership, import approval, an identity mapping, or execution authority.
 */
import { createHash } from 'node:crypto';

export interface DetachedRecoveryRecord {
  store: string;
  json: string;
}

type Store =
  | 'agent'
  | 'app'
  | 'engine-registry'
  | 'project'
  | 'conversation-history'
  | 'authority'
  | 'credential-payload'
  | 'unknown';
type Disposition =
  | 'inert-agent'
  | 'inert-settings'
  | 'inert-engine-bindings'
  | 'inert-project-bindings'
  | 'historical-evidence-only'
  | 'inert-authority'
  | 'excluded-credential-payload'
  | 'unclassified-evidence';
type Code =
  | 'invalid-json'
  | 'invalid-shape'
  | 'unknown-store'
  | 'owner-engine-mapping-required'
  | 'owner-setting-review-required'
  | 'credential-enrollment-required'
  | 'execution-authority-not-carried'
  | 'history-import-not-implemented';

export interface RecoveryCandidateRecordPlan {
  reference: string;
  store: Store;
  sha256: string;
  bytes: number;
  disposition: Disposition;
  evidenceRetained: boolean;
  codes: Code[];
  observations: {
    engineBinding?: 'absent-station-default' | 'explicit-engine' | 'invalid';
    builtinSelection?:
      | 'absent-unselected'
      | 'explicit-station'
      | 'explicit-engine'
      | 'invalid';
    credentialBinding?:
      | 'absent'
      | 'explicit-default'
      | 'explicit-profile'
      | 'invalid';
    presentationFields?: number;
    unclassifiedFields?: number;
  };
}

export interface StationHomeRecoveryCandidatePlan {
  schema: 'station.home-recovery-candidate/v1';
  declaredSourceSchemaVersion: 1;
  targetSchemaVersion: 2;
  publishable: false;
  snapshotAuthority: 'not-established';
  recordValidation: 'selected-fields-only';
  activeRecordsEmitted: 0;
  records: RecoveryCandidateRecordPlan[];
  requiredDecisions: readonly [
    'offline-capture-and-owner-exclusion',
    'target-home-selection',
    'engine-and-account-mapping',
    'settings-and-history-import-review',
  ];
}

const MAX_RECORDS = 128;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const STORE_DISPOSITIONS: Record<Store, Disposition> = {
  agent: 'inert-agent',
  app: 'inert-settings',
  'engine-registry': 'inert-engine-bindings',
  project: 'inert-project-bindings',
  'conversation-history': 'historical-evidence-only',
  authority: 'inert-authority',
  'credential-payload': 'excluded-credential-payload',
  unknown: 'unclassified-evidence',
};

export class StationHomeRecoveryCandidateError extends Error {
  readonly code = 'STATION_HOME_RECOVERY_CANDIDATE_UNAVAILABLE';
  constructor() {
    // Never attach a JSON parser error or a rejected record to this error.
    super(
      'Detached recovery records are invalid or exceed the supported bounds',
    );
    this.name = 'StationHomeRecoveryCandidateError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function selection(value: Record<string, unknown>, field: string) {
  if (!Object.hasOwn(value, field)) return 'absent' as const;
  if (value[field] === null) return 'null' as const;
  if (typeof value[field] === 'string' && value[field].length > 0)
    return 'string' as const;
  return 'invalid' as const;
}

function classify(
  store: Store,
  text: string,
  plan: RecoveryCandidateRecordPlan,
): void {
  if (store === 'credential-payload') {
    plan.codes.push('credential-enrollment-required');
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    plan.codes.push('invalid-json');
    return;
  }
  if (store === 'unknown') {
    plan.codes.push('unknown-store');
    return;
  }
  if (store === 'conversation-history') {
    if (!Array.isArray(value)) plan.codes.push('invalid-shape');
    plan.codes.push('history-import-not-implemented');
    return;
  }
  if (!record(value)) {
    plan.codes.push('invalid-shape');
    return;
  }
  if (store === 'agent') {
    const execution = Object.hasOwn(value, 'execution') ? value.execution : {};
    if (!record(execution)) {
      plan.codes.push('invalid-shape');
      return;
    }
    const binding = selection(execution, 'agentConnectionId');
    plan.observations.engineBinding =
      binding === 'absent'
        ? 'absent-station-default'
        : binding === 'string'
          ? 'explicit-engine'
          : 'invalid';
    const credential = selection(execution, 'credentialProfileRef');
    plan.observations.credentialBinding =
      credential === 'absent'
        ? 'absent'
        : credential === 'null'
          ? 'explicit-default'
          : credential === 'string'
            ? 'explicit-profile'
            : 'invalid';
    if (binding === 'invalid' || binding === 'null' || credential === 'invalid')
      plan.codes.push('invalid-shape');
    plan.codes.push(
      'owner-engine-mapping-required',
      'credential-enrollment-required',
      'execution-authority-not-carried',
    );
  } else if (store === 'app') {
    const builtin = selection(value, 'builtinAgentEngineConnectionId');
    plan.observations.builtinSelection =
      builtin === 'absent'
        ? 'absent-unselected'
        : builtin === 'null'
          ? 'explicit-station'
          : builtin === 'string'
            ? 'explicit-engine'
            : 'invalid';
    if (builtin === 'invalid') plan.codes.push('invalid-shape');
    // This is a review candidate, not a safe automatic copy allowlist. All
    // values and unknown keys stay in the private original record only.
    plan.observations.presentationFields = Object.hasOwn(
      value,
      'defaultChatFontSize',
    )
      ? 1
      : 0;
    plan.observations.unclassifiedFields = Object.keys(value).filter(
      (key) =>
        key !== 'defaultChatFontSize' &&
        key !== 'builtinAgentEngineConnectionId',
    ).length;
    plan.codes.push(
      'owner-setting-review-required',
      'owner-engine-mapping-required',
      'execution-authority-not-carried',
    );
  } else if (store === 'engine-registry') {
    if (value.version !== 1) plan.codes.push('invalid-shape');
    plan.codes.push(
      'owner-engine-mapping-required',
      'execution-authority-not-carried',
    );
  } else if (store === 'project') {
    plan.codes.push(
      'owner-setting-review-required',
      'execution-authority-not-carried',
    );
  } else plan.codes.push('execution-authority-not-carried');
}

/** Private archive-owner preparation; payloads must never become a public receipt. */
export function prepareDetachedRecoveryCandidate(
  input: readonly DetachedRecoveryRecord[],
  declaredSourceSchemaVersion: 1,
): {
  plan: StationHomeRecoveryCandidatePlan;
  payloads: Array<{ reference: string; bytes: Buffer }>;
} {
  if (
    declaredSourceSchemaVersion !== 1 ||
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > MAX_RECORDS
  )
    throw new StationHomeRecoveryCandidateError();
  const records: RecoveryCandidateRecordPlan[] = [];
  const payloads: Array<{ reference: string; bytes: Buffer }> = [];
  let total = 0;
  for (let index = 0; index < input.length; index += 1) {
    const entry = input[index];
    if (!record(entry)) throw new StationHomeRecoveryCandidateError();
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (
      Object.keys(descriptors).length !== 2 ||
      !descriptors.store ||
      !descriptors.json ||
      !('value' in descriptors.store) ||
      !('value' in descriptors.json)
    )
      throw new StationHomeRecoveryCandidateError();
    const { value: storeValue } = descriptors.store;
    const { value: json } = descriptors.json;
    if (
      typeof storeValue !== 'string' ||
      storeValue.length > 64 ||
      typeof json !== 'string' ||
      json.length > MAX_RECORD_BYTES
    )
      throw new StationHomeRecoveryCandidateError();
    const bytes = Buffer.byteLength(json);
    total += bytes;
    if (bytes > MAX_RECORD_BYTES || total > MAX_TOTAL_BYTES)
      throw new StationHomeRecoveryCandidateError();
    const store: Store = Object.hasOwn(STORE_DISPOSITIONS, storeValue)
      ? (storeValue as Store)
      : 'unknown';
    const reference = `record-${String(index + 1).padStart(4, '0')}`;
    const plan: RecoveryCandidateRecordPlan = {
      reference,
      store,
      sha256: createHash('sha256').update(json).digest('hex'),
      bytes,
      disposition: STORE_DISPOSITIONS[store],
      evidenceRetained: store !== 'credential-payload',
      codes: [],
      observations: {},
    };
    classify(store, json, plan);
    records.push(plan);
    if (plan.evidenceRetained)
      payloads.push({ reference, bytes: Buffer.from(json) });
  }
  return {
    plan: {
      schema: 'station.home-recovery-candidate/v1',
      declaredSourceSchemaVersion: 1,
      targetSchemaVersion: 2,
      publishable: false,
      snapshotAuthority: 'not-established',
      recordValidation: 'selected-fields-only',
      activeRecordsEmitted: 0,
      records,
      requiredDecisions: [
        'offline-capture-and-owner-exclusion',
        'target-home-selection',
        'engine-and-account-mapping',
        'settings-and-history-import-review',
      ],
    },
    payloads,
  };
}
