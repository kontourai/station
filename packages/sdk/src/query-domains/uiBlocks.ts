import {
  isUIBlockDataBearing,
  normalizeUIBlockSourceRefs,
  parseUIBlockSourceRefs,
  type UIBlock,
  type UIFormField,
} from '@kontourai/station-contracts/ui-block';

type UIBlockCarrier = {
  uiBlock?: unknown;
  uiBlocks?: unknown;
};

/**
 * Extract structured UIBlocks from a tool result `output`, used by EVERY path
 * that turns tool results into chat content parts (the managed + orchestration
 * streaming handlers and the conversation-load mapper). Keeping a single
 * implementation here is what stops a `render_component` form/card/table from
 * rendering live but vanishing on reload.
 *
 * Two output shapes are normalized:
 *  - streaming: `{ uiBlock }` / `{ uiBlocks }` (the payload directly)
 *  - persisted: `{ type: 'json', value: { uiBlock } }` (AI-SDK json wrapper)
 */
export function extractUIBlocks(output: unknown): UIBlock[] {
  if (!output || typeof output !== 'object') {
    return [];
  }

  const root = output as { type?: unknown; value?: unknown };
  const carrier = (
    root.type === 'json' && root.value && typeof root.value === 'object'
      ? root.value
      : output
  ) as UIBlockCarrier;

  const candidates = [
    ...(carrier.uiBlock ? [carrier.uiBlock] : []),
    ...(Array.isArray(carrier.uiBlocks) ? carrier.uiBlocks : []),
  ];

  return candidates
    .map(normalizeUIBlock)
    .filter((block): block is UIBlock => block !== null);
}

/**
 * Host-owned provenance stamping for the PASSIVE extraction path
 * (station#1399 slice 1, tightened in the fix round after independent
 * review finding H1). Unlike `render_component`'s synchronous
 * `acceptUIBlockProvenance` (`src-server/runtime/tools/vended-tool-compat.ts`),
 * this path has no tool call to refuse — the tool already ran and returned
 * this output, however it was shaped (any tool, not only `render_component`;
 * `tests/ui-blocks.spec.ts`'s `render_summary` fixture is exactly this
 * case). So a data-bearing block with no `derivedFrom` is never dropped
 * here — it is stamped `unattested` and still rendered, which is what
 * keeps "unattested" from being a quiet default (design comment).
 *
 * **H1 — this function must never MINT `'attested'`.** The original slice-1
 * version derived `'attested'` from mere source PRESENCE (any `derivedFrom`
 * array, however fabricated) and passed through a raw `provenanceDigest`
 * string verbatim with no check that it was a real hash of anything —
 * proven live: an arbitrary `'aaa...'` string survived as the displayed
 * digest for a block from a tool this module has no way to trust. The fix,
 * per the review's ruling, is that `'attested'` may be minted ONLY where
 * the host itself computes the digest — which now happens exactly once,
 * server-side, at the ONE seam every tool-emitted ui-block passes through
 * before persistence or delivery (`OrchestrationService#publishCanonicalEvent`
 * → `sanitizeUIBlockEventProvenance`, `src-server/runtime/conversation/ui-block-provenance.ts`).
 * By the time `output` reaches this browser-side function, a genuinely
 * `'attested'` block's `attestationState`/`provenanceDigest` were already
 * stamped by that trusted seam.
 *
 * So this function MIRRORS rather than derives: it never independently
 * promotes a block to `'attested'` — it only ever REPRODUCES an `'attested'`
 * claim that arrived on the wire, and only when the block's own structure
 * doesn't contradict it (data-bearing with a non-empty `derivedFrom`). Any
 * inconsistency — no sources, a non-`'attested'` claim, or a self-declared
 * `'decorative'`/`'unattested'` on data-bearing fields — downgrades to
 * `'unattested'`. It never upgrades. This is a defense-in-depth backstop,
 * not the primary control: a bypass of the server seam could still forge
 * `attestationState: 'attested'` in raw output, which this function would
 * mirror — the primary control is the server seam sanitizing unconditionally
 * before this code ever runs.
 */
function finalizeUIBlockProvenance<T extends UIBlock>(
  block: T,
  raw: Record<string, unknown>,
): T {
  if (!isUIBlockDataBearing(block)) {
    return { ...block, attestationState: 'decorative' };
  }
  const normalized = normalizeUIBlockSourceRefs(
    parseUIBlockSourceRefs(raw.derivedFrom),
  );
  const hasSources = normalized.length > 0;
  // Mirror-only: 'attested' survives ONLY if the wire already claimed it
  // AND the structure doesn't contradict that claim. Any other wire value
  // (including a self-declared 'decorative'/'unattested' on data that DOES
  // have sources — the reverse-override case, M6) downgrades.
  const mirroredAttested = raw.attestationState === 'attested' && hasSources;
  return {
    ...block,
    derivedFrom: hasSources ? normalized : undefined,
    // The digest rides ALONGSIDE a mirrored 'attested' claim only — a
    // digest without an attested state, or attached to a state this
    // function downgraded, is never displayed as if it were checked.
    provenanceDigest:
      mirroredAttested && typeof raw.provenanceDigest === 'string'
        ? raw.provenanceDigest
        : undefined,
    attestationState: mirroredAttested ? 'attested' : 'unattested',
  };
}

