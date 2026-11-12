import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ProjectTaskRoomBrowserHistory,
  ProjectTaskRoomBrowserLiveSnapshot,
  ProjectTaskRoomBrowserRecord,
} from '@kontourai/station-contracts/project-task-room-browser';
import { TASK_ROOM_WORK_VERSION } from '@kontourai/station-contracts/task-room-work';
import type { Page, Route } from '@playwright/test';
import { createProjectTaskRoomRoutes } from '../../src-server/routes/orchestration/project-task-rooms';
import type { ProjectTaskRoomRuntime } from '../../src-server/services/orchestration/project-task-room-runtime';
import { rejectUnexpectedFixtureRequest } from './fixture-audit';

/**
 * Room conversation gallery fixtures (#4791). Each value is the exact shape
 * the browser projections parse: `@kontourai/station-sdk/project-rooms`
 * (strict zod over `project-room-browser`) for the Project room and
 * `parseProjectTaskRoomBrowserHistory` / the live snapshot for the Task room.
 * Times are fixed instants so a capture never depends on its wall clock; they
 * sit between 13:00 and 17:00 UTC so the day dividers fall on the same dates
 * from UTC-8 through UTC+6.
 */

const ROOM_ID = '7b0d3a52-9c1e-4c55-9a8b-2f4c1d7e6a10';
/** The `channels` scene's second channel (#4792); `#general` is ROOM_ID. */
const DESIGN_ID = '7b0d3a52-9c1e-4c55-9a8b-2f4c1d7e6a11';
const VIEWER = { id: 'person:maya', displayName: 'Maya Chen', kind: 'person' };
const JONAS = { id: 'person:jonas', displayName: 'Jonas Berg', kind: 'person' };
const PRIYA = {
  id: 'person:priya',
  displayName: 'Priya Natarajan',
  kind: 'person',
};
const SCOUT = { id: 'agent:scout', displayName: 'Scout', kind: 'agent' };
type RoomActor = typeof VIEWER;

function uuid(seed: number, prefix = 'a1') {
  const hex = seed.toString(16).padStart(12, '0');
  return `${prefix}${'0'.repeat(6)}-0000-4000-8000-${hex}`;
}

function at(day: number, hour: number, minute: number) {
  return new Date(Date.UTC(2026, 10, 2 + day, hour, minute, 0)).toISOString();
}

interface ProjectLine {
  actor: RoomActor;
  at: string;
  text: string;
  /** The 1-based sequence of the message this replies to. */
  replyTo?: number;
}

const SHORT: ProjectLine[] = [
  {
    actor: JONAS,
    at: at(1, 14, 2),
    text: 'Morning! The pricing page copy is ready for review.',
  },
  {
    actor: JONAS,
    at: at(1, 14, 3),
    text: 'I kept the three tiers and moved the FAQ under the table.',
  },
  {
    actor: SCOUT,
    at: at(1, 14, 6),
    text: 'I checked the draft against the plan limits in `pricing.yaml`. Two numbers differ:\n\n- **Team** lists 10 seats; the plan allows **15**.\n- **Business** says 30-day history; the plan keeps **90 days**.',
  },
  {
    actor: VIEWER,
    at: at(1, 14, 11),
    text: 'Good catch. Jonas, can you update both before we ship?',
  },
];

