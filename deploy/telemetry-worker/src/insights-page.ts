// Read-only insights use the signed Cloudflare Access session.
import {
  DASHBOARD_KIT_JS,
  DASHBOARD_STYLE,
} from '../../../packages/telemetry-broker/src/dashboard-kit.ts';

export const INSIGHTS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Station insights</title><style>${DASHBOARD_STYLE}</style>
<script src="/insights/insights.js" defer></script></head><body><main>
<header class="top"><div><h1>Station insights</h1>
<p class="sub">Received daily usage reports (UTC). These count pings, not verified people or unique installations.</p></div>
<div><span class="muted" id="updated"></span> <a href="/cdn-cgi/access/logout">Sign out</a></div></header>
<p class="muted" id="status" role="status"></p>
<div id="tiles" class="tiles"></div>
<div id="charts" class="grid"></div>
</main></body></html>`;

const PAGE_JS = String.raw`
(function () {
  var C = window.StationCharts;
  var status = document.getElementById('status'), tiles = document.getElementById('tiles'), charts = document.getElementById('charts');
  var updated = document.getElementById('updated');

  function addDays(day, n) { return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function weekStart(day) { var wd = new Date(day + 'T00:00:00Z').getUTCDay(); return addDays(day, -((wd + 6) % 7)); }
  function series(data, dimension, value) {
    var d = data.dimensions[dimension] || {};
    return d[value] || data.days.map(function () { return 0; });
  }
  function sumLast(values, n) { return values.slice(-n).reduce(function (s, v) { return s + v; }, 0); }
  function totalsOver(data, dimension, n) {
    var d = data.dimensions[dimension] || {}, out = [];
    Object.keys(d).forEach(function (value) { out.push({ label: value, value: sumLast(d[value], n) }); });
    return out.filter(function (r) { return r.value > 0; }).sort(function (a, b) { return b.value - a.value || (a.label < b.label ? -1 : 1); });
  }
  // Bucket labels order by their lower bound: 0, 1, 2-3, 4+, 1-10k, 10k-100k, 10M+.
  function bucketBound(bucket) {
    var m = /^(\d+(?:\.\d+)?)([kKmM]?)/.exec(bucket);
    if (!m) return Infinity;
    return Number(m[1]) * (/k/i.test(m[2]) ? 1e3 : /m/i.test(m[2]) ? 1e6 : 1);
  }
  function grouped(days, values, keyOf) {
    var keys = [], sums = {};
    days.forEach(function (day, i) {
      var k = keyOf(day);
      if (!(k in sums)) { keys.push(k); sums[k] = 0; }
      sums[k] += values[i];
    });
    return { keys: keys, values: keys.map(function (k) { return sums[k]; }) };
  }
  function topWithOther(rows, n) {
    if (rows.length <= n) return rows;
    var rest = rows.slice(n - 1).reduce(function (s, r) { return s + r.value; }, 0);
    return rows.slice(0, n - 1).concat([{ label: 'Other', value: rest }]);
  }
  function withShare(rows, whole) { return rows.map(function (r) { return { label: r.label, value: r.value, share: whole ? r.value / whole : 0 }; }); }

  function render(data) {
    tiles.replaceChildren(); charts.replaceChildren();
    var days = data.days, n = days.length, today = data.today, t = data.totals;
    var last90 = Math.min(90, n);
    var labels90 = days.slice(-last90), dau = t.slice(-last90);
    var weekFlag = series(data, 'first_active_this_week', 'true');
    var monthFlag = series(data, 'first_active_this_month', 'true');
    var fresh = series(data, 'install_age_bucket', '0d');
    var thisWeek = weekStart(today), thisMonth = today.slice(0, 7);
    var wau = 0, mau = 0;
    days.forEach(function (day, i) { if (day >= thisWeek) wau += weekFlag[i]; if (day.slice(0, 7) === thisMonth) mau += monthFlag[i]; });
    var installs = fresh.reduce(function (s, v) { return s + v; }, 0);

    C.stat(tiles, 'Reports in window', C.full(t.reduce(function (sum, value) { return sum + value; }, 0)), 'Since ' + C.shortDay(days[0]));
    C.stat(tiles, 'Reports received today', C.full(t[n - 1]), 'So far · UTC day ' + C.shortDay(today), true);
    C.stat(tiles, 'Yesterday', C.full(n > 1 ? t[n - 2] : 0), 'Usage reports');
    C.stat(tiles, 'First activity this week', C.full(wau), 'Reports marked first active this week');
    C.stat(tiles, 'First activity this month', C.full(mau), 'Reports marked first active this month');
    C.stat(tiles, 'New-install reports', C.full(sumLast(fresh, 7)), 'Last 7 days');
    C.stat(tiles, 'New-install reports in window', C.full(installs), 'Since ' + C.shortDay(days[0]));

    var dauCard = C.card(charts, 'Daily usage reports', 'Last ' + last90 + ' days · today is partial (dashed)', 'wide');
    C.lineChart(dauCard.body, { labels: labels90, series: [{ name: 'Usage reports', values: dau, cls: 's1' }], partialLast: true, height: 240, ariaLabel: 'Daily usage reports' });
    C.table(dauCard.body, ['Day', 'Usage reports'], labels90.map(function (d, i) { return [d, C.full(dau[i])]; }).reverse());

    var weeks = grouped(days, weekFlag, weekStart);
    // Only weeks the window covers in full, plus the open current week.
    var wi = weeks.keys.map(function (k, i) { return i; }).filter(function (i) { return weeks.keys[i] >= days[0]; }).slice(-12);
    var wauCard = C.card(charts, 'First activity by week', 'Reports marked first active in each ISO week · current week is partial');
    C.columnChart(wauCard.body, { labels: wi.map(function (i) { return weeks.keys[i]; }), values: wi.map(function (i) { return weeks.values[i]; }), partial: [wi.length - 1], labelCount: 6, titleFormat: function (w) { return 'Week of ' + C.shortDay(w); }, unit: 'reports', ariaLabel: 'First activity by week' });
    var months = grouped(days, monthFlag, function (d) { return d.slice(0, 7); });
    var mauCard = C.card(charts, 'First activity by month', 'Reports marked first active in each month · current month is partial');
    C.columnChart(mauCard.body, { labels: months.keys, values: months.values, partial: [months.keys.length - 1], labelCount: 4, labelFormat: C.monthLabel, titleFormat: C.monthLabel, unit: 'reports', ariaLabel: 'First activity by month' });

    var newCard = C.card(charts, 'New-install reports per day', 'Pings with install age 0 days · last ' + last90 + ' days');
    C.columnChart(newCard.body, { labels: labels90, values: fresh.slice(-last90), partial: [last90 - 1], unit: 'reports', ariaLabel: 'New-install reports per day' });
    var running = 0, cumulative = fresh.map(function (v) { running += v; return running; });
    var cumCard = C.card(charts, 'Cumulative new-install reports', 'New-install reports since ' + C.shortDay(days[0]));
    C.lineChart(cumCard.body, { labels: days, series: [{ name: 'Reports', values: cumulative, cls: 's1' }], partialLast: true, ariaLabel: 'Cumulative new-install reports' });

    // Half-width panels pair up; an odd one out spans the row.
    var halves = [];
    var engines = totalsOver(data, 'engines_used_today', 30).filter(function (r) { return r.label !== 'none'; });
    var engineMentions = engines.reduce(function (s, r) { return s + r.value; }, 0);
    halves.push({ title: 'Reported harnesses', caption: 'Share of engine use across received reports · last 30 days',
      draw: function (body) { C.barList(body, withShare(engines, engineMentions), { share: true, unit: 'reports' }); } });

    // Every per-engine bucket dimension (values 'engine:bucket'), token
    // throughput first. A dimension appears once the contract adds it.
    var perEngine = Object.keys(data.dimensions).filter(function (dimension) {
      return Object.keys(data.dimensions[dimension]).some(function (v) { return v.indexOf(':') > 0; });
    }).sort(function (a, b) { return (/token/.test(b) ? 1 : 0) - (/token/.test(a) ? 1 : 0) || (a < b ? -1 : 1); })
      .map(function (dimension) {
        var buckets = {}, rows = {};
        totalsOver(data, dimension, 30).forEach(function (r) {
          var at = r.label.indexOf(':');
          if (at <= 0) return;
          var engine = r.label.slice(0, at), bucket = r.label.slice(at + 1);
          buckets[bucket] = true;
          rows[engine] = rows[engine] || { label: engine, parts: {}, total: 0 };
          rows[engine].parts[bucket] = (rows[engine].parts[bucket] || 0) + r.value;
          rows[engine].total += r.value;
        });
        var token = /token/.test(dimension);
        return {
          token: token,
          title: token ? 'Token throughput by engine' : dimension === 'engine_connect_failures' ? 'Connection failures by engine' : dimension.replace(/_/g, ' '),
          caption: (token ? 'Daily input-plus-output token bucket' : 'Daily bucket') + ' per engine · received reports, last 30 days',
          draw: function (body) {
            C.segmentRows(body, Object.keys(rows).map(function (k) { return rows[k]; }).sort(function (a, b) { return b.total - a.total; }),
              Object.keys(buckets).sort(function (a, b) { return bucketBound(a) - bucketBound(b); }), { unit: 'reports' });
          }
        };
      });
    perEngine.filter(function (panel) { return panel.token; }).forEach(function (panel) { halves.push(panel); });

    var week = 7;
    var versions = totalsOver(data, 'version', week), vWhole = versions.reduce(function (s, r) { return s + r.value; }, 0);
    halves.push({ title: 'Version adoption', caption: 'Share of received reports by version · last 7 days',
      draw: function (body) { C.barList(body, withShare(topWithOther(versions, 8), vWhole), { share: true, unit: 'reports' }); } });
    var surfaces = totalsOver(data, 'surfaces_today', week).filter(function (r) { return r.label !== 'none'; });
    halves.push({ title: 'Surfaces used', caption: 'Share of received reports using each surface · last 7 days',
      draw: function (body) { C.barList(body, withShare(surfaces, sumLast(t, week)), { share: true, unit: 'reports' }); } });
    perEngine.filter(function (panel) { return !panel.token; }).forEach(function (panel) { halves.push(panel); });
    if (data.feedback.length) {
      var fb = {};
      data.feedback.forEach(function (f) { var k = f.action + ' · ' + f.reason; fb[k] = (fb[k] || 0) + f.count; });
      halves.push({ title: 'Feedback', caption: 'Fixed-choice reasons since ' + C.shortDay(days[0]),
        draw: function (body) { C.barList(body, Object.keys(fb).map(function (k) { return { label: k, value: fb[k] }; }).sort(function (a, b) { return b.value - a.value; }), { unit: 'responses' }); } });
    }
    halves.forEach(function (panel, i) {
      var odd = halves.length % 2 === 1 && i === halves.length - 1;
      panel.draw(C.card(charts, panel.title, panel.caption, odd ? 'wide' : '').body);
    });

    [['platform', 'Platform'], ['arch', 'Architecture'], ['channel', 'Release channel']].forEach(function (pair) {
      var rows = totalsOver(data, pair[0], week), whole = rows.reduce(function (s, r) { return s + r.value; }, 0);
      var card = C.card(charts, pair[1], 'Share of received reports · last 7 days', 'third');
      C.barList(card.body, withShare(topWithOther(rows, 8), whole), { share: true, unit: 'reports' });
    });
    updated.textContent = 'Updated ' + new Date().toISOString().slice(11, 16) + ' UTC';
  }

  function open() {
    // Storage may be disabled; legacy-key cleanup must not block session reads.
    try { localStorage.removeItem('station-insights-operator-key'); } catch {}
    status.textContent = charts.childElementCount ? '' : 'Loading…';
    fetch('/insights/data', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401 || r.redirected) { status.textContent = 'Your sign-in has expired. Reload this page to sign in again.'; return null; }
        if (r.status === 503) { status.textContent = 'Private insights sign-in is not configured. Contact the operator.'; return null; }
        if (!r.ok) throw new Error('unavailable');
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        var received = data.totals.reduce(function (sum, value) { return sum + value; }, 0);
        status.textContent = received ? 'Received reports are shown below. Overall delivery coverage has not been verified.' : 'No usage reports have been received in this window. Check source provisioning and the endpoint embedded in the running build.';
        render(data);
        C.onResize(function () { render(data); });
      })
      .catch(function () { status.textContent = 'Insights are unavailable. Try again later.'; });
  }
  open();
})();
`;

export const INSIGHTS_JS = DASHBOARD_KIT_JS + PAGE_JS;
