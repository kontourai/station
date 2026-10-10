const RIVER =
  'M132 29 C111 39 89 25 77 39 C55 59 93 67 104 79 C133 107 71 107 58 125 L48 140';
let startedAt: number | undefined;
let firstPaintCleanup: (() => void) | undefined;

const fraction = (value: number) => Math.max(0, Math.min(1, value));
const ease = (value: number) => 1 - (1 - fraction(value)) ** 3;

interface WaterColor {
  red: number;
  green: number;
  blue: number;
}

function waterPaint(color: WaterColor, alpha: number): string {
  return `rgba(${color.red},${color.green},${color.blue},${alpha})`;
}

function trackPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const radius = height / 2;
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

/** Paints the boot surface without owning readiness or delaying its removal. */
export function startStartupAnimation(canvas: HTMLCanvasElement): () => void {
  releaseInitialStartupAnimation();
  const candidate = canvas.getContext('2d');
  const parent = canvas.parentElement;
  if (!candidate || !parent) return () => {};
  const context = candidate;
  const surface = parent;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const guide = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  guide.setAttribute('d', RIVER);
  const length = guide.getTotalLength();
  const layer = document.createElement('canvas');
  layer.width = layer.height = 187;
  const candidateFlow = layer.getContext('2d');
  if (!candidateFlow) return () => {};
  const flowContext = candidateFlow;

  const swatch = document.createElement('span');
  swatch.hidden = true;
  surface.append(swatch);
  let ink = '';
  let track = '';
  let displayFont = '';
  let water: WaterColor;
  let mask: HTMLCanvasElement;
  let image = new Image();
  let ready = false;
  let stopped = false;
  let frameId = 0;
  let lastPaint = 0;

  function readTheme() {
    const styles = getComputedStyle(surface);
    swatch.style.color = 'var(--k-text)';
    ink = getComputedStyle(swatch).color;
    swatch.style.color = 'var(--k-line-strong)';
    track = getComputedStyle(swatch).color;
    displayFont = styles.getPropertyValue('--k-font-display').trim();
  }

  function loadMark() {
    const next = new Image();
    const channel = document.documentElement.dataset.appChannel;
    const variant = document.documentElement.classList.contains('is-dev-build')
      ? 'dev'
      : channel;
    next.src = ['dev', 'beta', 'nightly'].includes(variant ?? '')
      ? `/favicon-${variant}.png`
      : '/favicon.png';
    if (next.src === image.src) return;
    ready = false;
    image = next;
    next.onload = () => {
      if (stopped || image !== next) return;
      mask = document.createElement('canvas');
      mask.width = mask.height = 187;
      const maskContext = mask.getContext('2d');
      if (!maskContext) return;
      maskContext.drawImage(next, 0, 0, 187, 187);
      const pixels = maskContext.getImageData(0, 0, 187, 187);
      const sample = (49 * 187 + 74) * 4;
      water = {
        red: pixels.data[sample],
        green: pixels.data[sample + 1],
        blue: pixels.data[sample + 2],
      };
      for (let index = 0; index < pixels.data.length; index += 4) {
        const distance =
          (pixels.data[index] - water.red) ** 2 +
          (pixels.data[index + 1] - water.green) ** 2 +
          (pixels.data[index + 2] - water.blue) ** 2;
        if (distance > 90 ** 2) pixels.data[index + 3] = 0;
        pixels.data[index] = 255;
        pixels.data[index + 1] = 255;
        pixels.data[index + 2] = 255;
      }
      maskContext.putImageData(pixels, 0, 0);
      ready = true;
      schedule();
    };
    next.onerror = dispose;
  }

  function draw(time: number) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const density = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * density);
    const pixelHeight = Math.round(height * density);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    context.setTransform(density, 0, 0, density, 0, 0);
    context.clearRect(0, 0, width, height);
    const fit = Math.max(
      0.1,
      Math.min(1, (width - 48) / 290, (height - 64) / 256),
    );
    const size = 96 * fit;
    const fontSize = 52 * fit;
    context.font = `500 ${fontSize}px ${displayFont}`;
    context.fontKerning = 'normal';
    const word = 'tation';
    const wordWidth = context.measureText(word).width;
    const gap = 7 * fit;
    const totalWidth = size + gap + wordWidth;
    const destination = (width - totalWidth) / 2;
    const moving = motion.matches ? 1 : ease((time - 0.25) / 0.5);
    const x = (width - size) / 2 + (destination - (width - size) / 2) * moving;
    const y = (height - size) / 2;
    context.drawImage(image, x, y, size, size);
    const textX = x + size + gap;
    for (let index = 0; index < word.length; index++) {
      const visible = motion.matches
        ? 1
        : ease((time - 0.45 - index * 0.05) / 0.25);
      const left =
        index === 0 ? 0 : context.measureText(word.slice(0, index)).width;
      const right =
        index === word.length - 1
          ? wordWidth + 3
          : context.measureText(word.slice(0, index + 1)).width;
      context.save();
      context.beginPath();
      context.rect(textX + left - 1, y, right - left + 2, size);
      context.clip();
      context.globalAlpha = visible;
      context.fillStyle = ink;
      context.fillText(word, textX + 8 * fit * (1 - visible), y + size * 0.65);
      context.restore();
    }

    const scale = size / 187;
    const dropX = x + 46 * scale;
    const lipY = y + 140 * scale;
    const trackY = y + size + 36 * fit;
    const trackX = destination + 18 * fit;
    const trackWidth = totalWidth - 32 * fit;
    const trackHeight = 7 * fit;
    const activity = motion.matches ? 1 : ease((time - 1.05) / 0.2);
    const falling = motion.matches ? 1 : ease((time - 1.05) / 0.55);
    const spread = motion.matches ? 1 : fraction((time - 1.6) / 1.15);
    surface.style.setProperty('--startup-stage-top', `${trackY + 28 * fit}px`);
    if (activity === 0) return;

    context.save();
    context.globalAlpha = activity;
    context.fillStyle = track;
    trackPath(context, trackX, trackY, trackWidth, trackHeight);
    context.fill();
    if (!motion.matches) {
      context.save();
      context.beginPath();
      context.rect(dropX - 20, lipY - 3, 40, (trackY - lipY + 3) * falling);
      context.clip();
      context.strokeStyle = waterPaint(water, 0.65);
      context.lineWidth = 6 * scale;
      context.lineCap = 'round';
      context.beginPath();
      context.moveTo(dropX + 2 * scale, lipY);
      context.bezierCurveTo(
        dropX - 7 * scale,
        lipY + 12 * scale,
        dropX - 2 * scale,
        trackY - 20,
        dropX - 2 * scale,
        trackY,
      );
      context.stroke();
      context.restore();
    }
    const landed = motion.matches ? 1 : fraction((time - 1.6) / 0.18);
    const impactX = dropX - 2 * scale;
    const rightEdge = trackX + trackWidth;
    const reach = impactX + (rightEdge - impactX) * spread;
    context.save();
    trackPath(context, trackX, trackY, trackWidth, trackHeight);
    context.clip();
    context.fillStyle = waterPaint(water, 0.2);
    context.globalAlpha = activity * landed;
    context.fillRect(trackX, trackY, Math.max(0, reach - trackX), trackHeight);
    if (!motion.matches && landed > 0) {
      const waveX =
        spread < 1
          ? reach
          : impactX +
            (rightEdge - impactX) * ((Math.max(0, time - 2.75) * 0.2) % 1);
      const wave = context.createLinearGradient(waveX - 28, 0, waveX + 6, 0);
      wave.addColorStop(0, waterPaint(water, 0));
      wave.addColorStop(0.8, waterPaint(water, 0.8));
      wave.addColorStop(1, waterPaint(water, 0));
      context.fillStyle = wave;
      context.fillRect(waveX - 28, trackY, 34, trackHeight);
    }
    context.restore();
    context.fillStyle = waterPaint(water, 0.6 * landed);
    context.beginPath();
    context.ellipse(
      impactX,
      trackY + trackHeight / 2,
      8 * fit,
      trackHeight / 2,
      0,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();

    if (!motion.matches) {
      flowContext.globalCompositeOperation = 'source-over';
      flowContext.clearRect(0, 0, 187, 187);
      flowContext.strokeStyle = ink;
      flowContext.lineWidth = 0.8;
      flowContext.lineCap = 'round';
      for (let index = 0; index < 10; index++) {
        const position = ((time * 0.078 + index / 10) % 1) * length;
        const from = guide.getPointAtLength(position);
        const to = guide.getPointAtLength(Math.min(position + 5, length));
        flowContext.beginPath();
        flowContext.moveTo(from.x, from.y);
        flowContext.lineTo(to.x, to.y);
        flowContext.stroke();
      }
      flowContext.globalCompositeOperation = 'destination-in';
      flowContext.drawImage(mask, 0, 0);
      context.save();
      context.globalAlpha = activity * 0.45;
      context.drawImage(layer, x, y, size, size);
      context.restore();
    }
  }

  function dispose() {
    stopped = true;
    cancelAnimationFrame(frameId);
    observer.disconnect();
    resize.disconnect();
    motion.removeEventListener('change', schedule);
    document.removeEventListener('visibilitychange', visibility);
    swatch.remove();
    image.onload = null;
    image.onerror = null;
  }

  function frame(now: number) {
    frameId = 0;
    if (stopped || !canvas.isConnected) {
      dispose();
      return;
    }
    if (
      ready &&
      !document.hidden &&
      (motion.matches || now - lastPaint >= 1000 / 30)
    ) {
      startedAt ??= now;
      draw(motion.matches ? 3 : (now - startedAt) / 1000);
      canvas.dataset.ready = 'true';
      lastPaint = now;
    }
    if (!document.hidden && (!ready || !motion.matches)) schedule();
  }

  function schedule() {
    if (!stopped && frameId === 0) frameId = requestAnimationFrame(frame);
  }

  function visibility() {
    cancelAnimationFrame(frameId);
    frameId = 0;
    if (!document.hidden) schedule();
  }

  const observer = new MutationObserver(() => {
    readTheme();
    loadMark();
    schedule();
  });
  observer.observe(document.documentElement, { attributes: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(canvas);
  motion.addEventListener('change', schedule);
  document.addEventListener('visibilitychange', visibility);
  readTheme();
  loadMark();
  void document.fonts.load(`500 52px ${displayFont}`).then(() => {
    schedule();
  });
  return dispose;
}

export function releaseInitialStartupAnimation(): void {
  firstPaintCleanup?.();
  firstPaintCleanup = undefined;
}

const firstPaintCanvas = document.querySelector<HTMLCanvasElement>(
  '#root .station-startup__canvas',
);
if (firstPaintCanvas)
  firstPaintCleanup = startStartupAnimation(firstPaintCanvas);
