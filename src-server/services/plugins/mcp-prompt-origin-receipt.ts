import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type {
  AgentMcpPromptOrigin,
  VerifiedMcpPromptOrigin,
} from '@kontourai/station-contracts/mcp-prompts';

const secret = randomBytes(32);
const lifetimeMs = 10 * 60 * 1000;

/** Binds the text and classification observed by this process to a prompt run. */
export function issueMcpPromptOrigin(
  serverId: string,
  name: string,
  text: string,
  untrusted: boolean,
): AgentMcpPromptOrigin {
  const payload = Buffer.from(
    JSON.stringify({
      serverId,
      name,
      textHash: createHash('sha256').update(text).digest('hex'),
      untrusted,
      expiresAt: Date.now() + lifetimeMs,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  return { serverId, name, receipt: `${payload}.${signature}` };
}

/** Rejects altered, expired, foreign-process or text-mismatched origins. */
export function verifyMcpPromptOrigin(
  origin: AgentMcpPromptOrigin,
  text: string,
): VerifiedMcpPromptOrigin {
  if (typeof origin.receipt !== 'string' || origin.receipt.length > 4096)
    throw new Error(
      'MCP prompt origin is invalid or expired; run the prompt again.',
    );
  const parts = origin.receipt.split('.');
  if (parts.length !== 2)
    throw new Error(
      'MCP prompt origin is invalid or expired; run the prompt again.',
    );
  const expected = createHmac('sha256', secret).update(parts[0]).digest();
  let signature: Buffer;
  try {
    signature = Buffer.from(parts[1], 'base64url');
  } catch {
    throw new Error(
      'MCP prompt origin is invalid or expired; run the prompt again.',
    );
  }
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  )
    throw new Error(
      'MCP prompt origin is invalid or expired; run the prompt again.',
    );
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new Error(
      'MCP prompt origin is invalid or expired; run the prompt again.',
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error(
      'MCP prompt origin is invalid or expired; run the prompt again.',
    );
  const value = payload as Record<string, unknown>;
  if (
    value.serverId !== origin.serverId ||
    value.name !== origin.name ||
    value.textHash !== createHash('sha256').update(text).digest('hex') ||
    typeof value.untrusted !== 'boolean' ||
    typeof value.expiresAt !== 'number' ||
    value.expiresAt < Date.now()
  )
    throw new Error(
      'MCP prompt origin is invalid or expired; run the prompt again.',
    );
  return {
    serverId: origin.serverId,
    name: origin.name,
    untrusted: value.untrusted,
  };
}
