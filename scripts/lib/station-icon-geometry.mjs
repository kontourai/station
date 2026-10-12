// Constructed geometry for the Station app icon: the canonical River S and
// its exact parallel offsets, in the 24-unit frame the flat Station marks use.
//
// A centreline is a chain of straight lines and circular arcs joined on shared
// tangents (a turtle walk). The parallel offset of an arc is a concentric arc
// and of a line a parallel line, so every contour keeps exactly constant
// spacing from the river, and path data is written with exact L and A
// commands; nothing is traced, fitted or smoothed by hand.

const TAU = Math.PI * 2;
const deg = (a) => (a * Math.PI) / 180;

export const fmt = (v, d = 2) => {
  const k = 10 ** d;
  let s = String(Math.round(v * k) / k);
  if (s === '-0') s = '0';
  return s.replace(/^(-?)0\./, '$1.');
};
const pt = (p, d) => `${fmt(p[0], d)} ${fmt(p[1], d)}`;

/**
 * The one Station S: bowls of radius 4.6 sweeping 118deg, a 1.4 straight
 * crossing, easing arcs turning 0.4 of the sweep, on a 115deg axis. At 115deg
 * both banks of the icon's river cross the tile's top and bottom edges clear
 * of its rounded corners. `lead` only lengthens the straight ends, which
 * every rendering clips; it moves no curve inside the frame.
 */
const CANONICAL = Object.freeze({
  R: 4.6,
  sweep: 118,
  mid: 1.4,
  ease: 0.4,
  axis: 115,
  lead: 26,
});
export const C = Object.freeze([12, 12]);

/** The square tile the icon draws its map on, in the same 24-unit frame. */
export const TILE = Object.freeze({ half: 11, corner: 2.6 });
export function tileSdf(p) {
  const q = [
    Math.abs(p[0] - C[0]) - (TILE.half - TILE.corner),
    Math.abs(p[1] - C[1]) - (TILE.half - TILE.corner),
  ];
  return (
    Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0)) +
    Math.min(Math.max(q[0], q[1]), 0) -
    TILE.corner
  );
}

// Heading h in radians, y down, so increasing h turns clockwise on screen.
// arc(R, turn): turn > 0 turns right, turn < 0 left.
function turtle(start, heading) {
  let p = [...start];
  let h = heading;
  const segs = [];
  const api = {
    line(len) {
      const q = [p[0] + len * Math.cos(h), p[1] + len * Math.sin(h)];
      segs.push({ type: 'line', p0: p, p1: q, h, len });
      p = q;
      return api;
    },
    arc(R, turn) {
      const side = Math.sign(turn);
      const n = [Math.cos(h + Math.PI / 2), Math.sin(h + Math.PI / 2)];
      const c = [p[0] + side * R * n[0], p[1] + side * R * n[1]];
      const a0 = Math.atan2(p[1] - c[1], p[0] - c[0]);
      segs.push({ type: 'arc', c, R, a0, turn, side, h0: h });
      p = [c[0] + R * Math.cos(a0 + turn), c[1] + R * Math.sin(a0 + turn)];
      h += turn;
      return api;
    },
    segs,
  };
  return api;
}

const translate = (segs, [dx, dy]) =>
  segs.map((s) =>
    s.type === 'line'
      ? {
          ...s,
          p0: [s.p0[0] + dx, s.p0[1] + dy],
          p1: [s.p1[0] + dx, s.p1[1] + dy],
        }
      : { ...s, c: [s.c[0] + dx, s.c[1] + dy] },
  );

/** Point and heading at parameter t in [0, 1] along one primitive. */
export function evalSeg(s, t) {
  if (s.type === 'line')
    return {
      p: [s.p0[0] + (s.p1[0] - s.p0[0]) * t, s.p0[1] + (s.p1[1] - s.p0[1]) * t],
      h: s.h,
    };
  const a = s.a0 + s.turn * t;
  return {
    p: [s.c[0] + s.R * Math.cos(a), s.c[1] + s.R * Math.sin(a)],
    h: s.h0 + s.turn * t,
  };
}
const segLength = (s) => (s.type === 'line' ? s.len : Math.abs(s.turn) * s.R);

