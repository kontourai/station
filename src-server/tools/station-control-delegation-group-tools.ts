import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const root = '/api/orchestration/groups';
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const integer = z.number().int().nonnegative().safe();
const groupPath = (groupId: string) => `${root}/${encodeURIComponent(groupId)}`;
const memberPath = (groupId: string, seatId: string) =>
  `${groupPath(groupId)}/members/${encodeURIComponent(seatId)}`;
const get = async (url: string) => jsonToolResult(await api(url));
const post = async (url: string, body: unknown) =>
  jsonToolResult(
    await api(url, { method: 'POST', body: JSON.stringify(body) }),
  );
const command = {
  groupId: id,
  operationId: id,
  expectedRevision: integer.max(512),
};

/** The route owns current caller, source and execution admission, including replay. */
export function registerDelegationGroupTools(
  server: StationControlToolRegistry,
) {
  server.tool(
    'create_delegation_group',
    'Create a bounded caller-owned report group from current Project and Agent source admission. Creation does not launch members. Unsupported host or source protocols refuse.',
    {
      operationId: id,
      projectSlug: id,
      resourceId: id.optional(),
      flow: z
        .object({ runId: id, steps: z.record(id, id) })
        .strict()
        .optional(),
      deadlineAt: integer,
      maxConcurrent: z.number().int().min(1).max(16),
      budget: z
        .object({
          inputTokens: integer,
          outputTokens: integer,
          costMicros: integer,
        })
        .strict(),
      members: z
        .array(
          z
            .object({
              seatId: id,
              agentId: id,
              brief: z.string().min(1).max(65_536),
              maxOutputTokens: z.number().int().min(1).max(128_000),
            })
            .strict(),
        )
        .min(1)
        .max(16),
    },
    async (input) => post(root, input),
  );
  server.tool(
    'list_delegation_groups',
    'Read a bounded page of this caller’s groups. Use nextGroupId as afterGroupId for the next page.',
    { afterGroupId: id.optional() },
    async ({ afterGroupId }) =>
      get(
        afterGroupId === undefined
          ? root
          : `${root}?afterGroupId=${encodeURIComponent(afterGroupId)}`,
      ),
  );
  server.tool(
    'get_delegation_group',
    'Read the current owned group projection. Returned work and cancellation acknowledgement do not prove descendant termination or semantic acceptance.',
    { groupId: id },
    async ({ groupId }) => get(groupPath(groupId)),
  );
  server.tool(
    'get_delegation_group_events',
    'Read one bounded revision page for an owned group. Continue using nextRevision; private authority journals are not returned.',
    { groupId: id, afterRevision: integer.max(512).optional() },
    async ({ groupId, afterRevision }) =>
      get(`${groupPath(groupId)}/events?afterRevision=${afterRevision ?? 0}`),
  );
  server.tool(
    'run_delegation_group',
    'Run the currently admitted owned group under its reserved budget and source bindings. Missing or stale execution authority refuses before launch.',
    command,
    async ({ groupId, ...input }) => post(`${groupPath(groupId)}/run`, input),
  );
  server.tool(
    'cancel_delegation_group',
    'Revoke further group admission and request interrupts for current members. Unknown members remain pending; this does not assert termination.',
    command,
    async ({ groupId, ...input }) =>
      post(`${groupPath(groupId)}/cancel`, input),
  );
  server.tool(
    'get_delegation_group_member_events',
    'Read a bounded page for the exact owned member turn, including currently answerable input requests when available.',
    { groupId: id, seatId: id, afterSequence: integer.optional() },
    async ({ groupId, seatId, afterSequence }) =>
      get(
        `${memberPath(groupId, seatId)}/events?afterSequence=${afterSequence ?? 0}`,
      ),
  );
  server.tool(
    'get_delegation_group_member_output',
    'Read one bounded retained-output page. Continue with nextCodeUnit as afterCodeUnit. Usage describes the whole invocation; do not sum it across pages. Missing or uncertain output is unavailable.',
    { groupId: id, seatId: id, afterCodeUnit: integer.optional() },
    async ({ groupId, seatId, afterCodeUnit }) =>
      get(
        `${memberPath(groupId, seatId)}/output?afterCodeUnit=${afterCodeUnit ?? 0}`,
      ),
  );
}
