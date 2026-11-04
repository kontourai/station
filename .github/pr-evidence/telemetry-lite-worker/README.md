# Lite Worker dashboards captures

Before: `8f2f68267f0d694fe283ae323d017a7c8fb410f3` (the public page served by the
Node receiver). After: `f804317d6256` (one `station` source; the public page
never sums clipped cells and names a top value only above the noise).

Every capture uses synthetic data. `deploy/telemetry-worker/test/preview-server.ts --with-tokens`
seeds about four months of generated pings through the real `LiteReceiver`
ingest and hourly maintenance over in-memory SQLite, and serves the real Worker
handler. The before capture serves the baseline's page script against the same
preview's aggregates. Noise keys are random per preview run, so public
estimates differ between captures. The token-throughput panel uses a simulated
`engine_tokens_today` dimension, because the contract does not carry that field yet.

Chromium at 1280 px (light and dark) and 390 px, device scale 2. Inspected:
the hero and stat tiles, the public headline's below-noise state and its
suppressed top-pick tiles (at this synthetic volume most public cells are
within noise), the line chart with today's partial day dashed, the hover
crosshair tooltip, the column charts with partial periods faded, bar
lists, segmented per-engine bars with ordinal legends, the locked key prompt,
and narrow-screen axis labels. These are local renders, not a deployed Worker.

Retention: permanent — source-pinned before/after evidence for this change.
