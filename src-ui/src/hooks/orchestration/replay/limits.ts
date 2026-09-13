/** Shared limits for capture, import and archive retention. */
export const MAX_TAPE_BYTES = 16 * 1024 * 1024;
export const MAX_TAPE_FRAMES = 20_000;

/** Allows a terminal coverage explanation without exceeding the file ceiling. */
export const TAPE_METADATA_RESERVE = 1024;
