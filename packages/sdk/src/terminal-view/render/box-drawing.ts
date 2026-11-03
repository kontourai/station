/**
 * Box drawing (U+2500–U+257F), block elements (U+2580–U+259F) and the
 * Powerline separators (U+E0B0–U+E0BF) drawn by the renderer at the exact
 * cell size instead of taken from a font. Font glyphs for these rarely
 * match the cell box, which leaves seams between rows and columns; drawn
 * glyphs meet their neighbours pixel for pixel.
 *
 * Coordinates are device pixels inside one cell whose top-left is (0, 0).
 * The caller sets the fill and stroke style; everything here is coverage.
 */

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Arm weights: 0 none, 1 light, 2 heavy, 3 double. Order: up, right, down, left. */
const LINES: Record<number, string> = {
  9472: '0101',
  9473: '0202',
  9474: '1010',
  9475: '2020',
  9484: '0110',
  9485: '0210',
  9486: '0120',
  9487: '0220',
  9488: '0011',
  9489: '0012',
  9490: '0021',
  9491: '0022',
  9492: '1100',
  9493: '1200',
  9494: '2100',
  9495: '2200',
  9496: '1001',
  9497: '1002',
  9498: '2001',
  9499: '2002',
  9500: '1110',
  9501: '1210',
  9502: '2110',
  9503: '1120',
  9504: '2120',
  9505: '2210',
  9506: '1220',
  9507: '2220',
  9508: '1011',
  9509: '1012',
  9510: '2011',
  9511: '1021',
  9512: '2021',
  9513: '2012',
  9514: '1022',
  9515: '2022',
  9516: '0111',
  9517: '0112',
  9518: '0211',
  9519: '0212',
  9520: '0121',
  9521: '0122',
  9522: '0221',
  9523: '0222',
  9524: '1101',
  9525: '1102',
  9526: '1201',
  9527: '1202',
  9528: '2101',
  9529: '2102',
  9530: '2201',
  9531: '2202',
  9532: '1111',
  9533: '1112',
  9534: '1211',
  9535: '1212',
  9536: '2111',
  9537: '1121',
  9538: '2121',
  9539: '2112',
  9540: '2211',
  9541: '1122',
  9542: '1221',
  9543: '2212',
  9544: '1222',
  9545: '2122',
  9546: '2221',
  9547: '2222',
  9552: '0303',
  9553: '3030',
  9554: '0310',
  9555: '0130',
  9556: '0330',
  9557: '0013',
  9558: '0031',
  9559: '0033',
  9560: '1300',
  9561: '3100',
  9562: '3300',
  9563: '1003',
  9564: '3001',
  9565: '3003',
  9566: '1310',
  9567: '3130',
  9568: '3330',
  9569: '1013',
  9570: '3031',
  9571: '3033',
  9572: '0313',
  9573: '0131',
  9574: '0333',
  9575: '1303',
  9576: '3101',
  9577: '3303',
  9578: '1313',
  9579: '3131',
  9580: '3333',
  9588: '0001',
  9589: '1000',
  9590: '0100',
  9591: '0010',
  9592: '0002',
  9593: '2000',
  9594: '0200',
  9595: '0020',
  9596: '0201',
  9597: '1020',
  9598: '0102',
  9599: '2010',
};

/** Dashed lines: [vertical, heavy, dash count]. */
const DASHES: Record<number, [boolean, boolean, number]> = {
  9476: [false, false, 3],
  9477: [false, true, 3],
  9478: [true, false, 3],
  9479: [true, true, 3],
  9480: [false, false, 4],
  9481: [false, true, 4],
  9482: [true, false, 4],
  9483: [true, true, 4],
  9548: [false, false, 2],
  9549: [false, true, 2],
  9550: [true, false, 2],
  9551: [true, true, 2],
};

export function isDrawnGlyph(cp: number): boolean {
  return (cp >= 0x2500 && cp <= 0x259f) || (cp >= 0xe0b0 && cp <= 0xe0bf);
}

export interface DrawnCell {
  width: number;
  height: number;
}

function strokes(cell: DrawnCell) {
  const light = Math.max(1, Math.round(cell.height / 18));
  return { light, heavy: light * 2, gap: light };
}

