/**
 * Sign-in for engines Station launches as local commands: what Station knows
 * about whether one is signed in, and the ways it can sign one in. Station
 * never reads, copies or hands on an engine's own credentials; an API key a
 * person enters is kept in Station's engine credential store and only its
 * variable name is ever served back.
 */

export type EngineSignInState = 'authenticated' | 'unauthenticated' | 'unknown';

/**
 * Where a sign-in state came from:
 * - `status-command`: the engine's documented status command, read by the
 *   rule its descriptor gives.
 * - `refusal`: the engine refused a chat because it needs a sign-in.
 * - `sign-in`: a sign-in Station started finished as the protocol defines
 *   success (`authenticate` answered, or the terminal login exited 0).
 * - `none`: nothing has been observed (`unknown`).
 */
export type EngineSignInSource =
  | 'status-command'
  | 'refusal'
  | 'sign-in'
  | 'none';

export interface EngineSignInStatus {
  state: EngineSignInState;
  source: EngineSignInSource;
  /** ISO time of the observation; absent for `none`. */
  observedAt?: string;
  /** The engine has a status command Station can run. */
  checkable: boolean;
}

/**
 * - `terminal`: the engine's own login, run on the Station host in a terminal.
 * - `agent`: the engine signs in itself when Station asks it to (it may open
 *   a browser on the host or print a link to follow).
 */
export type EngineSignInMethodKind = 'terminal' | 'agent';

export interface EngineSignInMethod {
  id: string;
  name: string;
  description?: string;
  kind: EngineSignInMethodKind;
  /** Set when the provider's terms may restrict this route in other tools. */
  termsNotice?: EngineSubscriptionTermsNotice;
}

export interface EngineSubscriptionTermsNotice {
  provider: string;
  termsUrl: string;
}

export interface EngineCredentialField {
  /** The environment variable name; never the value. */
  name: string;
  /** Station holds a value for it. */
  configured: boolean;
}

export type EngineSignInAttemptState =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

export interface EngineSignInAttempt {
  id: string;
  methodId: string;
  kind: EngineSignInMethodKind;
  state: EngineSignInAttemptState;
  startedAt: string;
  /** For `terminal`: the host terminal session to attach to while it runs. */
  terminal?: { projectSlug: string; terminalId: string };
  /** https links the engine printed while signing in. Never opened by Station. */
  links?: string[];
  /** A short, already-sanitized reason for `failed`. */
  message?: string;
}

export interface EngineSignInView {
  connectionId: string;
  engineName: string;
  status: EngineSignInStatus;
  signInHint?: string;
  /**
   * The methods the engine advertised in its most recent sign-in handshake,
   * minus the ones its descriptor hides. Absent until one has been read.
   */
  methods?: EngineSignInMethod[];
  /** ISO time of the handshake `methods` came from. */
  methodsObservedAt?: string;
  /** Why the most recent handshake could not be read, already sanitized. */
  methodsError?: string;
  credentials: EngineCredentialField[];
  /** A note that applies to the engine's sign-in as a whole. */
  termsNotice?: EngineSubscriptionTermsNotice;
  /** What this caller may do, decided by the server for this request. */
  allowed: {
    /** Start or cancel a sign-in, and set or clear a credential. */
    signIn: boolean;
    /** Run the engine's login in a terminal on the host. */
    terminal: boolean;
  };
}