function longHistory(): ProjectLine[] {
  const lines: ProjectLine[] = [
    {
      actor: PRIYA,
      at: at(0, 13, 4),
      text: 'Kicking off the onboarding revamp in this room.',
    },
    {
      actor: PRIYA,
      at: at(0, 13, 5),
      text: 'Goal: a new teammate sends their first message in under two minutes.',
    },
    {
      actor: JONAS,
      at: at(0, 13, 20),
      text: 'Love it. I can take the empty states.',
    },
    {
      actor: VIEWER,
      at: at(0, 13, 31),
      text: 'I will pair on the welcome flow.',
    },
    {
      actor: SCOUT,
      at: at(0, 13, 40),
      text: 'Here is what new members hit today:\n\n1. An empty room with no prompt.\n2. A composer that sends only on Cmd+Enter.\n3. No way to tell agents from people.\n\nThe second one breaks on phones.',
    },
    { actor: PRIYA, at: at(0, 15, 2), text: 'That matches what support sees.' },
    {
      actor: JONAS,
      at: at(1, 13, 9),
      text: 'First pass of the empty state is up.',
    },
    { actor: JONAS, at: at(1, 13, 10), text: 'Copy is placeholder for now.' },
    {
      actor: JONAS,
      at: at(1, 13, 12),
      text: 'Screens are in the design file under **Rooms / Empty**.',
    },
    {
      actor: VIEWER,
      at: at(1, 13, 30),
      text: 'Looks clean. Can the prompt mention @ for agents?',
    },
    { actor: JONAS, at: at(1, 13, 33), text: 'Yes, adding it.', replyTo: 10 },
    { actor: PRIYA, at: at(1, 14, 48), text: 'Reminder: design review at 3.' },
    {
      actor: SCOUT,
      at: at(1, 16, 1),
      text: 'Summary of the review:\n\n- Ship grouped messages and day dividers first.\n- Keep timestamps short; full time on hover.\n- Agents get a square avatar, people a round one.\n\n```text\nOwner: Jonas  Due: Friday\n```',
    },
  ];
  for (let index = 0; index < 30; index += 1) {
    const author = [VIEWER, JONAS, PRIYA, JONAS][index % 4];
    lines.push({
      actor: author,
      at: at(1, 16, 10 + index),
      text: [
        'Pushed the next round of fixes.',
        'Checking it on my phone now.',
        'Copy looks good to me.',
        'One more tweak and we are done for today.',
      ][index % 4],
    });
  }
  // The last screen: a new day, grouped runs, an agent group and a reply.
  lines.push(
    {
      actor: JONAS,
      at: at(2, 13, 2),
      text: 'Morning! The avatar changes are live.',
    },
    {
      actor: JONAS,
      at: at(2, 13, 3),
      text: 'People are circles and agents are squares now, 36px on desktop and 32 on phones.',
    },
    {
      actor: JONAS,
      at: at(2, 13, 4),
      text: 'Can someone check it on a phone?',
    },
    { actor: VIEWER, at: at(2, 13, 20), text: 'On it.' },
    {
      actor: VIEWER,
      at: at(2, 13, 22),
      text: 'Looks great on mine. The day dividers read clearly in dark mode too.',
    },
    {
      actor: SCOUT,
      at: at(2, 13, 40),
      text: 'All 12 onboarding checks pass on the latest build.',
    },
    {
      actor: SCOUT,
      at: at(2, 13, 41),
      text: 'Slowest step: the first sync at **1.4s**, down from 2.9s.',
    },
    {
      actor: PRIYA,
      at: at(2, 13, 58),
      text: 'Great. Let’s ship it tomorrow morning.',
    },
  );
  lines.push({
    actor: JONAS,
    at: at(2, 14, 2),
    text: 'Release notes are in the doc.',
    // Sequence numbers are 1-based: this replies to Scout's second message.
    replyTo: lines.length - 1,
  });
  return lines;
}

export type ProjectRoomScene =
  | 'empty'
  | 'short'
  | 'long'
  | 'failed-send'
  | 'new-messages'
  | 'mention'
  | 'agent-pending'
  | 'agent-abandon'
  /** The short room with the composer focused and, on a phone, a keyboard. */
  | 'keyboard'
  | 'channels'
  /**
   * #4794/#4795: the channel list, a channel and a thread. `#general` holds
   * the short history plus two replies to Scout's message (its thread).
   */
  | 'navigation';

/** Replies to Scout's plan check (sequence 3): the navigation scene's thread. */
const THREAD_REPLIES: ProjectLine[] = [
  {
    actor: PRIYA,
    at: at(1, 14, 20),
    text: 'Both numbers are fixed in the draft now.',
    replyTo: 3,
  },
  {
    actor: JONAS,
    at: at(1, 14, 26),
    text: 'Thanks. Shipping it after lunch.',
    replyTo: 3,
  },
];

function projectLines(scene: ProjectRoomScene): ProjectLine[] {
  if (scene === 'empty') return [];
  if (scene === 'long' || scene === 'new-messages') return longHistory();
  if (scene === 'navigation') return [...SHORT, ...THREAD_REPLIES];
  return SHORT;
}

/** The navigation scene's thread root: Scout's plan check. */
export const NAVIGATION_THREAD_ROOT = uuid(3, 'c1');
/** `#design` room id, for routes and read markers. */
export const GALLERY_DESIGN_ROOM_ID = DESIGN_ID;

/** Arrive after the reader scrolls up in the new-messages scene. */
const ARRIVALS: ProjectLine[] = [
  { actor: JONAS, at: at(2, 16, 4), text: 'Release notes are drafted.' },
  { actor: JONAS, at: at(2, 16, 5), text: 'Can someone give them a read?' },
  {
    actor: SCOUT,
    at: at(2, 16, 7),
    text: 'Read them. Two links point at the old docs path; everything else checks out.',
  },
];

