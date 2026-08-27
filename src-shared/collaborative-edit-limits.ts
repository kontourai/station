/** Shared admission limits for one #2889 editor operation batch. */
export const MAX_COLLABORATIVE_EDIT_OPERATION_BYTES = 256 * 1024;
/**
 * A maximum document can contain one 256-byte atom identity per UTF-16 code
 * unit.  Keep the batch bound above that actual worst-case representation;
 * individual operations are still kept small enough for ordinary transports.
 */
export const MAX_COLLABORATIVE_EDIT_BATCH_BYTES = 96 * 1024 * 1024;
export const MAX_COLLABORATIVE_EDIT_BATCH_OPERATIONS = Math.ceil(
  MAX_COLLABORATIVE_EDIT_BATCH_BYTES / MAX_COLLABORATIVE_EDIT_OPERATION_BYTES,
);
