import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { EngineAccountLogin } from '@kontourai/station-contracts/engine-accounts';
import { augmentedSpawnEnv } from '../../providers/auth/cli-auth.js';
import { enrolmentHomeEnv, verifyEnrolment } from './credential-enrolment.js';
import {
  engineLoginCapabilities,
  mechanismEvidence,
} from './engine-login-capabilities.js';

interface Session {
  record: EngineAccountLogin;
  child?: ChildProcessWithoutNullStreams;
  output: string;
  timer?: ReturnType<typeof setTimeout>;
  submitted: boolean;
}
export interface BrowserCodeLoginDeps {
  env: () => Promise<NodeJS.ProcessEnv>;
  spawn: (
    command: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      windowsHide: boolean;
      stdio: ['pipe', 'pipe', 'pipe'];
    },
  ) => ChildProcessWithoutNullStreams;
  verify: typeof verifyEnrolment;
  capabilities: typeof engineLoginCapabilities;
}

/** Claude owns PKCE, code exchange and credential storage; Station relays its prompt. */
export class BrowserCodeLoginManager {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, symbol>();
  private closed = false;
  constructor(
    private readonly deps: BrowserCodeLoginDeps = {
      env: augmentedSpawnEnv,
      spawn,
      verify: verifyEnrolment,
      capabilities: engineLoginCapabilities,
    },
  ) {}
  get(dir: string) {
    return this.sessions.get(dir)?.record;
  }
  cancel(dir: string) {
    const session = this.sessions.get(dir);
    if (session && this.live(session)) this.finish(session, 'cancelled');
    this.pending.delete(dir);
    return session?.record;
  }
  close() {
    this.closed = true;
    this.pending.clear();
    for (const session of this.sessions.values())
      if (this.live(session)) this.finish(session, 'cancelled');
  }
  private live(session: Session) {
    return ['starting', 'awaiting-code', 'verifying'].includes(
      session.record.phase,
    );
  }
  private finish(
    session: Session,
    phase: 'failed' | 'cancelled' | 'completed',
    reason?: string,
  ) {
    if (!this.live(session)) return;
    if (session.timer) clearTimeout(session.timer);
    session.record = {
      ...session.record,
      phase,
      ...(reason ? { reason } : {}),
    };
    session.output = '';
    if (phase !== 'completed' && session.child) {
      session.child.kill('SIGTERM');
      const child = session.child;
      const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
      kill.unref();
      child.once('exit', () => clearTimeout(kill));
    }
  }
  async start(dir: string, current: () => boolean) {
    for (const [key, session] of this.sessions) {
      if (
        !this.live(session) &&
        Date.parse(session.record.expiresAt) < Date.now() - 600000
      )
        this.sessions.delete(key);
    }
    const existing = this.sessions.get(dir);
    if (existing && this.live(existing)) return existing.record;
    if (
      this.closed ||
      this.pending.has(dir) ||
      this.pending.size +
        [...this.sessions.values()].filter((s) => this.live(s)).length >=
        4
    )
      throw new Error('Another sign-in is starting. Try again shortly.');
    const pending = Symbol(dir);
    this.pending.set(dir, pending);
    try {
      const supported = mechanismEvidence(
        await this.deps.capabilities('claude'),
        'browser-code',
      );
      if (!supported?.argument)
        throw new Error(
          'This Claude installation does not offer browser sign-in.',
        );
      const auth = await this.deps.verify('claude', dir);
      if (auth.state !== 'unauthenticated')
        throw new Error(
          auth.state === 'authenticated'
            ? 'This account is already signed in.'
            : 'Check this account’s sign-in status before trying again.',
        );
      const env = await this.deps.env();
      if (!current() || this.pending.get(dir) !== pending || this.closed)
        throw new Error('Sign-in access changed.');
      const now = new Date();
      const session: Session = {
        record: {
          engine: 'claude',
          mechanism: 'browser-code',
          phase: 'starting',
          startedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 15 * 60000).toISOString(),
        },
        output: '',
        submitted: false,
      };
      this.sessions.set(dir, session);
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.deps.spawn(
          'claude',
          ['auth', 'login', supported.argument],
          {
            env: {
              ...env,
              ...enrolmentHomeEnv('claude', dir),
              BROWSER: process.platform === 'win32' ? 'cmd /c echo' : 'true',
            },
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
      } catch {
        this.finish(session, 'failed', 'Claude could not start sign-in.');
        return session.record;
      }
      session.child = child;
      // Writable failures emit an error event even when the write callback handles them.
      child.stdin.on('error', () =>
        this.finish(
          session,
          'failed',
          'The code could not reach Claude. Check sign-in status before trying again.',
        ),
      );
      session.timer = setTimeout(
        () => this.finish(session, 'failed', 'Sign-in expired. Start again.'),
        15 * 60000,
      );
      session.timer.unref();
      const promptTimer = setTimeout(() => {
        if (session.record.phase === 'starting')
          this.finish(
            session,
            'failed',
            'Claude did not provide a sign-in link. Check its installation and try again.',
          );
      }, 90000);
      promptTimer.unref();
      const output = (chunk: Buffer) => {
        if (!this.live(session) || session.submitted) return;
        session.output += chunk
          .toString('utf8')
          .replace(
            new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'),
            '',
          );
        if (session.output.length > 65536) {
          this.finish(
            session,
            'failed',
            'Claude returned an unexpected sign-in response.',
          );
          return;
        }
        for (const match of session.output.matchAll(
          new RegExp(`https://[^\\s${String.fromCharCode(27)}]+`, 'g'),
        )) {
          try {
            const url = new URL(match[0]);
            if (
              ![
                'claude.com',
                'claude.ai',
                'platform.claude.com',
                'console.anthropic.com',
              ].includes(url.hostname) ||
              url.username ||
              url.password ||
              !url.searchParams.has('code_challenge') ||
              !url.searchParams.has('state')
            )
              continue;
            if (/paste code here/i.test(session.output))
              session.record = {
                ...session.record,
                phase: 'awaiting-code',
                verificationUri: url.href,
              };
          } catch {
            /* Incomplete stream URL; wait for the next chunk. */
          }
        }
      };
      child.stdout.on('data', output);
      child.stderr.on('data', output);
      child.on('error', () =>
        this.finish(session, 'failed', 'Claude could not start sign-in.'),
      );
      child.on('exit', async (code) => {
        clearTimeout(promptTimer);
        if (!this.live(session)) return;
        session.record = { ...session.record, phase: 'verifying' };
        try {
          const verified = await this.deps.verify('claude', dir);
          this.finish(
            session,
            code === 0 && verified.state === 'authenticated'
              ? 'completed'
              : 'failed',
            code === 0 && verified.state === 'authenticated'
              ? undefined
              : 'Sign-in did not complete. Start again.',
          );
        } catch {
          this.finish(
            session,
            'failed',
            'Could not confirm sign-in. Check the account before trying again.',
          );
        }
      });
      return session.record;
    } finally {
      if (this.pending.get(dir) === pending) this.pending.delete(dir);
    }
  }
  submit(dir: string, code: string, current: () => boolean) {
    const session = this.sessions.get(dir);
    if (
      !current() ||
      !session ||
      session.record.phase !== 'awaiting-code' ||
      session.submitted ||
      !session.child
    )
      throw new Error('This sign-in is no longer accepting a code.');
    if (!/^[A-Za-z0-9._~#+/=-]{1,2048}$/.test(code))
      throw new Error('Paste the code shown by Claude.');
    session.submitted = true;
    session.record = { ...session.record, phase: 'verifying' };
    session.child.stdin.write(`${code}\n`, (error) => {
      if (error)
        this.finish(
          session,
          'failed',
          'The code could not reach Claude. Check sign-in status before trying again.',
        );
    });
    return session.record;
  }
}
let manager: BrowserCodeLoginManager | undefined;
export function browserCodeLoginManager() {
  if (!manager) manager = new BrowserCodeLoginManager();
  return manager;
}
export function closeBrowserCodeLogins() {
  manager?.close();
}
