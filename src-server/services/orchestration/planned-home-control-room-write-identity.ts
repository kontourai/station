import { createHash } from 'node:crypto';
import { plannedHomeAdmissionIdentifier } from './planned-home-admission-schema.js';

const ROOM_WRITE_ADMISSION_NAMESPACE =
  'station.planned-home-room-write-admission/v1';

export function plannedHomeControlRoomWriteAdmissionId(
  channelId: string,
  proposalId: string,
): string {
  if (
    !plannedHomeAdmissionIdentifier(channelId) ||
    !plannedHomeAdmissionIdentifier(proposalId)
  )
    throw new Error('Bounded room-write identity is required');
  return createHash('sha256')
    .update(
      JSON.stringify([ROOM_WRITE_ADMISSION_NAMESPACE, channelId, proposalId]),
    )
    .digest('hex');
}