/**
 * Re-applies the same mirror-only provenance check to an ALREADY-TYPED
 * `UIBlock` that arrived by a path other than `extractUIBlocks` — station#1399
 * fix round, M4 (independent review): `chatRuntimeStream.ts`'s
 * `mapConversationMessages` has a second branch for a message part
 * PERSISTED as `type: 'ui-block'` directly (the memory/`FileMemory`
 * conversation store's own write shape, distinct from the SQLite event-store
 * path `sanitizeUIBlockEventProvenance` covers server-side) — that branch
 * used to return the stored block VERBATIM, so a block whose provenance was
 * never sanitized by any seam could reach the renderer unchecked. Passing
 * the block back through the SAME mirror logic used for raw tool output
 * (treating the block's own fields as "the wire data") closes that without
 * a second, divergent implementation.
 */
export function resanitizeUIBlockProvenance(block: UIBlock): UIBlock {
  return finalizeUIBlockProvenance(
    block,
    block as unknown as Record<string, unknown>,
  );
}

function normalizeUIBlock(value: unknown): UIBlock | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const block = value as Record<string, unknown>;
  if (block.type === 'card' && typeof block.body === 'string') {
    return finalizeUIBlockProvenance(
      {
        type: 'card',
        id: typeof block.id === 'string' ? block.id : undefined,
        title: typeof block.title === 'string' ? block.title : undefined,
        body: block.body,
        tone: normalizeTone(block.tone),
        fields: Array.isArray(block.fields)
          ? block.fields
              .map((field) =>
                field &&
                typeof field === 'object' &&
                typeof (field as Record<string, unknown>).label === 'string' &&
                typeof (field as Record<string, unknown>).value === 'string'
                  ? {
                      label: (field as Record<string, unknown>).label as string,
                      value: (field as Record<string, unknown>).value as string,
                    }
                  : null,
              )
              .filter(
                (field): field is { label: string; value: string } =>
                  field !== null,
              )
          : undefined,
      },
      block,
    );
  }

  if (
    block.type === 'table' &&
    Array.isArray(block.columns) &&
    Array.isArray(block.rows)
  ) {
    const columns = block.columns.filter(
      (column): column is string => typeof column === 'string',
    );
    const rows = block.rows
      .map((row) =>
        Array.isArray(row)
          ? row.map((cell) =>
              typeof cell === 'string' ||
              typeof cell === 'number' ||
              typeof cell === 'boolean' ||
              cell === null
                ? cell
                : String(cell),
            )
          : null,
      )
      .filter(
        (row): row is Array<string | number | boolean | null> => row !== null,
      );

    if (columns.length === 0) {
      return null;
    }

    return finalizeUIBlockProvenance(
      {
        type: 'table',
        id: typeof block.id === 'string' ? block.id : undefined,
        title: typeof block.title === 'string' ? block.title : undefined,
        caption: typeof block.caption === 'string' ? block.caption : undefined,
        columns,
        rows,
      },
      block,
    );
  }

  if (block.type === 'code' && typeof block.code === 'string') {
    return finalizeUIBlockProvenance(
      {
        type: 'code',
        id: typeof block.id === 'string' ? block.id : undefined,
        title: typeof block.title === 'string' ? block.title : undefined,
        caption: typeof block.caption === 'string' ? block.caption : undefined,
        language:
          typeof block.language === 'string' ? block.language : undefined,
        code: block.code,
      },
      block,
    );
  }

  if (block.type === 'form' && Array.isArray(block.fields)) {
    const fields = block.fields
      .map(normalizeFormField)
      .filter((field): field is UIFormField => field !== null);
    if (fields.length === 0) {
      return null;
    }
    return finalizeUIBlockProvenance(
      {
        type: 'form',
        id: typeof block.id === 'string' ? block.id : undefined,
        title: typeof block.title === 'string' ? block.title : undefined,
        description:
          typeof block.description === 'string' ? block.description : undefined,
        submitLabel:
          typeof block.submitLabel === 'string' ? block.submitLabel : undefined,
        fields,
      },
      block,
    );
  }

  return null;
}

const FORM_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text',
  'textarea',
  'select',
  'checkbox',
]);

function normalizeFormField(value: unknown): UIFormField | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const field = value as Record<string, unknown>;
  if (
    typeof field.name !== 'string' ||
    typeof field.label !== 'string' ||
    typeof field.type !== 'string' ||
    !FORM_FIELD_TYPES.has(field.type)
  ) {
    return null;
  }
  return {
    name: field.name,
    label: field.label,
    type: field.type as UIFormField['type'],
    required: field.required === true ? true : undefined,
    placeholder:
      typeof field.placeholder === 'string' ? field.placeholder : undefined,
    defaultValue:
      typeof field.defaultValue === 'string' ? field.defaultValue : undefined,
    options:
      field.type === 'select' && Array.isArray(field.options)
        ? field.options.filter((o): o is string => typeof o === 'string')
        : undefined,
  };
}

function normalizeTone(
  tone: unknown,
): 'default' | 'success' | 'warning' | 'danger' | undefined {
  return tone === 'success' ||
    tone === 'warning' ||
    tone === 'danger' ||
    tone === 'default'
    ? tone
    : undefined;
}
