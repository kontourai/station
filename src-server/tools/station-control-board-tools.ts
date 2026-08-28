import {
  getBoard,
  moveBoardWidget,
  pinBoardWidget,
  unpinBoardWidget,
} from '@kontourai/station-sdk/client';
import { z } from 'zod';

import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  controlRequestOptions,
  jsonToolResult,
  resolveControlApiBase,
  toToolEnvelope as toBoardEnvelope,
} from './station-control-shared.js';

// archive#1195: resolved fresh on every call — see the matching note in
// station-control-operations-tools.ts.
function controlApiBase(): string {
  return resolveControlApiBase();
}

const referenceSchema = z.union([
  z.object({ kind: z.literal('session'), id: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('task'),
      id: z.string().min(1),
      projectId: z.string().min(1),
    })
    .strict(),
]);

const cardFieldSchema = z.object({ label: z.string(), value: z.string() });
const formFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(['text', 'textarea', 'select', 'checkbox']),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  options: z.array(z.string()).optional(),
});
const sourceRefSchema = z.record(z.string(), z.unknown());

/**
 * archive#4079: the block payload archive#1399's `render_component`
 * accepts, reused verbatim for `board_pin` — a pinned widget IS a
 * provenance-bound UI block. The provenance boundary itself
 * (`assertUIBlockProvenanceAccepted` via `acceptUIBlockProvenance`) runs
 * server-side in `routes/board.ts`, not here: this schema only shapes the
 * wire payload.
 */
const blockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('card'),
    title: z.string().optional(),
    body: z.string(),
    tone: z.enum(['default', 'success', 'warning', 'danger']).optional(),
    fields: z.array(cardFieldSchema).optional(),
    derivedFrom: z.array(sourceRefSchema).optional(),
    attestationState: z
      .enum(['attested', 'unattested', 'decorative'])
      .optional(),
  }),
  z.object({
    type: z.literal('table'),
    title: z.string().optional(),
    caption: z.string().optional(),
    columns: z.array(z.string()).min(1),
    rows: z.array(
      z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    ),
    derivedFrom: z.array(sourceRefSchema).optional(),
    attestationState: z
      .enum(['attested', 'unattested', 'decorative'])
      .optional(),
  }),
  z.object({
    type: z.literal('code'),
    title: z.string().optional(),
    caption: z.string().optional(),
    code: z.string(),
    language: z.string().optional(),
    derivedFrom: z.array(sourceRefSchema).optional(),
    attestationState: z
      .enum(['attested', 'unattested', 'decorative'])
      .optional(),
  }),
  z.object({
    type: z.literal('form'),
    title: z.string().optional(),
    description: z.string().optional(),
    submitLabel: z.string().optional(),
    fields: z.array(formFieldSchema).min(1),
    derivedFrom: z.array(sourceRefSchema).optional(),
    attestationState: z
      .enum(['attested', 'unattested', 'decorative'])
      .optional(),
  }),
]);

const sizeSchema = z.enum(['sm', 'md', 'lg', 'full']);

/**
 * archive#4079 — `board_pin`/`board_unpin`/`board_move`, the agent
 * verbs for the board face. Mirrors `station-control-operations-tools.ts`'s
 * registration pattern: each tool is a thin `z.object` shape over the
 * canonical `@kontourai/station-sdk/client` fetcher (`client/board.ts`),
 * which itself talks to `routes/board.ts` — the SAME HTTP boundary the UI
 * board face and the `board_*` MCP tools both go through, so "what pinning
 * does" is defined exactly once.
 */
export function registerBoardTools(server: StationControlToolRegistry) {
  server.tool(
    'board_pin',
    "Pin a provenance-bound UI block (card/table/code/form) onto a session or Task's board face. " +
      'A claiming block (a card with `fields`, or a table with `rows`) REQUIRES `block.derivedFrom` ' +
      '— the same rule `render_component` enforces — and is refused otherwise. A purely decorative ' +
      'block (prose body, code, or a form) pins freely. Use `after` (a widget name) to position it; ' +
      'never pixel coordinates.',
    {
      reference: referenceSchema.describe(
        'The board owner: { kind: "session", id } or { kind: "task", id, projectId }.',
      ),
      name: z
        .string()
        .min(1)
        .describe('Stable widget name, unique on this board.'),
      block: blockSchema,
      tabId: z
        .string()
        .optional()
        .describe(
          'Target tab id; defaults to the board\'s first tab, or a new "default" tab.',
        ),
      tabTitle: z
        .string()
        .optional()
        .describe('Title for a newly-created tab.'),
      size: sizeSchema
        .optional()
        .describe('Grid size preset. Defaults to "md".'),
      after: z
        .string()
        .optional()
        .describe(
          'Place after this widget name within the target tab; omitted appends to the end.',
        ),
    },
    async ({ reference, name, block, tabId, tabTitle, size, after }) =>
      jsonToolResult(
        await toBoardEnvelope(
          pinBoardWidget(
            controlApiBase(),
            { reference, name, block, tabId, tabTitle, size, after },
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'board_unpin',
    'Remove a widget from a board by its name.',
    {
      reference: referenceSchema,
      name: z.string().min(1),
    },
    async ({ reference, name }) =>
      jsonToolResult(
        await toBoardEnvelope(
          unpinBoardWidget(
            controlApiBase(),
            reference,
            name,
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'board_move',
    'Reposition a pinned widget: place it after another widget (by name), and/or move it into another tab. Never pixel coordinates.',
    {
      reference: referenceSchema,
      name: z.string().min(1),
      tabId: z.string().optional().describe('Move into this tab id.'),
      after: z
        .string()
        .optional()
        .describe(
          'Place after this widget name; omitted moves to the front of the tab.',
        ),
    },
    async ({ reference, name, tabId, after }) =>
      jsonToolResult(
        await toBoardEnvelope(
          moveBoardWidget(
            controlApiBase(),
            { reference, name, tabId, after },
            controlRequestOptions(),
          ),
        ),
      ),
  );

  server.tool(
    'board_read',
    "Read a session or Task's board face — its tabs and pinned widgets, with their attestation state.",
    { reference: referenceSchema },
    async ({ reference }) =>
      jsonToolResult(
        await toBoardEnvelope(
          getBoard(controlApiBase(), reference, controlRequestOptions()),
        ),
      ),
  );
}
