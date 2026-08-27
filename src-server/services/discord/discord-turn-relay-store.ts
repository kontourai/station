import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface DiscordTurnRelay {
  turnId: string;
  sessionId: string;
  discordUserId: string;
  guildId: string;
  channelId: string;
}

const FILE_NAME = 'discord-turn-relays.json';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRelay(value: unknown): value is DiscordTurnRelay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const relay = value as Record<string, unknown>;
  return (
    isNonEmptyString(relay.turnId) &&
    isNonEmptyString(relay.sessionId) &&
    isNonEmptyString(relay.discordUserId) &&
    isNonEmptyString(relay.guildId) &&
    isNonEmptyString(relay.channelId)
  );
}

export function discordTurnRelayPath(homeDir: string): string {
  return join(homeDir, 'runtime', FILE_NAME);
}

/**
 * Pending relay facts are owned by Station and persisted before the Gateway
 * waits for the terminal orchestration event. This survives reconnect and
 * restart; it is not a Discord-side transcript or channel-to-session map.
 */
export class DiscordTurnRelayStore {
  constructor(private readonly homeDir: string) {}

  list(): DiscordTurnRelay[] {
    const path = discordTurnRelayPath(this.homeDir);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(isRelay)) return [];
      return structuredClone(parsed);
    } catch {
      return [];
    }
  }

  hasSession(sessionId: string): boolean {
    return this.list().some((relay) => relay.sessionId === sessionId);
  }

  findByTurnId(turnId: string): DiscordTurnRelay | undefined {
    return this.list().find((relay) => relay.turnId === turnId);
  }

  add(relay: DiscordTurnRelay): void {
    const relays = this.list();
    if (relays.some((entry) => entry.turnId === relay.turnId)) return;
    this.write([...relays, relay]);
  }

  remove(turnId: string): void {
    const relays = this.list();
    this.write(relays.filter((relay) => relay.turnId !== turnId));
  }

  private write(relays: DiscordTurnRelay[]): void {
    const path = discordTurnRelayPath(this.homeDir);
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(relays, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'w',
      });
      renameSync(temporaryPath, path);
      chmodSync(path, 0o600);
    } finally {
      if (existsSync(temporaryPath)) {
        try {
          rmSync(temporaryPath, { force: true });
        } catch {
          // The preceding write error remains authoritative.
        }
      }
    }
  }
}