function drawLines(ctx: Ctx, arms: string, cell: DrawnCell): void {
  const { light, heavy, gap } = strokes(cell);
  const w = cell.width;
  const h = cell.height;
  const [up, right, down, left] = [...arms].map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const width = (weight: number) => (weight === 2 ? heavy : light);
  const vRect = (x: number, y0: number, y1: number, t: number) =>
    ctx.fillRect(x - Math.floor(t / 2), Math.min(y0, y1), t, Math.abs(y1 - y0));
  const hRect = (y: number, x0: number, x1: number, t: number) =>
    ctx.fillRect(Math.min(x0, x1), y - Math.floor(t / 2), Math.abs(x1 - x0), t);

  const hasDouble = (a: number, b: number) => a === 3 || b === 3;
  const hasSingle = (a: number, b: number) =>
    (a === 1 || a === 2 || b === 1 || b === 2) && !hasDouble(a, b);
  const vDouble = hasDouble(up, down);
  const hDouble = hasDouble(left, right);
  const vSingle = hasSingle(up, down);
  const hSingle = hasSingle(left, right);
  const halfMax = Math.ceil(
    Math.max(width(up), width(down), width(left), width(right)) / 2,
  );

  // Light and heavy arms run to the centre, or to the double line they meet.
  const singleStop = (
    toward: -1 | 1,
    perpendicularBoth: boolean,
    perpendicularDouble: boolean,
    c: number,
  ) => {
    if (!perpendicularDouble) return c - toward * halfMax;
    return perpendicularBoth ? c + toward * gap : c - toward * gap;
  };
  if (up === 1 || up === 2)
    vRect(
      cx,
      0,
      singleStop(-1, left === 3 && right === 3, hDouble, cy),
      width(up),
    );
  if (down === 1 || down === 2)
    vRect(
      cx,
      h,
      singleStop(1, left === 3 && right === 3, hDouble, cy),
      width(down),
    );
  if (left === 1 || left === 2)
    hRect(
      cy,
      0,
      singleStop(-1, up === 3 && down === 3, vDouble, cx),
      width(left),
    );
  if (right === 1 || right === 2)
    hRect(
      cy,
      w,
      singleStop(1, up === 3 && down === 3, vDouble, cx),
      width(right),
    );

  // Each double arm is two lines; each line stops where its corner turns.
  const stop = (
    sideArm: number,
    near: number,
    far: number,
    crossSingle: boolean,
    c: number,
  ) => (crossSingle ? c : sideArm === 3 ? near : far);
  if (up === 3) {
    vRect(
      cx - gap,
      0,
      stop(left, cy - gap, cy + gap, hSingle, cy) + light,
      light,
    );
    vRect(
      cx + gap,
      0,
      stop(right, cy - gap, cy + gap, hSingle, cy) + light,
      light,
    );
  }
  if (down === 3) {
    vRect(cx - gap, h, stop(left, cy + gap, cy - gap, hSingle, cy), light);
    vRect(cx + gap, h, stop(right, cy + gap, cy - gap, hSingle, cy), light);
  }
  if (left === 3) {
    hRect(
      cy - gap,
      0,
      stop(up, cx - gap, cx + gap, vSingle, cx) + light,
      light,
    );
    hRect(
      cy + gap,
      0,
      stop(down, cx - gap, cx + gap, vSingle, cx) + light,
      light,
    );
  }
  if (right === 3) {
    hRect(cy - gap, w, stop(up, cx + gap, cx - gap, vSingle, cx), light);
    hRect(cy + gap, w, stop(down, cx + gap, cx - gap, vSingle, cx), light);
  }
}

function drawDashes(
  ctx: Ctx,
  [vertical, heavy, count]: [boolean, boolean, number],
  cell: DrawnCell,
) {
  const { light, heavy: heavyWidth } = strokes(cell);
  const t = heavy ? heavyWidth : light;
  const length = vertical ? cell.height : cell.width;
  const segment = length / count;
  const dash = Math.max(1, Math.round(segment * 0.6));
  for (let i = 0; i < count; i += 1) {
    const start = Math.round(i * segment + (segment - dash) / 2);
    if (vertical)
      ctx.fillRect(
        Math.floor(cell.width / 2) - Math.floor(t / 2),
        start,
        t,
        dash,
      );
    else
      ctx.fillRect(
        start,
        Math.floor(cell.height / 2) - Math.floor(t / 2),
        dash,
        t,
      );
  }
}

function drawArc(ctx: Ctx, cp: number, cell: DrawnCell): void {
  const { light } = strokes(cell);
  const cx = Math.floor(cell.width / 2) + (light % 2 ? 0.5 : 0);
  const cy = Math.floor(cell.height / 2) + (light % 2 ? 0.5 : 0);
  const r = Math.min(cell.width, cell.height) / 2;
  ctx.lineWidth = light;
  ctx.beginPath();
  // ╭ ╮ ╯ ╰ : join two edge midpoints through a rounded corner.
  const [ex, ey] =
    cp === 0x256d
      ? [cell.width, cell.height]
      : cp === 0x256e
        ? [0, cell.height]
        : cp === 0x256f
          ? [0, 0]
          : [cell.width, 0];
  ctx.moveTo(cx, ey);
  ctx.arcTo(cx, cy, ex, cy, r);
  ctx.lineTo(ex, cy);
  ctx.stroke();
}

function drawDiagonal(ctx: Ctx, cp: number, cell: DrawnCell): void {
  ctx.lineWidth = strokes(cell).light;
  ctx.beginPath();
  if (cp === 0x2571 || cp === 0x2573) {
    ctx.moveTo(cell.width, 0);
    ctx.lineTo(0, cell.height);
  }
  if (cp === 0x2572 || cp === 0x2573) {
    ctx.moveTo(0, 0);
    ctx.lineTo(cell.width, cell.height);
  }
  ctx.stroke();
}

