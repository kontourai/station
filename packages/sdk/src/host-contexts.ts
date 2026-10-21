/**
 * Contracts for the host context slots a plugin reaches through the SDK hooks
 * (`useAgents`, `useNavigation`, `useToast`, `useAuth`, `useHost`,
 * `useHostFacts`, `useShortcut`, `useShortcutScope`).
 *
 * The host injects these through `SDKProvider`. Until #2399 the slots were
 * typed `any`, so a plugin misusing one type-checked and the only statement of
 * the contract was the host adapter's source. These interfaces are that
 * statement; the host adapter implements them and is type-checked against
 * them.
 */
import type { AuthStatus } from '@kontourai/station-contracts/auth';
import type { ShortcutBinding } from '@kontourai/station-contracts/device-settings';
import type {
  PaneConfirmDecision,
  PaneConfirmRequest,
  PaneHostFacts,
} from '@kontourai/station-contracts/workspace-pane-host-contract';
import type { AgentSummary } from './types';

/** The four toast tones Station renders. */
export type ToastType = 'info' | 'success' | 'warning' | 'error';

/** A button rendered on a toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
}

/** The object form of {@link SDKToast.showToast}. */
export interface ToastRequest {
  message: string;
  type?: ToastType;
  /** Milliseconds before the toast dismisses itself. */
  duration?: number;
  /** One button rendered on the toast. */
  action?: ToastAction;
  /** Several buttons, in order. Rendered after `action` when both are set. */
  actions?: ToastAction[];
}

/** What `useToast()` returns. */
export interface SDKToast {
  /**
   * Shows a toast and returns its id. Both spellings are supported:
   * `showToast('Saved', 'success')` and
   * `showToast({ message: 'Saved', type: 'success' })`.
   */
  showToast: {
    (message: string, type?: ToastType, duration?: number): string;
    (request: ToastRequest): string;
  };
  /** Dismisses a toast by the id `showToast` returned. */
  dismissToast: (id: string) => void;
}

/** What `useNavigation()` returns: the navigation a plugin may read and drive. */
export interface SDKNavigation {
  pathname: string;
  selectedAgent: string | null;
  selectedProject: string | null;
  selectedProjectLayout: string | null;
  activeConversation: string | null;
  activeChat: string | null;
  activeTab: string | null;
  isDockOpen: boolean;
  isDockMaximized: boolean;
  navigate: (pathname: string, params?: Record<string, string | null>) => void;
  setProject: (slug: string) => void;
  setLayout: (projectSlug: string, layoutSlug: string) => void;
  setLayoutTab: (layoutSlug: string, tabId: string | null) => void;
  setConversation: (id: string | null) => void;
  setActiveChat: (id: string | null) => void;
  setDockState: (open: boolean, maximized?: boolean) => void;
}

/** The signed-in person, when the auth provider knows one. */
export interface SDKAuthUser {
  alias: string;
  name?: string;
  title?: string;
  email?: string;
  profileUrl?: string;
}

/** What `useAuth()` returns. */
export interface SDKAuthState {
  /** `loading` until the host's first auth read answers. */
  status: AuthStatus['status'] | 'loading';
  user: SDKAuthUser | null;
  expiresAt: Date | null;
  provider: string;
  renew: () => Promise<void>;
  isRenewing: boolean;
}

/** The `agents` slot of the SDK context. */
export interface SDKAgentsContext {
  useAgents: () => AgentSummary[];
}

/** The `navigation` slot of the SDK context. */
export interface SDKNavigationContext {
  useNavigation: () => SDKNavigation;
}

/** The `toast` slot of the SDK context. */
export interface SDKToastContext {
  useToast: () => SDKToast;
}

/** The `auth` slot of the SDK context. */
export interface SDKAuthContext {
  useAuth: () => SDKAuthState;
}

/** A text prompt the HOST renders with its own dialog chrome. Plain data. */
export interface SDKPromptRequest {
  title: string;
  /** Shown above the input. */
  label?: string;
  /** Pre-filled value, e.g. the current name when renaming. */
  initial?: string;
}

