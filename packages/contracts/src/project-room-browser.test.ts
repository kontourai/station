import { describe, expect, test } from 'vitest';
import {
  parseProjectRoomBrowserView,
  parseProjectRoomHistory,
  parseProjectRoomMessage,
  parseProjectRoomNote,
  parseProjectRoomPresence,
} from './project-room-browser.js';

const roomId = '7c844dc5-a711-4bb8-bb34-ed14314daaf5';
const actor = { id: 'human:one', displayName: 'One', kind: 'person' };
const scope = {
  stationId: 'station',
  localProjectId: 'local',
  localProjectSlug: 'example',
  portableProjectId: 'portable',
};
const checkpoint = { roomId, lastSeq: 1 };
const message = {
  roomId,
  messageId: roomId,
  intentId: roomId,
  seq: 1,
  actor,
  text: 'hello',
  createdAt: '2026-10-22T12:00:00.000Z',
};
const note = {
  roomId,
  revision: 1,
  markdown: 'note',
  sourceMessageIds: [roomId],
  actor,
  updatedAt: '2026-10-22T12:00:00.000Z',
};
const view = {
  roomId,
  scope,
  checkpoint,
  note,
  actor,
  presence: [
    { clientId: roomId, actor, expiresAt: '2026-10-22T12:00:30.000Z' },
  ],
  capabilities: { view: true, discuss: false, edit: false, execute: false },
};
describe('Room browser transport parsing', () => {
  test('reconstructs typed output and refuses unknown nested authority and malformed identities', () => {
    const parsed = parseProjectRoomBrowserView(view);
    expect(parsed).toEqual(view);
    expect(parsed.actor).not.toBe(actor);
    for (const bad of [
      { ...view, authority: 'admin' },
      { ...view, actor: { ...actor, grant: true } },
      { ...view, scope: { ...scope, secret: 'private' } },
      { ...view, capabilities: { ...view.capabilities, execute: 'true' } },
      { ...view, checkpoint: { ...checkpoint, roomId: 'invalid' } },
      { ...view, note: { ...note, sourceMessageIds: [roomId, roomId] } },
      { ...view, note: { ...note, revision: 0 } },
      { ...view, presence: [{ ...view.presence[0], expiresAt: 'invalid' }] },
      { ...view, presence: Array(101).fill(view.presence[0]) },
    ])
      expect(() => parseProjectRoomBrowserView(bad)).toThrow();
    expect(() =>
      parseProjectRoomPresence([
        { ...view.presence[0], workSessionId: 'invented' },
      ]),
    ).toThrow();
  });
  test('refuses malformed history ordering, cross-Room records, and invalid content bounds', () => {
    const history = {
      roomId,
      scope,
      checkpoint,
      messages: [message],
      nextAfter: null,
    };
    expect(parseProjectRoomHistory(history)).toEqual(history);
    expect(parseProjectRoomMessage(message)).toEqual(message);
    expect(parseProjectRoomNote(note)).toEqual(note);
    for (const bad of [
      { ...history, messages: [message, message] },
      { ...history, checkpoint: { roomId, lastSeq: 0 } },
      {
        ...history,
        messages: [
          { ...message, roomId: 'd01e458a-1a39-43a9-8891-f011f1a6d647' },
        ],
      },
    ])
      expect(() => parseProjectRoomHistory(bad)).toThrow();
    expect(() =>
      parseProjectRoomMessage({ ...message, text: '😀'.repeat(4097) }),
    ).toThrow();
    expect(() =>
      parseProjectRoomNote({ ...note, markdown: '😀'.repeat(2049) }),
    ).toThrow();
  });
});
