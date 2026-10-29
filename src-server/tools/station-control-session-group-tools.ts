import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const root = '/api/orchestration/session-groups';
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const target = z
  .object({
    agent: z.string().min(1).max(64),
    expectedEngine: z
      .object({
        kind: z.literal('connection'),
        connectionId: z.string().min(1).max(256),
      })
      .strict(),
    environment: z
      .object({ kind: z.literal('current') })
      .strict()
      .optional(),
    workspace: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('project'),
            projectSlug: z.string().min(1).max(512),
            cwd: z.string().min(1).max(4096).optional(),
          })
          .strict(),
        z
          .object({
            kind: z.literal('directory'),
            cwd: z.string().min(1).max(4096),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
const common = {
  operationId: id,
  maxConcurrent: z.number().int().min(1).max(32),
  maxDispatches: z.number().int().min(0).max(32).optional(),
  deadlineAt: z.number().int().positive().safe(),
};
const path = (groupId: string) => `${root}/${encodeURIComponent(groupId)}`;
const post = async (url: string, body: unknown) =>
  jsonToolResult(
    await api(url, { method: 'POST', body: JSON.stringify(body) }),
  );
const get = async (url: string) => jsonToolResult(await api(url));

export function registerSessionGroupTools(server: StationControlToolRegistry) {
  server.tool(
    'create_session_group',
    'Create a caller-owned session group; creation does not run it. Targets are current Station connections and remain subject to dispatch authorization.',
    {
      ...common,
      members: z
        .array(
          z
            .object({
              seatId: id,
              needs: z.array(id).max(32).optional(),
              prompt: z.string().trim().min(1).max(100_000),
              parentTaskId: z.string().min(1).max(512).optional(),
              target: target
                .extend({
                  model: z
                    .object({
                      override: z.string().min(1).max(512).optional(),
                      options: z.record(z.string(), z.unknown()).optional(),
                    })
                    .strict()
                    .optional(),
                })
                .strict(),
            })
            .strict(),
        )
        .min(1)
        .max(32),
    },
    async (input) => post(root, input),
  );
  server.tool(
    'create_session_group_from_ensemble',
    'Create a caller-owned session group from inline preset JSON and its expected SHA-256. Server file paths are not accepted.',
    {
      ...common,
      presetJson: z.string().min(1).max(131_072),
      expectedPresetHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      brief: z.string().min(1).max(100_000),
      bindings: z
        .record(
          z.string().min(1).max(64),
          z
            .object({
              target: target
                .extend({ workspace: target.shape.workspace.unwrap() })
                .strict(),
              needs: z.array(id).max(16),
            })
            .strict(),
        )
        .refine((value) => Object.keys(value).length <= 16),
    },
    async (input) => post(`${root}/from-ensemble`, input),
  );
  server.tool(
    'list_session_groups',
    'Read one bounded page of groups owned by this caller; pass nextGroupId as afterGroupId for the next page.',
    { afterGroupId: id.optional() },
    async ({ afterGroupId }) =>
      get(
        `${root}${afterGroupId ? `?afterGroupId=${encodeURIComponent(afterGroupId)}` : ''}`,
      ),
  );
  server.tool(
    'get_session_group',
    'Read a caller-owned group and its member state.',
    { groupId: id },
    async ({ groupId }) => get(path(groupId)),
  );
  server.tool(
    'get_session_group_events',
    'Read one bounded event page. Pass nextRevision as afterRevision to continue; this does not supervise or run the group.',
    {
      groupId: id,
      afterRevision: z.number().int().nonnegative().safe().optional(),
    },
    async ({ groupId, afterRevision }) =>
      get(
        `${path(groupId)}/events${afterRevision === undefined ? '' : `?afterRevision=${afterRevision}`}`,
      ),
  );
  server.tool(
    'run_session_group',
    'Supervise and run a caller-owned group under current dispatch authority. A refusal or interrupted call does not establish completion.',
    { groupId: id },
    async ({ groupId }) => post(`${path(groupId)}/run`, {}),
  );
  server.tool(
    'cancel_session_group',
    'Close admission and request interruption of confirmed running member turns.',
    { groupId: id },
    async ({ groupId }) => post(`${path(groupId)}/cancel`, {}),
  );
  server.tool(
    'sync_session_group',
    'Synchronize retained context to eligible members using a caller-owned operation and run identity.',
    {
      groupId: id,
      operationId: id,
      runId: id,
      content: z.string().min(1).max(131_072),
      deadlineAt: z.number().int().positive().safe(),
    },
    async ({ groupId, ...input }) => post(`${path(groupId)}/sync`, input),
  );
}
