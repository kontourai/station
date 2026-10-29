#!/usr/bin/env node

import {
  headers,
  optionValue,
  optionValues,
  readCredential,
} from './lib/agent-smoke-client.mjs';

if (process.argv.includes('--matrix')) {
  const { main } = await import('./station-engine-matrix.mjs');
  await main();
} else {
  const confirmed = process.argv.includes('--confirm-billable-one-turn');
  if (!confirmed) {
    console.error(
      'Refusing to send chat. Re-run with --confirm-billable-one-turn; each selected connection receives exactly one bounded smoke turn.',
    );
    process.exit(2);
  }

  const origin = (optionValue('origin') ?? 'http://127.0.0.1:3000').replace(
    /\/$/,
    '',
  );
  const timeoutMs = Math.max(
    5_000,
    Math.min(Number(optionValue('timeout-ms') ?? 45_000), 60_000),
  );
  const credential = await readCredential();
  const inventoryResponse = await fetch(`${origin}/api/connections/agents`, {
    headers: headers(credential),
  });
  const inventoryBody = await inventoryResponse.json();
  if (!inventoryResponse.ok || !inventoryBody.success) {
    throw new Error(
      inventoryBody.error ?? `Inventory failed (${inventoryResponse.status})`,
    );
  }

  const requested = optionValues('connection');
  const defaultIds = new Set(['claude', 'codex', 'ollama-runtime']);
  for (const connection of inventoryBody.data) {
    if (connection.type === 'acp' && connection.enabled)
      defaultIds.add(connection.id);
  }
  const connectionIds = requested.length > 0 ? requested : [...defaultIds];
  const receipts = [];
  for (const id of connectionIds) {
    const response = await fetch(
      `${origin}/api/connections/${encodeURIComponent(id)}/smoke`,
      {
        method: 'POST',
        headers: headers(credential, true),
        body: JSON.stringify({ confirmed: true, timeoutMs }),
      },
    );
    const body = await response.json();
    receipts.push({
      connectionId: id,
      httpStatus: response.status,
      success: response.ok && body.success === true,
      level: body.data?.level ?? null,
      smokeStatus: body.data?.smoke?.status ?? null,
      testedAt: body.data?.smoke?.testedAt ?? null,
      reasonCode: body.data?.smoke?.reasonCode ?? null,
      reason: body.data?.smoke?.reason ?? body.error ?? null,
    });
  }
  console.log(
    JSON.stringify({ origin, turnLimitPerConnection: 1, receipts }, null, 2),
  );
  if (
    receipts.some(
      (receipt) => !receipt.success || receipt.smokeStatus !== 'passed',
    )
  ) {
    process.exitCode = 1;
  }
}
