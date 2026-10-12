// The Station app icon as vector source: a square map tile carved by the
// canonical River S (station-icon-geometry.mjs), with engraved contours offset
// from the river, a gold compass in the lower bowl, a stacked base layer and
// a bevel. Every surface scripts/generate-app-icons.mjs renders comes from
// the SVG strings built here; nothing is traced from a raster.
//
// The map is the flat marks' 24-unit frame placed with one uniform scale and
// a translation, so the river centreline and contour levels coincide with the
// flat Station badge's. Output is deterministic: the same channel always
// yields the same SVG text.
import {
  C,
  centreline,
  distTo,
  evalSeg,
  fmt,
  offsetChain,
  pieces,
  runData,
  runPoints,
  TILE,
  tileSdf,
} from './station-icon-geometry.mjs';

// Parchment and gold are the same in every channel; only the water family
// (background, river, base layer) carries the channel colour.
const LAND = Object.freeze({
  top: '#fcf6eb',
  topLow: '#f1e5cf',
  sideTop: '#efe2c9',
  sideMid: '#dcc6a0',
  sideLow: '#c3a57a',
  line: '#bd914f',
  lineMinor: '#d9bf93',
  lineHi: '#fffaf1',
  lip: '#fffdf7',
  gold: '#f6cf78',
  goldMid: '#e2b057',
  goldDark: '#b88234',
  goldDeep: '#9c6c26',
});

/**
 * The water palette of each release channel, as explicit colours. They were
 * derived once from the approved stable blue (beta: hue -62deg, saturation
 * x0.7; nightly rose: hue +135deg, saturation x0.82; dev amber: hue -175deg)
 * and are fixed here so a channel's colour is a reviewed value rather than
 * the output of an operation. Every channel hue stays well clear of the
 * Station brand purple (#7c3aed / #966aff); station-icon.test.ts enforces it.
 */
export const CHANNEL_PALETTES = Object.freeze({
  stable: Object.freeze({
    bgHi: '#0a4560',
    bgLo: '#022637',
    bgEdge: '#011a26',
    water: '#25729c',
    waterLow: '#3587b2',
    waterDeep: '#06283a',
    bank: '#0f4562',
    baseTop: '#6aa1bc',
    baseTopLow: '#4c85a2',
    baseSide: '#2a5b74',
    baseSideDark: '#183f53',
    baseRim: '#b4dbec',
    shadow: '#00111a',
  }),
  beta: Object.freeze({
    bgHi: '#175328',
    bgLo: '#0a2f15',
    bgEdge: '#07200e',
    water: '#378a51',
    waterLow: '#489f63',
    waterDeep: '#0e3219',
    bank: '#1b562e',
    baseTop: '#76b087',
    baseTopLow: '#59956b',
    baseSide: '#356945',
    baseSideDark: '#214a2d',
    baseRim: '#bce4c7',
    shadow: '#04160a',
  }),
  nightly: Object.freeze({
    bgHi: '#581230',
    bgLo: '#320719',
    bgEdge: '#230411',
    water: '#913056',
    waterLow: '#a7406a',
    waterDeep: '#350b1c',
    bank: '#5b1632',
    baseTop: '#b5718e',
    baseTopLow: '#9a5471',
    baseSide: '#6d314a',
    baseSideDark: '#4e1d31',
    baseRim: '#e7b9ce',
    shadow: '#18020b',
  }),
  dev: Object.freeze({
    bgHi: '#602c0a',
    bgLo: '#371702',
    bgEdge: '#261001',
    water: '#9c5925',
    waterLow: '#b26a35',
    waterDeep: '#3a1c06',
    bank: '#62330f',
    baseTop: '#bc8c6a',
    baseTopLow: '#a2704c',
    baseSide: '#74492a',
    baseSideDark: '#533118',
    baseRim: '#eccab4',
    shadow: '#1a0b00',
  }),
});

