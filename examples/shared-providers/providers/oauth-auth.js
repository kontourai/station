/**
 * OAuth Auth Provider — cookie/token-based auth status.
 *
 * Demonstrates the auth provider pattern: check status, renew, and
 * prerequisite checks — the surface IAuthProvider actually declares.
 */
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_PATH = join(homedir(), '.config', 'enterprise-auth', 'token.json');
const EXPIRING_THRESHOLD_MS = 30 * 60 * 1000;
function checkCommand(cmd) {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${which} ${cmd}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 'installed';
  } catch {
    return 'missing';
  }
}
export default function createOAuthAuthProvider() {
  return {
    async getStatus() {
      try {
        const raw = await readFile(TOKEN_PATH, 'utf-8');
        const token = JSON.parse(raw);
        if (!token.expiresAt) {
          return {
            provider: 'oauth',
            status: 'missing',
            expiresAt: null,
            message: 'No authentication found',
          };
        }
        const now = Date.now();
        const expiresAt = new Date(token.expiresAt);
        const remaining = expiresAt.getTime() - now;
        let status;
        let message;
        if (remaining <= 0) {
          status = 'expired';
          message = 'Authentication expired';
        } else if (remaining < EXPIRING_THRESHOLD_MS) {
          status = 'expiring';
          message = `Expires in ${Math.round(remaining / (60 * 1000))} minutes`;
        } else {
          status = 'valid';
          message = 'Authentication valid';
        }
        return {
          provider: 'oauth',
          status,
          expiresAt: expiresAt.toISOString(),
          message,
        };
      } catch {
        return {
          provider: 'oauth',
          status: 'missing',
          expiresAt: null,
          message: 'No authentication found',
        };
      }
    },
    async renew() {
      return { success: true, message: 'Use interactive auth' };
    },
    async getPrerequisites() {
      return [
        {
          id: 'enterprise-auth',
          name: 'Enterprise Auth CLI',
          description: 'Required for SSO authentication',
          status: checkCommand('enterprise-auth'),
          category: 'required',
          installGuide: {
            steps: [
              'Install via your package manager',
              'Authenticate: enterprise-auth login',
            ],
            commands: [
              'npm install -g enterprise-auth-cli',
              'enterprise-auth login',
            ],
          },
        },
      ];
    },
  };
}