/** `#design` in the channels scene: its own room and history. */
const DESIGN: ProjectLine[] = [
  {
    actor: PRIYA,
    at: at(1, 15, 2),
    text: 'New checkout screens are up for review.',
  },
  {
    actor: VIEWER,
    at: at(1, 15, 9),
    text: 'The step indicator reads well on phones. Can we shorten the CTA?',
  },
];
/** Channels as the server lists them: default first, then by name. */
function projectChannels(scene: ProjectRoomScene) {
  const general = { channelId: ROOM_ID, name: 'general', isDefault: true };
  if (scene !== 'channels' && scene !== 'navigation') return [general];
  return [
    { ...general, topic: 'Team-wide updates and launch decisions' },
    {
      channelId: DESIGN_ID,
      name: 'design',
      topic: 'Screens, flows and the checkout review',
      isDefault: false,
    },
    { channelId: uuid(3, 'e1'), name: 'launch-plan', isDefault: false },
    {
      channelId: uuid(4, 'e1'),
      name: 'user-research',
      archivedAt: at(0, 13, 0),
      isDefault: false,
    },
  ];
}

function projectMessage(line: ProjectLine, seq: number, roomId = ROOM_ID) {
  return {
    intentId: uuid(seq, roomId === ROOM_ID ? 'b1' : 'b2'),
    text: line.text,
    ...(line.replyTo ? { replyTo: uuid(line.replyTo, 'c1') } : {}),
    roomId,
    messageId: uuid(seq, roomId === ROOM_ID ? 'c1' : 'c2'),
    seq,
    actor: line.actor,
    createdAt: line.at,
  };
}

/**
 * Installs the Project room's read, presence and event routes for one scene.
 * `deliver()` (new-messages only) publishes the arrivals through the room's
 * own `changed` event on a held-open stream.
 */