// ------------------------------------------------------------- geometry ---
const S = 1024;
const V = {
  cx: 512,
  cy: 446,
  s: 26.4, // tile face 581px
  riverW: 4.6,
  thick: 42,
  strata: [15, 29], // layer boundaries in the cut edge, px below the face
  channel: 17, // depth the river is carved into the edge
  baseDrop: 64,
  baseThick: 24,
  baseGrow: 1.035, // the base layer is a touch larger, so its rim shows
  index: [3, 6, 9, 12, 15, 18], // the badge's levels, continued to the corners
  minor: [4.5, 7.5, 10.5, 13.5, 16.5],
  compass: { r: 1.6, push: 0.3, clear: 0.6 },
};
const MAP_TRANSFORM = `translate(${V.cx} ${V.cy}) scale(${V.s}) translate(${-C[0]} ${-C[1]})`;
const toScreen = ([x, y]) => [V.cx + (x - C[0]) * V.s, V.cy + (y - C[1]) * V.s];

const tilePath = () => {
  const a = C[0] - TILE.half;
  const b = C[0] + TILE.half;
  const r = TILE.corner;
  return `M${a + r} ${a}H${b - r}A${r} ${r} 0 0 1 ${b} ${a + r}V${b - r}A${r} ${r} 0 0 1 ${b - r} ${b}H${a + r}A${r} ${r} 0 0 1 ${a} ${b - r}V${a + r}A${r} ${r} 0 0 1 ${a + r} ${a}Z`;
};
function outline(n = 480) {
  const pts = [];
  for (let k = 0; k < n; k += 1) {
    const t = (k / n) * Math.PI * 2;
    const u = [Math.cos(t), Math.sin(t)];
    let lo = 0;
    let hi = TILE.half * 1.5;
    for (let i = 0; i < 40; i += 1) {
      const m = (lo + hi) / 2;
      if (tileSdf([C[0] + u[0] * m, C[1] + u[1] * m]) < 0) lo = m;
      else hi = m;
    }
    pts.push([C[0] + u[0] * lo, C[1] + u[1] * lo]);
  }
  return pts;
}
function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0)
      lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of p.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0)
      upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
const poly = (pts) =>
  `M${pts.map((q) => `${fmt(q[0], 1)} ${fmt(q[1], 1)}`).join('L')}Z`;

// The river, contour levels, compass placement and the bank points where the
// river leaves the tile's near (bottom) edge, all in map units.
function map() {
  const segs = centreline();
  const onRiver = distTo(segs);
  // the compass sits in the lower bowl, nudged toward its open side
  const bowl = [segs[2], segs[4]].sort((a, b) => b.c[1] - a.c[1])[0];
  const mid = evalSeg(bowl, 0.5).p;
  const away = [bowl.c[0] - mid[0], bowl.c[1] - mid[1]];
  const n = Math.hypot(...away);
  const rose = {
    c: [
      bowl.c[0] + (away[0] / n) * V.compass.push,
      bowl.c[1] + (away[1] / n) * V.compass.push,
    ],
    r: V.compass.r,
  };
  const clear = V.compass.r + V.compass.clear;
  const level = (d) => {
    const out = [];
    for (const side of [1, -1]) {
      const runs = pieces(
        offsetChain(segs, side * d, 0.55),
        (p) =>
          tileSdf(p) < 0.4 &&
          onRiver(p) >= d - 0.04 &&
          Math.hypot(p[0] - rose.c[0], p[1] - rose.c[1]) > clear,
        { boundary: (p) => tileSdf(p) > -0.2, trim: 0.7, min: 0.9 },
      );
      for (const r of runs) out.push(runData(r, 3));
    }
    return out.join('');
  };
  const waterRuns = pieces(segs, (p) => tileSdf(p) < 1.5, { min: 1 });
  const banks = [V.riverW / 2, -V.riverW / 2].map((d) => {
    let best = null;
    for (const r of pieces(offsetChain(segs, d), (p) => tileSdf(p) < 0, {
      min: 0.1,
    })) {
      for (const q of [r.from, r.to]) if (!best || q.p[1] > best[1]) best = q.p;
    }
    return best;
  });
  // the centreline clipped to the tile face, for the startup animation
  const inTile = pieces(segs, (p) => tileSdf(p) < 0, { min: 1 });
  return {
    segs,
    index: V.index.map(level).join(''),
    minor: V.minor.map(level).join(''),
    water: waterRuns.map((r) => runData(r, 3)).join(''),
    inTile,
    rose,
    banks,
  };
}