/**
 * The exact parallel offset of a chain, `d` to the right of travel. An arc
 * whose offset radius would fall under `minR` is dropped; `pieces` then trims
 * its neighbours by the caller's validity test.
 */
export function offsetChain(segs, d, minR = 0.8) {
  return segs.map((s) => {
    if (s.type === 'line') {
      const n = [
        Math.cos(s.h + Math.PI / 2) * d,
        Math.sin(s.h + Math.PI / 2) * d,
      ];
      return {
        ...s,
        p0: [s.p0[0] + n[0], s.p0[1] + n[1]],
        p1: [s.p1[0] + n[0], s.p1[1] + n[1]],
      };
    }
    const R = s.R - s.side * d;
    return R < minR ? null : { ...s, R };
  });
}

function sample(segs, step = 0.04) {
  const out = [];
  segs.forEach((s, i) => {
    if (!s) return;
    const n = Math.max(2, Math.ceil(segLength(s) / step));
    for (let k = 0; k <= n; k += 1)
      out.push({ i, t: k / n, ...evalSeg(s, k / n) });
  });
  return out;
}

/**
 * Splits a chain into the runs where keep(p) holds, as exact sub-primitives.
 * A run that ends inside the field (not on `boundary`) is pulled back by
 * `trim` along its length, so it stops short of what it met.
 */
export function pieces(
  segs,
  keep,
  { boundary = () => false, trim = 0, min = 1 } = {},
) {
  const runs = [];
  let run = [];
  let prev = null;
  for (const s of sample(segs)) {
    const gapInChain = prev && s.i !== prev.i && s.i !== prev.i + 1;
    if (keep(s.p) && !gapInChain) run.push(s);
    else {
      if (run.length > 1) runs.push(run);
      run = keep(s.p) ? [s] : [];
    }
    prev = s;
  }
  if (run.length > 1) runs.push(run);
  const lengthOf = (r) =>
    r.reduce(
      (l, s, k) =>
        k ? l + Math.hypot(s.p[0] - r[k - 1].p[0], s.p[1] - r[k - 1].p[1]) : 0,
      0,
    );
  const back = (r, from, dir) => {
    let k = from;
    let l = 0;
    while (k + dir >= 0 && k + dir < r.length && l < trim) {
      l += Math.hypot(r[k].p[0] - r[k + dir].p[0], r[k].p[1] - r[k + dir].p[1]);
      k += dir;
    }
    return k;
  };
  return runs
    .map((r) => {
      const a = trim && !boundary(r[0].p) ? back(r, 0, 1) : 0;
      const b =
        trim && !boundary(r.at(-1).p)
          ? back(r, r.length - 1, -1)
          : r.length - 1;
      return r.slice(a, b + 1);
    })
    .filter((r) => r.length > 1 && lengthOf(r) >= min)
    .map((r) => ({ segs, from: r[0], to: r.at(-1) }));
}

// The L or A command that draws primitive `s` from parameter t0 to t1.
function segmentCommand(s, t0, t1, d) {
  const end = pt(evalSeg(s, t1).p, d);
  if (s.type === 'line') return `L${end}`;
  const large = Math.abs(s.turn) * (t1 - t0) > Math.PI ? 1 : 0;
  return `A${fmt(s.R, d)} ${fmt(s.R, d)} 0 ${large} ${s.turn > 0 ? 1 : 0} ${end}`;
}

/** Path data for one run: M, then an exact L or A for each primitive. */
export function runData({ segs, from, to }, d = 2) {
  let data = `M${pt(from.p, d)}`;
  for (let i = from.i; i <= to.i; i += 1) {
    const t0 = i === from.i ? from.t : 0;
    const t1 = i === to.i ? to.t : 1;
    if (segs[i] && t1 - t0 >= 1e-6) data += segmentCommand(segs[i], t0, t1, d);
  }
  return data;
}