export async function installProjectRoomFixture(
  page: Page,
  input: {
    slug: string;
    projectId: string;
    scene: ProjectRoomScene;
  },
) {
  const { slug, projectId, scene } = input;
  const lines = [...projectLines(scene)];
  let delivered = false;
  const messages = () =>
    (delivered ? [...lines, ...ARRIVALS] : lines).map((line, index) =>
      projectMessage(line, index + 1),
    );
  const scope = {
    stationId: 'station:gallery',
    localProjectId: projectId,
    localProjectSlug: slug,
    portableProjectId: `portable-${slug}`,
  };
  const presence = [JONAS, SCOUT].map((actor, index) => ({
    clientId: uuid(index + 1, 'd1'),
    actor,
    expiresAt: '2099-01-01T00:00:00.000Z',
  }));
  // The room's event stream is a real, open SSE response from this local
  // server: a fulfilled body would end the stream, which the room rightly
  // shows as a dropped connection. `deliver()` pushes a `changed` frame, the
  // way a live Station announces new rows.
  const streams = new Set<ServerResponse>();
  const events = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
    });
    response.write(': open\n\n');
    streams.add(response);
    response.on('close', () => streams.delete(response));
  });
  await new Promise<void>((resolve) => events.listen(0, '127.0.0.1', resolve));
  const eventsUrl = `http://127.0.0.1:${(events.address() as AddressInfo).port}/events`;
  const project = `**/api/projects/${encodeURIComponent(slug)}`;
  const base = `${project}/room`;
  /** Discovery, history, presence and events for one room address. */
  const roomRoutes = (
    address: string,
    roomId: string,
    read: () => ReturnType<typeof projectMessage>[],
    failSend: boolean,
  ): [string, (route: Route) => Promise<void> | void][] => [
    [
      address,
      (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        const all = read();
        return route.fulfill({
          json: {
            success: true,
            data: {
              scope,
              roomId,
              capabilities: {
                view: true,
                discuss: true,
                edit: true,
                execute: true,
              },
              checkpoint: { roomId, lastSeq: all.length },
              note: null,
              actor: VIEWER,
              presence,
            },
          },
        });
      },
    ],
    [
      `${address}/messages*`,
      (route) => {
        const request = route.request();
        if (request.method() === 'POST') {
          if (failSend)
            return route.fulfill({
              status: 503,
              json: {
                success: false,
                error: 'Station is restarting.',
                code: 'service_unavailable',
              },
            });
          return rejectUnexpectedFixtureRequest(route);
        }
        if (request.method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        const url = new URL(request.url());
        const after = Number(url.searchParams.get('after') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 25);
        const all = read();
        const page = all.filter(
          (message) => message.seq > after && message.seq <= after + limit,
        );
        const last = page.at(-1)?.seq ?? after;
        return route.fulfill({
          json: {
            success: true,
            data: {
              scope,
              roomId,
              messages: page,
              checkpoint: { roomId, lastSeq: all.length },
              nextAfter:
                last < Math.min(all.length, after + limit) ? last : null,
            },
          },
        });
      },
    ],
    [
      `${address}/presence`,
      (route) => {
        if (route.request().method() !== 'POST')
          return rejectUnexpectedFixtureRequest(route);
        return route.fulfill({ json: { success: true, data: presence } });
      },
    ],
    [
      `${address}/events`,
      (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        return route.continue({ url: eventsUrl });
      },
    ],
  ];
  const handlers: [string, (route: Route) => Promise<void> | void][] = [
    ...roomRoutes(base, ROOM_ID, messages, scene === 'failed-send'),
    // A full room marks itself read through what it shows (#4794); these
    // rooms are fixture rooms, so the fixture answers as the server would.
    [
      '**/api/read-markers/mark',
      (route) => {
        if (route.request().method() !== 'POST')
          return rejectUnexpectedFixtureRequest(route);
        const { target, version } = route.request().postDataJSON() as {
          target: { kind: string; roomId?: string };
          version: number;
        };
        if (target.kind !== 'project-room')
          return rejectUnexpectedFixtureRequest(route);
        return route.fulfill({
          json: {
            success: true,
            data: {
              target,
              latestVersion: version,
              seenVersion: version,
              unread: false,
              unreadCount: 0,
            },
          },
        });
      },
    ],
    [
      `${project}/channels`,
      (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        return route.fulfill({
          json: { success: true, data: { channels: projectChannels(scene) } },
        });
      },
    ],
  ];
  if (scene === 'channels' || scene === 'navigation')
    handlers.push(
      ...roomRoutes(
        `${project}/channels/${DESIGN_ID}`,
        DESIGN_ID,
        () =>
          DESIGN.map((line, index) =>
            projectMessage(line, index + 1, DESIGN_ID),
          ),
        false,
      ),
    );
  if (scene === 'agent-pending' || scene === 'agent-abandon') {
    // The Station's real catalog plus one available Agent, Scout, shaped like
    // the catalog's own entries.
    handlers.push([
      '**/api/agents',
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        const sample = Array.isArray(body?.data) ? body.data[0] : undefined;
        if (Array.isArray(body?.data))
          body.data.push({
            ...(sample ?? {}),
            slug: 'scout',
            name: 'Scout',
            description: 'Checks drafts against the plan.',
            available: true,
          });
        return route.fulfill({ response, json: body });
      },
    ]);
    let handle: Record<string, unknown> | undefined;
    handlers.push([
      `${base}/agents`,
      (route) => {
        if (route.request().method() !== 'POST')
          return rejectUnexpectedFixtureRequest(route);
        // agent-abandon: the acknowledgement is lost, so no handle exists.
        if (scene === 'agent-abandon')
          return route.fulfill({
            status: 503,
            json: { success: false, error: 'Station is restarting.' },
          });
        const intent = route.request().postDataJSON();
        handle = {
          intentId: intent.intentId,
          agentId: intent.agentId,
          text: intent.text,
          ...(intent.replyTo ? { replyTo: intent.replyTo } : {}),
          roomId: ROOM_ID,
          requestId: uuid(1, 'f1'),
          actor: VIEWER,
          state: 'started',
          createdAt: at(2, 16, 10),
          updatedAt: at(2, 16, 10),
        };
        return route.fulfill({ json: { success: true, data: handle } });
      },
    ]);
    handlers.push([
      `${base}/agents/*`,
      (route) => {
        if (route.request().method() !== 'GET' || !handle)
          return rejectUnexpectedFixtureRequest(route);
        return route.fulfill({ json: { success: true, data: handle } });
      },
    ]);
  }
  for (const [pattern, handler] of handlers) await page.route(pattern, handler);
  return {
    arrivals: ARRIVALS.length,
    /** Adds the arrivals to later reads and announces them on the stream. */
    deliver() {
      delivered = true;
      const frame = `event: changed\ndata: ${JSON.stringify({ roomId: ROOM_ID, lastSeq: lines.length + ARRIVALS.length })}\n\n`;
      for (const stream of streams) stream.write(frame);
    },
    async cleanup() {
      for (const stream of streams) stream.end();
      await new Promise<void>((resolve) => events.close(() => resolve()));
      for (const [pattern, handler] of handlers)
        await page.unroute(pattern, handler);
    },
  };
}