// A simplified compass rose: four cardinal points, four short intercardinal
// points, each split into a lit and a shaded facet.
function star(cx, cy, r, L) {
  const P = (a, rr) => [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  const kite = (a, len, base, lit, shade) => {
    const o = [cx, cy];
    return `<path fill="${lit}" d="${poly([o, P(a - Math.PI / 4, base), P(a, len)])}"/><path fill="${shade}" d="${poly([o, P(a, len), P(a + Math.PI / 4, base)])}"/>`;
  };
  let out = '';
  for (let k = 0; k < 4; k += 1)
    out += kite(
      -Math.PI / 4 + (k * Math.PI) / 2,
      r * 0.56,
      r * 0.15,
      L.goldMid,
      L.goldDeep,
    );
  for (let k = 0; k < 4; k += 1)
    out += kite(
      -Math.PI / 2 + (k * Math.PI) / 2,
      r,
      r * 0.2,
      L.gold,
      L.goldDark,
    );
  return out;
}

// The tile, slab and base layer in screen units of the 1024 body.
function solids() {
  const face = outline().map(toScreen);
  const down = (pts, dy) => pts.map(([x, y]) => [x, y + dy]);
  const baseFace = face.map(([x, y]) => [
    V.cx + (x - V.cx) * V.baseGrow,
    V.cy + (y - V.cy) * V.baseGrow + V.baseDrop,
  ]);
  return { face, down, baseFace };
}

// The artwork in a 1024 body. `backdrop: false` leaves out the backdrop,
// for a caller that draws its own. `cutout: true` also drops the shadow cast
// on the backdrop and outlines the tile, for the mark on transparency:
// without the backdrop the parchment face has no edge on a light page.
function body(pal, id, { backdrop = true, cutout = false } = {}) {
  const L = LAND;
  const m = map();
  const u = (n) => `url(#${n}-${id})`;
  const { face, down, baseFace } = solids();
  const ys = face.map((q) => q[1]);
  const xs = face.map((q) => q[0]);
  const [x0, x1, y0, y1] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const slab = poly(hull([...face, ...down(face, V.thick)]));
  // the cut edge shows the map's layers: each stratum is the slab down to
  // its boundary, painted over the one below
  const strata = V.strata.map((t) => poly(hull([...face, ...down(face, t)])));
  const baseSlab = poly(hull([...baseFace, ...down(baseFace, V.baseThick)]));
  const by1 = Math.max(...baseFace.map((q) => q[1]));
  const [b0, b1] = m.banks.map(toScreen).sort((a, b) => a[0] - b[0]);
  const notch = poly([
    b0,
    b1,
    [b1[0], b1[1] + V.channel],
    [b0[0], b0[1] + V.channel],
  ]);
  const [rx, ry] = toScreen(m.rose.c);
  const rr = m.rose.r * V.s;
  const shadowL = {
    gold: pal.shadow,
    goldMid: pal.shadow,
    goldDark: pal.shadow,
    goldDeep: pal.shadow,
  };
  const defs = `
<radialGradient id="bg-${id}" cx="50%" cy="20%" r="88%"><stop offset="0" stop-color="${pal.bgHi}"/><stop offset=".6" stop-color="${pal.bgLo}"/><stop offset="1" stop-color="${pal.bgEdge}"/></radialGradient>
<linearGradient id="top-${id}" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${L.top}"/><stop offset=".5" stop-color="${L.top}"/><stop offset="1" stop-color="${L.topLow}"/></linearGradient>
<linearGradient id="sidelight-${id}" x1="${x0}" y1="0" x2="${x1}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>
<linearGradient id="bside-${id}" x1="0" y1="${by1 - 20}" x2="0" y2="${by1 + V.baseThick}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${pal.baseSide}"/><stop offset="1" stop-color="${pal.baseSideDark}"/></linearGradient>
<linearGradient id="btop-${id}" x1="0" y1="${y0 + V.baseDrop}" x2="0" y2="${by1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${pal.baseTop}"/><stop offset="1" stop-color="${pal.baseTopLow}"/></linearGradient>
<linearGradient id="water-${id}" x1="0" y1="${y0}" x2="0" y2="${y1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${pal.water}"/><stop offset="1" stop-color="${pal.waterLow}"/></linearGradient>
<linearGradient id="notch-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.water}"/><stop offset="1" stop-color="${pal.baseSideDark}"/></linearGradient>
<linearGradient id="bevel-${id}" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity=".25"/></linearGradient>
<linearGradient id="rim-${id}" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${pal.baseRim}" stop-opacity=".9"/><stop offset="1" stop-color="${pal.baseRim}" stop-opacity=".35"/></linearGradient>
<mask id="river-${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${S}" height="${S}"><g transform="${MAP_TRANSFORM}" clip-path="${u('tile')}"><path d="${m.water}" fill="none" stroke="#fff" stroke-width="${V.riverW}"/></g></mask>
<filter id="inset-${id}" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
  <feFlood flood-color="${pal.waterDeep}" flood-opacity=".9"/><feComposite in2="SourceAlpha" operator="out"/>
  <feOffset dy="13"/><feGaussianBlur stdDeviation="5"/><feComposite in2="SourceAlpha" operator="in" result="wall"/>
  <feFlood flood-color="#ffffff" flood-opacity=".5"/><feComposite in2="SourceAlpha" operator="out"/>
  <feOffset dy="-3"/><feGaussianBlur stdDeviation="1.2"/><feComposite in2="SourceAlpha" operator="in" result="lip"/>
  <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="wall"/><feMergeNode in="lip"/></feMerge>
</filter>
<filter id="soft-${id}" x="-20%" y="-20%" width="140%" height="170%"><feGaussianBlur stdDeviation="24"/></filter>
<filter id="tight-${id}" x="-20%" y="-20%" width="140%" height="170%"><feGaussianBlur stdDeviation="6"/></filter>
<clipPath id="tile-${id}"><path d="${tilePath()}"/></clipPath>
<clipPath id="below-${id}"><rect x="0" y="${V.cy}" width="${S}" height="${S}"/></clipPath>`;
  const inMap = (inner, extra = '') =>
    `<g transform="${MAP_TRANSFORM}" clip-path="${u('tile')}"${extra}>${inner}</g>`;
  const art = `
${backdrop ? `<rect width="${S}" height="${S}" fill="${u('bg')}"/>` : ''}
${cutout ? '' : `<path d="${baseSlab}" transform="translate(0 36)" fill="${pal.shadow}" opacity=".6" filter="${u('soft')}"/>`}
<path d="${baseSlab}" fill="${u('bside')}"/>
<path d="${poly(baseFace)}" fill="${u('btop')}"/>
<path d="${poly(baseFace)}" fill="none" stroke="${u('rim')}" stroke-width="3"/>
<path d="${slab}" transform="translate(0 16)" fill="${pal.shadow}" opacity=".55" filter="${u('tight')}"/>
<path d="${slab}" fill="${L.sideLow}"/>
<path d="${strata[1]}" fill="${L.sideMid}"/>
<path d="${strata[1]}" fill="none" stroke="${L.sideLow}" stroke-width="1.5" clip-path="${u('below')}"/>
<path d="${strata[0]}" fill="${L.sideTop}"/>
<path d="${strata[0]}" fill="none" stroke="${L.sideMid}" stroke-width="1.5" clip-path="${u('below')}"/>
<path d="${slab}" fill="${u('sidelight')}"/>
<path d="${notch}" fill="${u('notch')}"/>
<path d="${poly(face)}" fill="${u('top')}"/>
<g transform="translate(0 1.5)">${inMap(`<path d="${m.index}" stroke-width=".13"/><path d="${m.minor}" stroke-width=".085"/>`, ` fill="none" stroke="${L.lineHi}" stroke-linecap="round"`)}</g>
${inMap(`<path d="${m.minor}" stroke="${L.lineMinor}" stroke-width=".085"/><path d="${m.index}" stroke="${L.line}" stroke-width=".13"/>`, ` fill="none" stroke-linecap="round"`)}
${inMap(`<path d="${m.water}" stroke="${L.lip}" stroke-width="${V.riverW + 0.5}"/><path d="${m.water}" stroke="${pal.bank}" stroke-width="${V.riverW + 0.2}"/>`, ` fill="none"`)}
<g filter="${u('inset')}"><rect width="${S}" height="${S}" fill="${u('water')}" mask="${u('river')}"/></g>
<path d="${poly(face)}" fill="none" stroke="${u('bevel')}" stroke-width="3"/>
${cutout ? `<path d="${slab}" fill="none" stroke="${pal.bank}" stroke-opacity=".4" stroke-width="5" stroke-linejoin="round"/>` : ''}
<g opacity=".3" filter="${u('tight')}">${star(rx, ry + 7, rr, shadowL)}</g>${star(rx, ry, rr, L)}`;
  return { defs, art };
}

/**
 * The square crop of the 1024 body that holds the cut-out mark: the tile,
 * its edge and the base layer, centred, with a margin that keeps the outline
 * and the tile's shadow on the base inside the crop.
 */
function markBox() {
  const { face, baseFace } = solids();
  const pts = [...face, ...baseFace.map(([x, y]) => [x, y + V.baseThick])];
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  const [x0, x1, y0, y1] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const side = Math.max(x1 - x0, y1 - y0) * 1.08;
  return {
    x: (x0 + x1) / 2 - side / 2,
    y: (y0 + y1) / 2 - side / 2,
    side,
  };
}

// The farthest corner of the tile and base layer lies about 424 units from
// the centre of the artwork; at this scale that is 318, inside the 341-unit
// radius (72 of 108dp) a circular launcher mask keeps.
const ANDROID_SCALE = 0.75;
// The desktop master enlarges the artwork so the tile spans about two thirds
// of the icon (it is 57% in the square master); its farthest corner, 424 x
// 1.15 = 488 units out, stays inside the rounded body (629 units at 45deg).
const DESKTOP_SCALE = 1.15;

const svg = (viewBox, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="1024" height="1024">${inner}</svg>\n`;

/**
 * One channel's icon as SVG text.
 *   macos  - the artwork on the macOS icon grid: an 824 body inset 100 in the
 *            1024 canvas, continuous corner 185.4, a soft drop shadow; alpha
 *            outside the body. The desktop sets come from this.
 *   square - the full-bleed opaque square. iOS rejects alpha and Android and
 *            Windows launchers apply their own masks.
 *   android - the square with the tile scaled into the adaptive-icon safe
 *            zone. Launchers mask an adaptive foreground to its inner 72 of
 *            108dp and the Android 12 splash to a circle inside that, so the
 *            full-bleed square would lose the tile's edges and the channel
 *            background; here the whole tile stays inside the circle.
 *   desktop - the square with rounded corners and no drop shadow or grid
 *            inset, the artwork enlarged about its centre: Windows and Linux
 *            draw this at 16-32px in taskbars, title bars and the tray, where
 *            the macOS grid's padding would leave the tile a few pixels wide.
 *   mark   - the tile and base layer cut out on transparency, cropped square:
 *            the in-app mark and the native launch-screen logo.
 */
export const ICON_TARGETS = Object.freeze([
  'macos',
  'desktop',
  'square',
  'android',
  'mark',
]);
export function stationIconSvg(channel, target) {
  const pal = CHANNEL_PALETTES[channel];
  if (!pal) throw new Error(`Unknown Station icon channel ${channel}`);
  const id = `${channel}-${target}`;
  if (target === 'square') {
    const { defs, art } = body(pal, id);
    return svg(`0 0 ${S} ${S}`, `<defs>${defs}</defs>${art}`);
  }
  if (target === 'android' || target === 'desktop') {
    const { defs, art } = body(pal, id, { backdrop: false });
    const box = markBox();
    const [cx, cy] = [box.x + box.side / 2, box.y + box.side / 2];
    const scale = target === 'android' ? ANDROID_SCALE : DESKTOP_SCALE;
    const placed = `<rect width="${S}" height="${S}" fill="url(#bg-${id})"/><g transform="translate(${S / 2} ${S / 2}) scale(${scale}) translate(${fmt(-cx, 3)} ${fmt(-cy, 3)})">${art}</g>`;
    if (target === 'android')
      return svg(`0 0 ${S} ${S}`, `<defs>${defs}</defs>${placed}`);
    return svg(
      `0 0 ${S} ${S}`,
      `<defs>${defs}<clipPath id="body-${id}"><rect width="${S}" height="${S}" rx="230.4"/></clipPath></defs><g clip-path="url(#body-${id})">${placed}</g>`,
    );
  }
  if (target === 'mark') {
    const { defs, art } = body(pal, id, { backdrop: false, cutout: true });
    const box = markBox();
    return svg(
      `${fmt(box.x, 3)} ${fmt(box.y, 3)} ${fmt(box.side, 3)} ${fmt(box.side, 3)}`,
      `<defs>${defs}</defs>${art}`,
    );
  }
  if (target === 'macos') {
    const { defs, art } = body(pal, id);
    const k = 824 / 1024;
    return svg(
      `0 0 ${S} ${S}`,
      `<defs>${defs}
<clipPath id="body-${id}"><rect width="${S}" height="${S}" rx="230.4"/></clipPath>
<filter id="drop-${id}" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity=".3"/></filter></defs>
<g filter="url(#drop-${id})"><g transform="translate(100 100) scale(${k})"><g clip-path="url(#body-${id})">${art}</g></g></g>`,
    );
  }
  throw new Error(`Unknown Station icon target ${target}`);
}

/**
 * The Android status-bar mark as VectorDrawable path data in a 24-unit
 * frame: the tile, reduced to leave the status bar's padding, with the river
 * cut through it (even-odd). Status-bar icons are alpha masks, so the cut is
 * the only way to show the river. Each bank is sampled along its exact
 * offset curve, inside the tile.
 */
export function statusBarMarkPathData() {
  const half = 9.6;
  const k = half / TILE.half;
  const at = ([x, y]) => [C[0] + (x - C[0]) * k, C[1] + (y - C[1]) * k];
  const xy = (p) => `${fmt(p[0], 2)},${fmt(p[1], 2)}`;
  const a = C[0] - half;
  const b = C[0] + half;
  const r = TILE.corner * k;
  const f = (v) => fmt(v, 2);
  const tile = `M${f(a + r)},${f(a)}L${f(b - r)},${f(a)}A${f(r)},${f(r)} 0 0 1 ${f(b)},${f(a + r)}L${f(b)},${f(b - r)}A${f(r)},${f(r)} 0 0 1 ${f(b - r)},${f(b)}L${f(a + r)},${f(b)}A${f(r)},${f(r)} 0 0 1 ${f(a)},${f(b - r)}L${f(a)},${f(a + r)}A${f(r)},${f(r)} 0 0 1 ${f(a + r)},${f(a)}Z`;
  const segs = centreline();
  const bank = (d) => {
    const runs = pieces(offsetChain(segs, d), (p) => tileSdf(p) < 0, {
      min: 0.1,
    });
    if (runs.length !== 1)
      throw new Error(
        `status-bar mark: bank ${d} crosses the tile ${runs.length} times`,
      );
    return runPoints(runs[0], 0.25).map(at);
  };
  const left = bank(V.riverW / 2);
  const right = bank(-V.riverW / 2).reverse();
  const river = `M${[...left, ...right].map(xy).join('L')}Z`;
  return `${tile}${river}`;
}

/**
 * Where the startup animation finds the river in the cut-out mark, in the
 * `size`-pixel square it draws the mark into: the river centreline across
 * the tile face (the flow guide), a point mid-river to sample the water
 * colour from, and the lip at the bottom of the carved notch where the
 * falling drop starts.
 */
export function startupMarkGeometry(size) {
  const m = map();
  const box = markBox();
  const k = (V.s * size) / box.side;
  const px = ([x, y]) => [
    (x - box.x) * (size / box.side),
    (y - box.y) * (size / box.side),
  ];
  const fromMap = (p) => px(toScreen(p));
  // the guide in mark pixels: the same lines and arcs, uniformly scaled
  const scaled = (segs) =>
    segs.map((s) =>
      s.type === 'line'
        ? { ...s, p0: fromMap(s.p0), p1: fromMap(s.p1), len: s.len * k }
        : { ...s, c: fromMap(s.c), R: s.R * k },
    );
  const guide = m.inTile
    .map((r) =>
      runData(
        {
          ...r,
          segs: scaled(r.segs),
          from: { ...r.from, p: fromMap(r.from.p) },
        },
        1,
      ),
    )
    .join('');
  const [b0, b1] = m.banks.map(toScreen);
  const lip = px([(b0[0] + b1[0]) / 2, Math.max(b0[1], b1[1]) + V.channel]);
  return { guide, water: fromMap(C).map(Math.round), lip: lip.map(Math.round) };
}