function drawBlock(ctx: Ctx, cp: number, cell: DrawnCell): void {
  const w = cell.width;
  const h = cell.height;
  const eighthH = (n: number) => Math.round((h * n) / 8);
  const eighthW = (n: number) => Math.round((w * n) / 8);
  const hw = Math.round(w / 2);
  const hh = Math.round(h / 2);
  if (cp === 0x2580) {
    ctx.fillRect(0, 0, w, hh);
    return;
  }
  if (cp >= 0x2581 && cp <= 0x2588) {
    const top = h - eighthH(cp - 0x2580);
    ctx.fillRect(0, top, w, h - top);
    return;
  }
  if (cp >= 0x2589 && cp <= 0x258f) {
    ctx.fillRect(0, 0, eighthW(0x2590 - cp), h);
    return;
  }
  if (cp === 0x2590) {
    ctx.fillRect(hw, 0, w - hw, h);
    return;
  }
  if (cp >= 0x2591 && cp <= 0x2593) {
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * (cp - 0x2590) * 0.25;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = alpha;
    return;
  }
  if (cp === 0x2594) {
    ctx.fillRect(0, 0, w, eighthH(1));
    return;
  }
  if (cp === 0x2595) {
    ctx.fillRect(w - eighthW(1), 0, eighthW(1), h);
    return;
  }
  // Quadrants: bits are upper-left, upper-right, lower-left, lower-right.
  const quadrants: Record<number, number> = {
    9622: 0b0010,
    9623: 0b0001,
    9624: 0b1000,
    9625: 0b1011,
    9626: 0b1001,
    9627: 0b1110,
    9628: 0b1101,
    9629: 0b0100,
    9630: 0b0110,
    9631: 0b0111,
  };
  const bits = quadrants[cp] ?? 0;
  if (bits & 0b1000) ctx.fillRect(0, 0, hw, hh);
  if (bits & 0b0100) ctx.fillRect(hw, 0, w - hw, hh);
  if (bits & 0b0010) ctx.fillRect(0, hh, hw, h - hh);
  if (bits & 0b0001) ctx.fillRect(hw, hh, w - hw, h - hh);
}

function drawPowerline(ctx: Ctx, cp: number, cell: DrawnCell): void {
  const w = cell.width;
  const h = cell.height;
  const solid = cp % 2 === 0;
  ctx.lineWidth = strokes(cell).light;
  ctx.beginPath();
  switch (cp & ~1) {
    case 0xe0b0: // right-pointing triangle
      ctx.moveTo(0, 0);
      ctx.lineTo(w, h / 2);
      ctx.lineTo(0, h);
      break;
    case 0xe0b2: // left-pointing triangle
      ctx.moveTo(w, 0);
      ctx.lineTo(0, h / 2);
      ctx.lineTo(w, h);
      break;
    case 0xe0b4: // right half circle
      ctx.moveTo(0, 0);
      ctx.ellipse(0, h / 2, w, h / 2, 0, -Math.PI / 2, Math.PI / 2);
      break;
    case 0xe0b6: // left half circle
      ctx.moveTo(w, 0);
      ctx.ellipse(w, h / 2, w, h / 2, 0, -Math.PI / 2, Math.PI / 2, true);
      break;
    case 0xe0b8: // lower-left triangle
      ctx.moveTo(0, 0);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      break;
    case 0xe0ba: // lower-right triangle
      ctx.moveTo(w, 0);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      break;
    case 0xe0bc: // upper-left triangle
      ctx.moveTo(0, 0);
      ctx.lineTo(w, 0);
      ctx.lineTo(0, h);
      break;
    case 0xe0be: // upper-right triangle
      ctx.moveTo(0, 0);
      ctx.lineTo(w, 0);
      ctx.lineTo(w, h);
      break;
  }
  if (solid) {
    ctx.closePath();
    ctx.fill();
  } else ctx.stroke();
}

/**
 * Draws `cp` into a cell at the context origin. Returns false when the code
 * point is not one this module draws (the caller falls back to the font).
 */
export function drawGlyph(ctx: Ctx, cp: number, cell: DrawnCell): boolean {
  const lines = LINES[cp];
  if (lines) {
    drawLines(ctx, lines, cell);
    return true;
  }
  const dashes = DASHES[cp];
  if (dashes) {
    drawDashes(ctx, dashes, cell);
    return true;
  }
  if (cp >= 0x256d && cp <= 0x2570) {
    drawArc(ctx, cp, cell);
    return true;
  }
  if (cp >= 0x2571 && cp <= 0x2573) {
    drawDiagonal(ctx, cp, cell);
    return true;
  }
  if (cp >= 0x2580 && cp <= 0x259f) {
    drawBlock(ctx, cp, cell);
    return true;
  }
  if (cp >= 0xe0b0 && cp <= 0xe0bf) {
    drawPowerline(ctx, cp, cell);
    return true;
  }
  return false;
}