/**
 * The sidebar's and phone list's reads for one Project (#4794): its Tasks, a
 * running session behind one of them, and the read-marker summary and mark
 * routes (#3075) in the exact shapes `@kontourai/station-contracts/
 * read-markers` defines. Markers are stateful: marking a room read makes the
 * next summary answer it read, as the server does.
 */
export async function installProjectConversationsFixture(
  page: Page,
  input: { slug: string; projectId: string },
) {
  const { slug, projectId } = input;
  const task = (
    index: number,
    title: string,
    updatedAt: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: `task:${slug}-${index}`,
    projectId,
    title,
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'person:maya',
    createdAt: at(0, 13, 0),
    updatedAt,
    ...extra,
  });
  const runningSession = `station:${slug}-review`;
  const tasks = [
    task(1, 'Fix the login redirect on Safari', at(2, 15, 40), {
      sessionId: runningSession,
    }),
    task(2, 'Draft the release notes for 2.4', at(2, 15, 10)),
    task(3, 'Audit the pricing page copy', at(2, 14, 0), { status: 'review' }),
    // No room was ever opened for this Task: the summary answers unavailable.
    task(4, 'Rename the onboarding checklist', at(2, 13, 0)),
  ];
  /** Room latest versions, and what this person has seen of each. */
  const rooms = new Map<string, { latest: number; seen: number }>([
    [`project-room:${slug}:${ROOM_ID}`, { latest: 6, seen: 3 }],
    [`project-room:${slug}:${DESIGN_ID}`, { latest: 2, seen: 2 }],
    [`project-room:${slug}:${uuid(3, 'e1')}`, { latest: 9, seen: 8 }],
    [`task-room:${tasks[0]!.id}`, { latest: 12, seen: 10 }],
    [`task-room:${tasks[1]!.id}`, { latest: 4, seen: 4 }],
    [`task-room:${tasks[2]!.id}`, { latest: 7, seen: 7 }],
  ]);
  type Target =
    | { kind: 'project-room'; projectSlug: string; roomId: string }
    | { kind: 'task-room'; taskId: string }
    | { kind: 'agent-conversation'; conversationId: string };
  const keyOf = (target: Target) =>
    target.kind === 'project-room'
      ? `project-room:${target.projectSlug}:${target.roomId}`
      : target.kind === 'task-room'
        ? `task-room:${target.taskId}`
        : `agent-conversation:${target.conversationId}`;
  const stateOf = (target: Target) => {
    const room = rooms.get(keyOf(target));
    if (!room) return { target, unavailable: true as const };
    return {
      target,
      latestVersion: room.latest,
      seenVersion: room.seen,
      unread: room.latest > room.seen,
      unreadCount: Math.min(room.latest - room.seen, 99),
    };
  };
  const handlers: [
    string | ((url: URL) => boolean),
    (route: Route) => Promise<void> | void,
  ][] = [
    [
      '**/api/read-markers/summary',
      (route) => {
        if (route.request().method() !== 'POST')
          return rejectUnexpectedFixtureRequest(route);
        const { targets } = route.request().postDataJSON() as {
          targets: Target[];
        };
        return route.fulfill({
          json: { success: true, data: { items: targets.map(stateOf) } },
        });
      },
    ],
    [
      '**/api/read-markers/mark',
      (route) => {
        if (route.request().method() !== 'POST')
          return rejectUnexpectedFixtureRequest(route);
        const { target, version } = route.request().postDataJSON() as {
          target: Target;
          version: number;
        };
        const room = rooms.get(keyOf(target));
        if (!room) return rejectUnexpectedFixtureRequest(route);
        room.seen = Math.max(room.seen, Math.min(version, room.latest));
        return route.fulfill({
          json: { success: true, data: stateOf(target) },
        });
      },
    ],
    [
      (url) =>
        url.pathname === '/api/tasks' &&
        url.searchParams.get('projectId') === slug,
      (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        return route.fulfill({ json: { success: true, data: tasks } });
      },
    ],
    [
      '**/api/orchestration/sessions/read-model',
      (route) =>
        route.fulfill({
          json: {
            success: true,
            data: [
              {
                provider: 'station',
                threadId: runningSession,
                projectSlug: slug,
                status: 'busy',
                controlMode: 'station-owned',
                lifecycleState: 'running',
                hasActiveTurn: true,
                answerability: { answerable: true },
                isLoaded: true,
                isPersisted: true,
                eventCount: 1,
                createdAt: at(2, 15, 30),
                updatedAt: at(2, 15, 40),
              },
            ],
          },
        }),
    ],
  ];
  for (const [pattern, handler] of handlers) await page.route(pattern, handler);
  return {
    tasks,
    async cleanup() {
      for (const [pattern, handler] of handlers)
        await page.unroute(pattern, handler);
    },
  };
}