/**
 * What `useHost()` returns: requests the host carries out with its own chrome
 * and platform plumbing. None of these promises rejects; each resolves with
 * the outcome.
 */
export interface SDKHost {
  clipboard: {
    /**
     * Writes text to the clipboard. `true` only when the platform write
     * itself succeeded; a missing clipboard (plain `http://`) or a refusal is
     * `false`.
     */
    writeText: (text: string) => Promise<boolean>;
  };
  /**
   * Opens an `http:` or `https:` URL outside Station: the native app's
   * opener, or a new browser tab. Any other scheme is refused (`false`) and
   * the host tells the user, offering the link to copy.
   */
  openExternal: (url: string) => Promise<boolean>;
  /**
   * Asks for one line of text in the host's dialog. Resolves the trimmed
   * text, or `null` when cancelled, superseded by a newer prompt, or
   * outlived by the pane. Empty text cannot be submitted.
   */
  prompt: (request: SDKPromptRequest) => Promise<string | null>;
  /** The host's confirm dialog, with the pane-host contract's semantics. */
  confirm: (request: PaneConfirmRequest) => Promise<PaneConfirmDecision>;
}

/**
 * The `host` slot of the SDK context. `facts` is the pane-host contract's
 * subscribable member, so the SDK and the pane contract share one derivation.
 */
export interface SDKHostContext {
  useHost: () => SDKHost;
  facts: {
    read: () => PaneHostFacts;
    subscribe: (listener: (facts: PaneHostFacts) => void) => () => void;
  };
}

/** Host-owned context keys a plugin shortcut's `when` may read. */
export type SDKShortcutHostContextKey =
  | 'composerFocused'
  | 'terminalFocused'
  | 'dialogOpen'
  | 'dockFocused';

/**
 * When a shortcut may fire. A string is a host context key above or the name
 * of one of this plugin's own scopes (`useShortcutScope`).
 */
export type SDKShortcutWhen =
  | SDKShortcutHostContextKey
  | (string & {})
  | { not: SDKShortcutWhen }
  | { and: SDKShortcutWhen[] }
  | { or: SDKShortcutWhen[] };

/** A shortcut a plugin registers with `useShortcut`. */
export interface SDKShortcut {
  /** Unique within the plugin: letters, digits, `-` and `_`, at most 64. */
  id: string;
  /** `cmd` is Command on a Mac and Control elsewhere. */
  keys: ShortcutBinding;
  /** Shown in the host's shortcut list and Settings. */
  description: string;
  when?: SDKShortcutWhen;
  /**
   * Return `false` when there was nothing to do: the key is then left for
   * the next matching shortcut and the browser.
   */
  run: () => void | boolean;
  /** Defaults to true. A disabled shortcut is not registered. */
  enabled?: boolean;
}

/** Why the host refused a shortcut. */
export type SDKShortcutRefusalReason =
  /** This pane has no installed-plugin identity the host verified. */
  | 'unbound'
  /** A Station kernel chord or a text-editing chord (copy, paste, …). */
  | 'reserved'
  | 'invalid-id'
  | 'invalid-keys'
  | 'invalid-when';

export type SDKShortcutRegistration =
  | {
      ok: true;
      /** The id the host registry lists this shortcut under. */
      registryId: string;
    }
  | { ok: false; reason: SDKShortcutRefusalReason; message: string };

/** The `shortcuts` slot of the SDK context. */
export interface SDKShortcutsContext {
  /** Pure: whether `register` would accept this shortcut, and its registry id. */
  validate: (shortcut: Omit<SDKShortcut, 'run'>) => SDKShortcutRegistration;
  /** Registers an accepted shortcut; returns its unregister. A refused one registers nothing. */
  register: (shortcut: SDKShortcut) => () => void;
  /**
   * Turns on one of this plugin's scopes; returns the release. Throws for a
   * name that is not a valid scope name or is a host context key.
   */
  activateScope: (name: string) => () => void;
}
