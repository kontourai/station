/** One public bound for the content-free existing-setup import contract. */
export const SETUP_IMPORT_MAX_ITEMS = 32;
/** UUID preview ids plus the source filename/digest discriminator stay bounded. */
export const SETUP_IMPORT_MAX_SOURCE_ID_LENGTH = 600;
/** Skill names are a single path segment; keep the API and UI finite too. */
export const SETUP_IMPORT_MAX_TARGET_NAME_LENGTH = 128;