const DIGESTS = { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) };
const CHECKPOINT = {
  checkpointDigest: 'c'.repeat(64),
  retainedAnchorSeq: 0,
  retainedAnchorDigest: 'd'.repeat(64),
};
const IMAGE_ID = '5f2c7e1a-3b4d-4c6e-8f90-1a2b3c4d5e6f';
/** A real phone screenshot from the repo stands in for a shared image. */
const IMAGE_PNG = readFileSync(
  new URL(
    '../../docs/design/media/browser-device-ux-browser-390.png',
    import.meta.url,
  ),
);

type TaskRecordInput = Omit<
  ProjectTaskRoomBrowserRecord,
  'digests' | 'integrity' | 'sequence'
>;
const human = (
  name: string,
  occurredAt: string,
  text: string,
  extra: Partial<TaskRecordInput> = {},
): TaskRecordInput => ({
  actor: {
    kind: 'human',
    label: name,
    id: `person:${name.split(' ')[0].toLowerCase()}`,
    standing: name === 'Maya Chen' ? 'operator' : 'member',
  },
  occurredAt,
  body: { kind: 'human-message', text },
  ...extra,
});
const agent = (
  occurredAt: string,
  text: string,
  sessionId: string,
  turnId: string,
): TaskRecordInput => ({
  actor: { kind: 'agent', label: 'Scout', id: 'agent:scout' },
  occurredAt,
  execution: { sessionId, turnId },
  body: { kind: 'human-message', text },
});

/**
 * The real Task-room routes, used only for their request validation: the
 * runtime answers every accepted command `unavailable`, and the fixture then
 * gives its own answer.
 */
const LIVE_COMMAND_ROUTE = createProjectTaskRoomRoutes({
  live: async () => ({ kind: 'unavailable' }),
} as unknown as ProjectTaskRoomRuntime);

export type TaskRoomScene = 'thread' | 'working';

function taskRecords(scene: TaskRoomScene): TaskRecordInput[] {
  if (scene === 'thread')
    return [
      human(
        'Priya Natarajan',
        at(2, 13, 2),
        'Here is the crash from the beta build.',
        {
          body: {
            kind: 'human-message',
            text: 'Here is the crash from the beta build.',
            attachments: [
              {
                id: IMAGE_ID,
                kind: 'image',
                name: 'crash-report.png',
                mimeType: 'image/png',
                size: IMAGE_PNG.byteLength,
              },
            ],
          },
        },
      ),
      human(
        'Priya Natarajan',
        at(2, 13, 3),
        'It happens right after sign-in on Android.',
      ),
      human('Maya Chen', at(2, 13, 9), '**@Scout** can you find the cause?'),
      agent(
        at(2, 13, 14),
        'The crash comes from `SessionStore.restore()` reading a token before the keystore is unlocked.\n\n**Fix:** wait for `onUnlocked` before restoring.\n\n```kotlin\nkeystore.onUnlocked { store.restore() }\n```',
        'session-thread',
        'turn-1',
      ),
      human('Maya Chen', at(2, 13, 20), 'Does this also cover tablets?', {
        threadSessionId: 'session-thread',
      }),
      agent(
        at(2, 13, 22),
        'Yes. Tablets use the same keystore path.',
        'session-thread',
        'turn-2',
      ),
      human(
        'Jonas Berg',
        at(2, 13, 31),
        'Shipping the fix in the next build.',
        {
          threadSessionId: 'session-thread',
        },
      ),
      human(
        'Jonas Berg',
        at(2, 13, 40),
        'Thanks both, that unblocks the release.',
      ),
    ];
  return [
    human(
      'Maya Chen',
      at(2, 14, 1),
      '**@Scout** run the onboarding checks on the latest build.',
    ),
    {
      actor: { kind: 'agent', label: 'Scout', id: 'agent:scout' },
      occurredAt: at(2, 14, 30),
      system: true,
      body: {
        kind: 'live-work-finished',
        sessionId: 'session-failed',
        outcome: 'failed',
      },
    },
    human('Maya Chen', at(2, 14, 33), 'Retrying with the staging config.'),
    human(
      'Jonas Berg',
      at(2, 14, 40),
      'While that runs: the copy review is done.',
    ),
  ];
}

