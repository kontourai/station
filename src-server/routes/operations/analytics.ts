/**
 * Analytics Routes - usage stats and achievements
 */

import { MS_PER_DAY } from '@kontourai/station-contracts/time';
import { Hono } from 'hono';
import { LocalUsageReceiptSource } from '../../analytics/local-usage-receipt-source.js';
import type { UsageAggregator } from '../../analytics/usage-aggregator.js';
import {
  RemoteStationUsageReceiptSource,
  type UsageRollupReadAuthority,
  type UsageRollupService,
  UsageRollupService as UsageRollupServiceImpl,
} from '../../analytics/usage-rollup-service.js';
import type { PeerCredential } from '../../services/peers/peer-credential-store.js';
import { analyticsOps } from '../../telemetry/metrics.js';
import { errorMessage } from '../schemas/schemas.js';

export function createAnalyticsRoutes(
  usageAggregator: UsageAggregator | undefined,
  usageRollupService?: UsageRollupService,
  readAuthorityForRequest?: (request: Request) => UsageRollupReadAuthority,
  configuredPeers?: () => readonly (PeerCredential & { credential: string })[],
  localStationId = 'local',
) {
  const app = new Hono();

  app.get('/usage', async (c) => {
    try {
      if (!usageAggregator) {
        return c.json(
          { success: false, error: 'Analytics not initialized' },
          500,
        );
      }
      analyticsOps.add(1, { op: 'get_usage' });
      const stats = await usageAggregator.loadStats();
      const from = c.req.query('from');
      const to = c.req.query('to');
      if (from || to) {
        const defaultFrom = new Date(Date.now() - 14 * MS_PER_DAY)
          .toISOString()
          .split('T')[0];
        const defaultTo = new Date().toISOString().split('T')[0];
        const f = from || defaultFrom;
        const t = to || defaultTo;
        const filtered: typeof stats.byDate = {};
        for (const [date, day] of Object.entries(stats.byDate || {})) {
          if (date >= f && date <= t) filtered[date] = day;
        }
        // Compute range summary
        const days = Object.values(filtered);
        const totalDays = Math.max(
          1,
          Math.round(
            (new Date(t).getTime() - new Date(f).getTime()) / MS_PER_DAY,
          ) + 1,
        );
        const activeDays = days.length;
        const totalMessages = days.reduce((s, d) => s + d.messages, 0);
        const totalCost = days.reduce((s, d) => s + d.cost, 0);
        const avgPerDay = activeDays > 0 ? totalMessages / activeDays : 0;
        const rangeSummary = {
          totalDays,
          activeDays,
          totalMessages,
          totalCost,
          avgPerDay,
        };
        return c.json({
          success: true,
          data: { ...stats, byDate: filtered, rangeSummary },
        });
      }
      return c.json({ success: true, data: stats });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/usage-rollup', async (c) => {
    if (!usageAggregator && !usageRollupService) {
      return c.json(
        { success: false, error: 'Analytics not initialized' },
        500,
      );
    }
    const days = Number(c.req.query('days') ?? '14');
    if (![7, 14, 30].includes(days)) {
      return c.json(
        { success: false, error: 'days must be 7, 14, or 30' },
        400,
      );
    }
    const groupBy = c.req.query('groupBy');
    const allowed = new Set([
      'provider',
      'model',
      'station',
      'conversation',
      'task',
      'day',
    ]);
    if (groupBy !== undefined && !allowed.has(groupBy)) {
      return c.json(
        { success: false, error: 'invalid usage rollup grouping' },
        400,
      );
    }
    const pageSize = Number(c.req.query('pageSize') ?? '50');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return c.json({ success: false, error: 'pageSize must be 1-100' }, 400);
    }
    const requestedFrom = c.req.query('from');
    const requestedTo = c.req.query('to');
    const hasExactWindow =
      requestedFrom !== undefined || requestedTo !== undefined;
    const to = hasExactWindow
      ? requestedTo
      : new Date().toISOString().slice(0, 10);
    const from = hasExactWindow
      ? requestedFrom
      : new Date(Date.now() - (days - 1) * MS_PER_DAY)
          .toISOString()
          .slice(0, 10);
    if (
      !from ||
      !to ||
      !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
      from > to ||
      ![7, 14, 30].includes(
        Math.round(
          (Date.parse(`${to}T00:00:00.000Z`) -
            Date.parse(`${from}T00:00:00.000Z`)) /
            MS_PER_DAY,
        ) + 1,
      )
    ) {
      return c.json(
        { success: false, error: 'window must be an exact 7, 14, or 30 days' },
        400,
      );
    }
    try {
      const authority = readAuthorityForRequest?.(c.req.raw);
      if (!authority) {
        return c.json(
          { success: false, error: 'Usage rollup read denied' },
          403,
        );
      }
      const localOnly = c.req.query('localOnly') === '1';
      const peers = localOnly ? [] : (configuredPeers?.() ?? []);
      const queriedPeers = peers.slice(0, 2);
      const service =
        usageRollupService ??
        new UsageRollupServiceImpl(
          [
            new LocalUsageReceiptSource(localStationId, usageAggregator!),
            ...queriedPeers.map(
              (peer) =>
                new RemoteStationUsageReceiptSource(
                  peer.environmentId,
                  peer.apiBase,
                  peer.credential,
                  peer.scope,
                ),
            ),
          ],
          peers.slice(2).map((peer) => ({
            stationId: peer.environmentId,
            state: 'unknown' as const,
            reason: 'not queried: usage source cap is 3 Stations',
            window: { from, to },
          })),
        );
      const data = await service.read(
        {
          from,
          to,
          groupBy: groupBy as
            | 'provider'
            | 'model'
            | 'station'
            | 'conversation'
            | 'task'
            | 'day'
            | undefined,
          cursor: c.req.query('cursor'),
          pageSize,
          drilldown: c.req.query('drilldown') !== '0',
          // A paired Station is authenticated by the peer credential and is
          // the only caller that needs bounded source material to compose its
          // own rollup. Never expose it to ordinary browser callers.
          includeAggregate:
            c.req.query('localOnly') === '1' &&
            c.req.query('includeAggregate') === '1',
        },
        authority,
      );
      analyticsOps.add(1, { op: 'get_usage_rollup' });
      return c.json({ success: true, data });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.get('/achievements', async (c) => {
    try {
      if (!usageAggregator) {
        return c.json(
          { success: false, error: 'Analytics not initialized' },
          500,
        );
      }
      const achievements = await usageAggregator.getAchievements();
      analyticsOps.add(1, { op: 'get_achievements' });
      return c.json({ success: true, data: achievements });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.post('/rescan', async (c) => {
    try {
      if (!usageAggregator) {
        return c.json(
          { success: false, error: 'Analytics not initialized' },
          500,
        );
      }
      const stats = await usageAggregator.fullRescan();
      analyticsOps.add(1, { op: 'rescan' });
      return c.json({
        success: true,
        data: stats,
        message: 'Full rescan completed',
      });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  app.delete('/usage', async (c) => {
    try {
      if (!usageAggregator) {
        return c.json(
          { success: false, error: 'Analytics not initialized' },
          500,
        );
      }
      await usageAggregator.reset();
      analyticsOps.add(1, { op: 'delete_usage' });
      return c.json({ success: true, message: 'Usage stats reset' });
    } catch (error: unknown) {
      return c.json({ success: false, error: errorMessage(error) }, 500);
    }
  });

  return app;
}