/** Points along one run, about `step` apart, ends included. */
export function runPoints({ segs, from, to }, step) {
  const out = [];
  for (let i = from.i; i <= to.i; i += 1) {
    const s = segs[i];
    if (!s) continue;
    const t0 = i === from.i ? from.t : 0;
    const t1 = i === to.i ? to.t : 1;
    const n = Math.max(1, Math.ceil((segLength(s) * (t1 - t0)) / step));
    for (let k = out.length ? 1 : 0; k <= n; k += 1)
      out.push(evalSeg(s, t0 + ((t1 - t0) * k) / n).p);
  }
  return out;
}

/** Minimum distance from p to a chain (exact per primitive). */
export function distTo(segs) {
  return (p) => {
    let best = Number.POSITIVE_INFINITY;
    for (const s of segs) {
      if (!s) continue;
      if (s.type === 'line') {
        const v = [s.p1[0] - s.p0[0], s.p1[1] - s.p0[1]];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((p[0] - s.p0[0]) * v[0] + (p[1] - s.p0[1]) * v[1]) /
              (s.len * s.len),
          ),
        );
        best = Math.min(
          best,
          Math.hypot(p[0] - s.p0[0] - v[0] * t, p[1] - s.p0[1] - v[1] * t),
        );
      } else {
        const a = Math.atan2(p[1] - s.c[1], p[0] - s.c[0]);
        const lo = Math.min(s.a0, s.a0 + s.turn);
        const rel = (((a - lo) % TAU) + TAU) % TAU;
        if (rel <= Math.abs(s.turn))
          best = Math.min(
            best,
            Math.abs(Math.hypot(p[0] - s.c[0], p[1] - s.c[1]) - s.R),
          );
        const e0 = evalSeg(s, 0).p;
        const e1 = evalSeg(s, 1).p;
        best = Math.min(
          best,
          Math.hypot(p[0] - e0[0], p[1] - e0[1]),
          Math.hypot(p[0] - e1[0], p[1] - e1[1]),
        );
      }
    }
    return best;
  };
}

// Lead-in, an easing arc, the first bowl, a straight crossing, the second
// bowl, an easing arc, lead-out: point-symmetric about the frame centre, so
// both bowls are the same bowl, with every join tangent.
function walk({ R, sweep, mid, ease, axis, lead }, easeR) {
  const alpha = sweep * ease;
  const t = turtle([0, 0], deg(axis));
  t.line(lead)
    .arc(easeR, deg(alpha))
    .arc(R, -deg(sweep))
    .line(mid)
    .arc(R, deg(sweep))
    .arc(easeR, -deg(alpha))
    .line(lead);
  const m = evalSeg(t.segs[3], 0.5).p;
  return translate(t.segs, [C[0] - m[0], C[1] - m[1]]);
}
// Signed distance from the frame centre to the lead-in line.
const lateral = (segs) => {
  const s = segs[0];
  const v = [Math.cos(s.h), Math.sin(s.h)];
  return (C[0] - s.p0[0]) * -v[1] + (C[1] - s.p0[1]) * v[0];
};

/**
 * The canonical river centreline. The easing arcs turn a fixed share of the
 * bowl's sweep; their radius is solved by bisection so the lead-in and
 * lead-out fall on one line through the centre.
 */
export function centreline(g = CANONICAL) {
  let lo = 0.3;
  let hi = 30;
  const f = (r) => lateral(walk(g, r));
  if (Math.sign(f(lo)) === Math.sign(f(hi)))
    throw new Error('river: no easing radius centres the leads');
  const sign = Math.sign(f(lo));
  for (let k = 0; k < 80; k += 1) {
    const m = (lo + hi) / 2;
    if (Math.sign(f(m)) === sign) lo = m;
    else hi = m;
  }
  const segs = walk(g, (lo + hi) / 2);
  if (Math.abs(lateral(segs)) > 1e-3)
    throw new Error('river: could not centre the leads');
  return segs;
}