function taskHistory(scene: TaskRoomScene): ProjectTaskRoomBrowserHistory {
  const records = taskRecords(scene).map((record, index) => ({
    ...record,
    sequence: index + 1,
    digests: DIGESTS,
    integrity: 'L0' as const,
  }));
  return {
    kind: 'available',
    records,
    checkpoint: { throughSeq: records.length, ...CHECKPOINT },
    hasMore: false,
    integrity: 'L0',
  };
}

/**
 * Installs a fixture Task and its room. The Task is never written to the
 * Station: the task graph has no delete, so a real Task would outlive the
 * scene and change every later screen (Home would stop being first-run and
 * the Inbox would list it). Every task-scoped read is answered here in the
 * shape the server returns (captured from a real Task), the Task joins the
 * Task list only while the scene runs, and any task-scoped request this file
 * does not model is refused. The Project is real and the caller deletes it.
 */
export async function installTaskRoomFixture(
  page: Page,
  input: {
    /** Project slug; a Task's `projectId` is its Project's slug. */
    slug: string;
    /** The Project's id, as agent-request records carry it. */
    projectUuid: string;
    scene: TaskRoomScene;
  },
) {
  const { slug, projectUuid, scene } = input;
  const digest = createHash('sha256').update(slug).digest('hex');
  const taskId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const taskCreatedAt = at(2, 12, 0);
  const projectId = slug;
  const encoded = encodeURIComponent(taskId);
  const origin = {
    version: 1,
    actor: { kind: 'operator' },
    reported: { version: 1, surface: 'unknown', build: null },
  };
  const task = {
    id: taskId,
    projectId,
    title: 'Fix the Android sign-in crash',
    description: '',
    priority: 'normal',
    status: 'todo',
    createdBy: 'user',
    createdAt: taskCreatedAt,
    updatedAt: taskCreatedAt,
    createdClientOrigin: origin,
    updatedClientOrigin: origin,
    workspaceBinding: {
      availability: 'available',
      workingDirectory: `/srv/station/workspaces/${slug}`,
      capturedAt: taskCreatedAt,
    },
  };
  const taskRef = { taskId, taskCreatedAt };
  const live: ProjectTaskRoomBrowserLiveSnapshot = {
    generation: 'gallery-generation',
    viewerActorId: 'person:maya',
    scope: { projectId, taskId },
    state: 'active',
    participants:
      scene === 'working'
        ? [
            {
              actor: { actorId: 'agent:scout', kind: 'agent', label: 'Scout' },
              work: {
                sessionId: 'session-running',
                workName: 'Onboarding checks',
                workState: 'working',
                startedAt: Date.now() - 4 * 60_000,
              },
              publication: 'published',
            },
          ]
        : [],
    panes: [],
    cursors: [],
  };
  const revision = `swsr-v1:${'a'.repeat(64)}`;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const get =
    (data: unknown) =>
    (route: Route): Promise<void> =>
      route.request().method() !== 'GET'
        ? rejectUnexpectedFixtureRequest(route)
        : route.fulfill({ json: { success: true, data } });
  const handlers: [string, (route: Route) => Promise<void> | void][] = [
    // Registered first, so every handler below takes precedence over it.
    [
      `**/api/tasks/${encoded}/**`,
      (route) => rejectUnexpectedFixtureRequest(route),
    ],
    // The open room marks itself read through its checkpoint (#4794).
    [
      '**/api/read-markers/mark',
      (route) => {
        const body = route.request().postDataJSON() as {
          target: { kind: string; taskId?: string };
          version: number;
        };
        if (
          route.request().method() !== 'POST' ||
          body.target.kind !== 'task-room' ||
          body.target.taskId !== taskId
        )
          return rejectUnexpectedFixtureRequest(route);
        return route.fulfill({
          json: {
            success: true,
            data: {
              target: body.target,
              latestVersion: body.version,
              seenVersion: body.version,
              unread: false,
              unreadCount: 0,
            },
          },
        });
      },
    ],
    [
      '**/api/tasks',
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        if (body?.success && Array.isArray(body.data))
          body.data.push({ ...task, workChatConversationIds: [] });
        return route.fulfill({ response, json: body });
      },
    ],
    [`**/api/tasks/${encoded}/graph`, get({ task, links: [] })],
    [`**/api/tasks/${encoded}/children*`, get({ task: taskRef, children: [] })],
    [`**/api/tasks/${encoded}/work-chats*`, get({ task: taskRef, chats: [] })],
    [`**/api/tasks/${encoded}/outputs`, get([])],
    [`**/api/tasks/${encoded}/kept-pull-requests`, get([])],
    [`**/api/tasks/${encoded}/user-input-references`, get([])],
    [`**/api/tasks/${encoded}/turn-references`, get([])],
    [
      `**/api/tasks/${encoded}/room/memory`,
      get({
        version: 'station.task-memory/v1',
        taskId,
        records: [],
        limits: {
          summaryChars: 4000,
          recordTextChars: 1000,
          recordReasonChars: 500,
          recordKeyChars: 64,
          liveRecords: { decision: 40, question: 20, dead_end: 30 },
        },
      }),
    ],
    [
      `**/api/tasks/${encoded}/room`,
      get({
        kind: 'existing',
        scope: { projectId, taskId },
        channelId: `project-task:${digest}`,
        assurance: 'L0',
        capabilities: {
          historyRead: true,
          messageWrite: true,
          live: true,
          documentRead: true,
          documentWrite: true,
          revisionLinks: true,
        },
      }),
    ],
    [
      `**/api/tasks/${encoded}/room/document*`,
      get({ kind: 'snapshot', revision, text: '' }),
    ],
    [
      `**/api/tasks/${encoded}/room/live`,
      async (route) => {
        if (route.request().method() !== 'POST')
          return rejectUnexpectedFixtureRequest(route);
        // The Station's own route validates the body first, so a command it
        // would refuse is refused here with its 400 (#4810 gallery delta 2).
        const checked = await LIVE_COMMAND_ROUTE.request(
          `/${encoded}/room/live`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: route.request().postData() ?? '',
          },
        );
        if (checked.status === 400 || checked.status === 413)
          return route.fulfill({
            status: checked.status,
            json: await checked.json(),
          });
        // The Station answers a join with `joined` and other commands with
        // `updated`; the viewer is a published participant once joined.
        const command = route.request().postDataJSON()?.command;
        const result = { outcome: command === 'join' ? 'joined' : 'updated' };
        const snapshot = {
          ...live,
          participants: [
            {
              actor: {
                actorId: live.viewerActorId,
                kind: 'human',
                label: 'Maya Chen',
              },
              work: {
                sessionId: live.generation,
                workName: 'Project task work',
                workState: 'working',
                startedAt: Date.now(),
              },
              publication: 'published',
            },
            ...live.participants,
          ],
          result,
        };
        return route.fulfill({
          json: {
            success: true,
            data: {
              kind: 'available',
              generation: live.generation,
              viewerActorId: live.viewerActorId,
              result,
              snapshot,
            },
          },
        });
      },
    ],
    [`**/api/tasks/${encoded}/room/history*`, get(taskHistory(scene))],
    [
      `**/api/tasks/${encoded}/room/events*`,
      async (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        const snapshot = {
          type: 'snapshot',
          generation: live.generation,
          viewerActorId: live.viewerActorId,
          live,
          document: { kind: 'snapshot', revision, floor: revision, text: '' },
        };
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
        });
        await held;
      },
    ],
    [
      `**/api/tasks/${encoded}/room/agent-requests`,
      get({
        version: TASK_ROOM_WORK_VERSION,
        kind: 'available',
        records:
          scene === 'working'
            ? [
                {
                  version: TASK_ROOM_WORK_VERSION,
                  taskId,
                  projectId: projectUuid,
                  taskCreatedAt,
                  operationId: uuid(1, 'e1'),
                  requesterId: 'person:maya',
                  agentId: 'scout',
                  prompt: 'Run the onboarding checks on the latest build.',
                  sessionId: 'session-failed',
                  createdAt: at(2, 14, 1),
                  state: 'dispatched',
                },
              ]
            : [],
        contextVersion: 'station.task-room-context/v1',
        context: {
          version: 'station.task-room-context/v1',
          digest,
          title: task.title,
          description: '',
          documentRevision: `swsr-v2:${digest}`,
          text: '',
        },
      }),
    ],
    [
      `**/api/tasks/${encoded}/room/attachments/*`,
      (route) => {
        if (route.request().method() !== 'GET')
          return rejectUnexpectedFixtureRequest(route);
        return route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: IMAGE_PNG,
        });
      },
    ],
  ];
  for (const [pattern, handler] of handlers) await page.route(pattern, handler);
  return {
    taskId,
    async cleanup() {
      release?.();
      for (const [pattern, handler] of handlers)
        await page.unroute(pattern, handler);
    },
  };
}
