/**
 * OAuth Auth Provider — cookie/token-based auth status.
 *
 * Demonstrates the auth provider pattern: check status, renew, and
 * prerequisite checks — the surface IAuthProvider actually declares.
 */
import type { AuthStatus, Prerequisite } from '@kontourai/station-shared';
export default function createOAuthAuthProvider(): {
  getStatus(): Promise<AuthStatus>;
  renew(): Promise<{
    success: boolean;
    message: string;
  }>;
  getPrerequisites(): Promise<Prerequisite[]>;
};
