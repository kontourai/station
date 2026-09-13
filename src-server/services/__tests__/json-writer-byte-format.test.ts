/**
 * The on-disk document format of stores whose hand-rolled temp+rename writer
 * was replaced by a shared durable seam.
 *
 * A store's existing file IS its format: re-indenting it, or adding a
 * trailing newline, rewrites every reader's bytes. Round-trip tests do not
 * see that -- `JSON.parse` accepts all of it -- so each store gets one
 * assertion on the exact published text, driven through its real public
 * entry point. Every assertion here was run GREEN against the hand-rolled
 * writer before the migration, so it records what the store already wrote
 * rather than what the seam happens to produce.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { HashChainedReceiptLog } from '../../runtime/conversation/receipt-chain.js';
import { DiscordGatewayConfigurationStore } from '../discord/discord-gateway-config-store.js';
import { DiscordTurnRelayStore } from '../discord/discord-turn-relay-store.js';
import { DistributionProfileService } from '../plugins/distribution-profile-service.js';
import { UsageTelemetryService } from '../usage-telemetry-service.js';
import { InboundWebhookConfigurationStore } from '../webhooks/inbound-webhook-store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'station-json-bytes-'));
  roots.push(root);
  return root;
}

/** Two-space JSON, no trailing newline. */
function indented(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

describe('published JSON document formats', () => {
  test('the Discord gateway configuration is two-space JSON with no trailing newline', () => {
    const root = home();
    const configuration = {
      schemaVersion: 1 as const,
      sessionBindings: [
        {
          guildId: 'guild-a',
          channelId: 'channel-a',
          sessionId: 'session-a',
          agentId: 'agent-a',
        },
      ],
    };

    new DiscordGatewayConfigurationStore(root).write(configuration);

    expect(
      readFileSync(join(root, 'security', 'discord-gateway.json'), 'utf8'),
    ).toBe(indented(configuration));
  });

  test('the Discord turn relay list is two-space JSON with no trailing newline', () => {
    const root = home();
    const relay = {
      turnId: 'turn-a',
      sessionId: 'session-a',
      discordUserId: 'user-a',
      guildId: 'guild-a',
      channelId: 'channel-a',
    };

    new DiscordTurnRelayStore(root).add(relay);

    expect(
      readFileSync(join(root, 'runtime', 'discord-turn-relays.json'), 'utf8'),
    ).toBe(indented([relay]));
  });

  test('the inbound webhook configuration is two-space JSON with no trailing newline', () => {
    const root = home();
    const configuration = {
      schemaVersion: 1 as const,
      enabled: true,
      tokens: [
        {
          id: 'token-a',
          name: 'Token A',
          secret: 'x'.repeat(48),
          starts: [{ agentId: 'agent-a' }],
        },
      ],
    };

    new InboundWebhookConfigurationStore(root).write(configuration);

    expect(
      readFileSync(join(root, 'security', 'inbound-webhooks.json'), 'utf8'),
    ).toBe(indented(configuration));
  });

  test('the distribution lifecycle overrides are two-space JSON with no trailing newline', () => {
    const root = home();
    const service = new DistributionProfileService(root);
    const builtin = service.listLayouts().find((l) => l.source === 'builtin');
    if (!builtin) throw new Error('fixture needs a built-in layout');

    service.installBuiltin(builtin.id);

    expect(
      readFileSync(join(root, 'config', 'distribution-lifecycle.json'), 'utf8'),
    ).toBe(
      indented({
        version: 1,
        items: { [builtin.id]: { installed: true, enabled: true } },
      }),
    );
  });

  test('the usage telemetry disclosure receipt is compact JSON with a trailing newline', async () => {
    const root = home();
    const service = new UsageTelemetryService({
      homeDir: root,
      appConfig: {} as never,
      version: '1.2.3',
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      } as never,
    });

    await service.acknowledgeDisclosure();

    const text = readFileSync(
      join(root, 'config', 'usage-telemetry-disclosure.json'),
      'utf8',
    );
    // The timestamp is minted inside the call, so the exact text is asserted
    // by re-serializing the parsed value in the same compact form: a change
    // of indent or a dropped newline still fails.
    expect(text).toBe(`${JSON.stringify(JSON.parse(text))}\n`);
    expect(text).not.toContain('\n  ');
  });

  test('the receipt chain anchor is compact JSON with a trailing newline', async () => {
    const root = home();
    const path = join(root, 'receipts.jsonl');
    const log = new HashChainedReceiptLog<{
      receiptId: string;
      previousReceiptId: string | null;
      kind: string;
    }>(path, root);

    const sealed = await log.append(
      { kind: 'observed' },
      (body, receiptId) => ({
        ...body,
        receiptId,
      }),
    );

    expect(readFileSync(`${path}.anchor.json`, 'utf8')).toBe(
      `${JSON.stringify({ lastReceiptId: sealed.receiptId, recordCount: 1 })}\n`,
    );
  });
});
