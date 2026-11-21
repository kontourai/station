import { createContext } from 'react';

/**
 * True while the transcript on screen is this client's recent copy and its
 * re-read is in flight: a request it shows may already be answered elsewhere,
 * so no row offers an answer until the read lands. Rows then offer none at
 * all, rather than an answer that could only fail.
 */
export const ApprovalsHeldContext = createContext(false);
