import type { TaskRoomWorkInput } from '@kontourai/station-contracts/task-room-work';
import { isRecord } from '../utils/isRecord';

const KEY = 'station-task-room-draft-recovery-v1';
const MAX_ENTRIES = 20;
const MAX_STORAGE_LENGTH = 512_000;

export interface TaskRoomDraftRecovery {
  owner: string;
  draft: string;
  recipient?: { id: string; name: string };
  leadingPerson?: string;
  includeBrief: boolean;
  unconfirmed?: TaskRoomWorkInput;
  unconfirmedMessage?: { proposalId: string; text: string; occurredAt: string };
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit;
}

function input(value: unknown): value is TaskRoomWorkInput {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ['operationId', 'agentId', 'prompt', 'context'].includes(key),
    ) &&
    text(value.operationId, 160) &&
    !!value.operationId.trim() &&
    text(value.agentId, 160) &&
    !!value.agentId.trim() &&
    text(value.prompt, 12_000) &&
    !!value.prompt.trim() &&
    (value.context === undefined ||
      (isRecord(value.context) &&
        Object.keys(value.context).length === 2 &&
        value.context.version === 'station.task-room-context/v1' &&
        typeof value.context.digest === 'string' &&
        /^[0-9a-f]{64}$/.test(value.context.digest)))
  );
}

function entry(value: unknown): value is TaskRoomDraftRecovery {
  return (
    isRecord(value) &&
    text(value.owner, 16_000) &&
    !!value.owner &&
    text(value.draft, 20_000) &&
    typeof value.includeBrief === 'boolean' &&
    (value.leadingPerson === undefined || text(value.leadingPerson, 512)) &&
    (value.recipient === undefined ||
      (isRecord(value.recipient) &&
        text(value.recipient.id, 160) &&
        !!value.recipient.id.trim() &&
        text(value.recipient.name, 512))) &&
    (value.unconfirmedMessage === undefined ||
      (isRecord(value.unconfirmedMessage) &&
        Object.keys(value.unconfirmedMessage).length === 3 &&
        text(value.unconfirmedMessage.proposalId, 160) &&
        !!value.unconfirmedMessage.proposalId.trim() &&
        text(value.unconfirmedMessage.occurredAt, 64) &&
        Number.isFinite(Date.parse(value.unconfirmedMessage.occurredAt)) &&
        text(value.unconfirmedMessage.text, 20_000) &&
        value.unconfirmedMessage.text === value.draft.trim() &&
        value.recipient === undefined &&
        value.unconfirmed === undefined)) &&
    (value.unconfirmed === undefined ||
      (input(value.unconfirmed) &&
        isRecord(value.recipient) &&
        value.recipient.id === value.unconfirmed.agentId))
  );
}

function read(): TaskRoomDraftRecovery[] {
  const bytes = window.sessionStorage.getItem(KEY);
  if (bytes === null) return [];
  if (bytes.length > MAX_STORAGE_LENGTH)
    throw new Error('Recovery storage exceeds its limit');
  const parsed: unknown = JSON.parse(bytes);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.entries) ||
    parsed.entries.length > MAX_ENTRIES ||
    !parsed.entries.every(entry) ||
    new Set(parsed.entries.map((saved) => saved.owner)).size !==
      parsed.entries.length
  )
    throw new Error('Recovery storage is unreadable');
  return parsed.entries;
}

export function readTaskRoomDraft(
  owner: string,
): TaskRoomDraftRecovery | undefined {
  return read().find((saved) => saved.owner === owner);
}

/** No eviction: capacity or quota refusal must not erase an uncertain operation. */
export function saveTaskRoomDraft(saved: TaskRoomDraftRecovery): void {
  if (!entry(saved)) throw new Error('Draft cannot be saved for recovery');
  const entries = read().filter((item) => item.owner !== saved.owner);
  if (saved.draft || saved.recipient || saved.unconfirmed) entries.push(saved);
  if (entries.length > MAX_ENTRIES) throw new Error('Recovery storage is full');
  const bytes = JSON.stringify({ version: 1, entries });
  if (bytes.length > MAX_STORAGE_LENGTH)
    throw new Error('Recovery storage is full');
  window.sessionStorage.setItem(KEY, bytes);
}

export function removeTaskRoomDraft(owner: string): void {
  const entries = read().filter((item) => item.owner !== owner);
  window.sessionStorage.setItem(KEY, JSON.stringify({ version: 1, entries }));
}
