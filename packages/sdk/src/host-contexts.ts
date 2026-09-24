/**
 * Contracts for the host context slots a plugin reaches through the SDK hooks
 * (`useAgents`, `useNavigation`, `useToast`, `useAuth`).
 *
 * The host injects these through `SDKProvider`. Until #2399 the slots were
 * typed `any`, so a plugin misusing one type-checked and the only statement of
 * the contract was the host adapter's source. These interfaces are that
 * statement; the host adapter implements them and is type-checked against
 * them.
 */
import type { AuthStatus } from '@kontourai/station-contracts/auth';
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
