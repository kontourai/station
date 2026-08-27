import {
  decodeGroundedNarrativeRef,
  type GroundedNarrativeRef,
} from '@kontourai/flow-agents/narrative-retained-codecs';
import {
  parseStationAnswerBinding,
  type StationAnswerBinding,
} from './task-basis.js';

export const STATION_ANSWER_NARRATIVE_BINDING_VERSION =
  'station.answer-narrative-binding/v1' as const;
export const STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER =
  'flow-agents.project-narratives/v1' as const;

export interface StationAnswerNarrativePublishInput {
  expectedAnswer: StationAnswerBinding;
  publicationId: string;
  expectedRevision: number;
  ownerId: typeof STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER;
  narrativeRef: GroundedNarrativeRef;
}

/** Identity-only receipt; owner roots and retained bytes never cross this wire. */
export interface StationAnswerNarrativeReceipt {
  sessionId: string;
  turnId: string;
  revision: number;
  active: boolean;
}

/** Protected exact binding plus its current identity-only CAS state. */
export interface StationAnswerNarrativeReadTarget {
  expectedAnswer: StationAnswerBinding;
  /** Zero means no association; a tombstone retains its revision. */
  revision: number;
  active: boolean;
  ownerId: typeof STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER;
}

const MAX_INPUT_BYTES = 8 * 1024;
const MAX_ID_BYTES = 512;

/**
 * Strict route-boundary parser. It snapshots data descriptors before calling
 * Flow Agents' public codec so accessors cannot execute through Station.
 */
export function parseStationAnswerNarrativePublishInput(
  value: unknown,
): StationAnswerNarrativePublishInput | null {
  const record = snapshotRecord(value, [
    'expectedAnswer',
    'expectedRevision',
    'narrativeRef',
    'ownerId',
    'publicationId',
  ]);
  if (
    !record ||
    !safeString(record.publicationId) ||
    record.ownerId !== STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER ||
    !Number.isSafeInteger(record.expectedRevision) ||
    (record.expectedRevision as number) < 0
  )
    return null;
  const expectedAnswer = parseStationAnswerBinding(record.expectedAnswer);
  const narrativeRef = decodeGroundedNarrativeRef(
    snapshotNarrativeRef(record.narrativeRef),
  );
  if (!expectedAnswer || !narrativeRef) return null;
  const parsed = {
    expectedAnswer,
    publicationId: record.publicationId as string,
    expectedRevision: record.expectedRevision as number,
    ownerId: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
    narrativeRef,
  };
  try {
    const serialized = JSON.stringify(parsed);
    return wellFormedPortableStrings(parsed) &&
      utf8ByteLength(serialized) <= MAX_INPUT_BYTES
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function parseStationAnswerNarrativeRemoveInput(
  value: unknown,
): { expectedRevision: number } | null {
  const record = snapshotRecord(value, ['expectedRevision']);
  return record &&
    Number.isSafeInteger(record.expectedRevision) &&
    (record.expectedRevision as number) >= 0
    ? { expectedRevision: record.expectedRevision as number }
    : null;
}

function snapshotNarrativeRef(value: unknown): unknown {
  const record = snapshotRecord(value, [
    'envelopeSha256',
    'narrativeId',
    'schemaVersion',
  ]);
  return record ?? undefined;
}

function snapshotRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const keys = Reflect.ownKeys(value).sort((a, b) =>
      String(a).localeCompare(String(b)),
    );
    const wanted = [...expected].sort();
    if (
      keys.length !== wanted.length ||
      keys.some(
        (key, index) => typeof key !== 'string' || key !== wanted[index],
      )
    )
      return null;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of wanted) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function safeString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    wellFormedUnicode(value) &&
    utf8ByteLength(value) <= MAX_ID_BYTES &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
  );
}

/** This public contract executes in browser clients as well as Node. */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Reject replacement-prone UTF-16 before bytes or URI encoding are used. */
function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** The parsed wire contains only portable identity strings; validate each. */
function wellFormedPortableStrings(value: unknown): boolean {
  if (typeof value === 'string') return wellFormedUnicode(value);
  if (Array.isArray(value)) return value.every(wellFormedPortableStrings);
  if (!value || typeof value !== 'object') return true;
  return Object.values(value).every(wellFormedPortableStrings);
}
