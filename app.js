'use strict';

// Glitch Playground
// Everything runs in the browser: the imported image is kept untouched in memory
// and every preview or export is computed again from that original.

const PREVIEW_MAX_SIDE = 1280; // the live preview works on a copy no larger than this
const SOURCE_MAX_PIXELS = 12_000_000; // larger images are scaled down once, on import

const DEFAULTS = Object.freeze({
  intensity: 70,
  rgb: 0,
  displacement: 0,
  noise: 0,
  frequency: 40,
  rgbOn: true,
  displacementOn: true,
  noiseOn: true,
});

const SLIDERS = ['intensity', 'rgb', 'displacement', 'noise', 'frequency'];
const TOGGLES = ['rgb', 'displacement', 'noise'];

const state = {
  params: { ...DEFAULTS },
  seed: 0x51a7c0de,
  source: null, // { canvas, name, width, height } full-size original
  preview: null, // { input: ImageData, output: ImageData }
  comparing: false,
  busy: false,
  frame: 0,
};

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'),
  empty: $('empty'),
  output: $('output'),
  busy: $('busy'),
  readout: $('readout'),
  file: $('file'),
  toast: $('toast'),
  exportButton: $('export'),
  compare: $('compare'),
};
const outputCtx = ui.output.getContext('2d');

// ---------------------------------------------------------------------------
// Random numbers
// ---------------------------------------------------------------------------

// Seeded generator (mulberry32). The same seed always gives the same glitch,
// so the pattern stays put while a slider moves and the export matches the preview.
function createRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stateless hash of a pixel position: random-looking, but identical on every render.
function hash(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

// Turns the panel settings into effect strengths between 0 and 1.
function effectStrengths(params) {
  const k = params.intensity / 100;
  return {
    separation: params.rgbOn ? (params.rgb / 1000) * k : 0, // fraction of the image width
    displacement: params.displacementOn ? (params.displacement / 100) * k : 0,
    noise: params.noiseOn ? (params.noise / 100) * k : 0,
    frequency: params.frequency / 100,
  };
}

const isUntouched = (fx) => fx.separation === 0 && fx.displacement === 0 && fx.noise === 0;

// For every row: how far it slides sideways and how far its color channels split.
// Bands are described as fractions of the image, so any resolution gives the same layout.
function buildRows(width, height, fx, seed) {
  const shift = new Int32Array(height);
  const split = new Int32Array(height).fill(Math.round(fx.separation * width));
  if (fx.displacement === 0) return { shift, split };

  const random = createRandom(seed);
  const bands = Math.round(3 + fx.frequency * 42);
  const hairlines = Math.round(fx.frequency * 70);

  for (let i = 0; i < bands + hairlines; i++) {
    const hairline = i >= bands;
    const tall = !hairline && random() < 0.25;
    const top = random();
    const size = hairline ? 0.0025 : tall ? 0.04 + random() * 0.14 : 0.004 + random() * 0.03;
    const reach = hairline ? 0.12 : tall ? 0.14 : 0.3;
    const amount = (random() * 2 - 1) * fx.displacement * reach;
    const extraSplit = random() < 0.3 ? random() * fx.separation * 2 : 0;

    const start = Math.floor(top * height);
    const end = Math.min(height, start + Math.max(1, Math.round(size * height)));
    const pixels = Math.round(amount * width);
    const splitPixels = Math.round(extraSplit * width);
    for (let y = start; y < end; y++) {
      shift[y] += pixels;
      split[y] += splitPixels;
    }
  }

  const limit = width - 1;
  for (let y = 0; y < height; y++) {
    shift[y] = Math.max(-limit, Math.min(limit, shift[y]));
  }
  return { shift, split };
}

// Displacement and RGB separation in a single pass over the pixels.
// Each output pixel reads red, green and blue from three different places in its source row.
function applyDisplacement(src, dst, width, height, rows) {
  const last = width - 1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    const dx = rows.shift[y];
    const sp = rows.split[y];
    if (dx === 0 && sp === 0) {
      dst.set(src.subarray(row, row + width * 4), row);
      continue;
    }
    for (let x = 0; x < width; x++) {
      // A shifted row wraps around: what leaves on one side comes back on the other.
      let sx = x - dx;
      if (sx < 0) sx += width;
      else if (sx > last) sx -= width;
      const xr = sx - sp < 0 ? 0 : sx - sp;
      const xb = sx + sp > last ? last : sx + sp;
      const o = row + x * 4;
      dst[o] = src[row + xr * 4];
      dst[o + 1] = src[row + sx * 4 + 1];
      dst[o + 2] = src[row + xb * 4 + 2];
      dst[o + 3] = src[row + sx * 4 + 3];
    }
  }
}

const SPECK_COLORS = [
  [255, 255, 255],
  [198, 255, 61],
  [255, 43, 214],
  [0, 0, 0],
];

// Grain, dead pixels and scanlines. `cell` is the size of one noise dot in pixels:
// 1 in the preview, larger in a full-size export so the grain keeps the same look.
function applyNoise(dst, width, height, fx, seed, cell) {
  const grain = fx.noise * 105;
  const speckLimit = Math.floor(fx.noise * fx.noise * (0.004 + fx.frequency * 0.03) * 65535);
  const scanline = 1 - fx.noise * 0.24;

  for (let y = 0; y < height; y++) {
    const cy = (y / cell) | 0;
    const shade = cy & 1 ? scanline : 1;
    for (let x = 0; x < width; x++) {
      const h = hash((x / cell) | 0, cy, seed);
      const o = (y * width + x) * 4;
      if (h >>> 16 < speckLimit) {
        const color = SPECK_COLORS[h & 3];
        dst[o] = color[0];
        dst[o + 1] = color[1];
        dst[o + 2] = color[2];
      } else {
        // Uint8ClampedArray keeps the result between 0 and 255 for us.
        const n = (((h & 255) - 128) / 128) * grain;
        dst[o] = (dst[o] + n) * shade;
        dst[o + 1] = (dst[o + 1] + n) * shade;
        dst[o + 2] = (dst[o + 2] + n) * shade;
      }
    }
  }
}

// Rectangles of corrupted data: inverted, reduced to one channel, crushed to a few
// colors, or smeared from their first column like a failed video block.
function applyBlocks(dst, width, height, fx, seed) {
  const random = createRandom(seed ^ 0x9e3779b9);
  const count = Math.round(fx.noise * (2 + fx.frequency * 24));

  for (let i = 0; i < count; i++) {
    const bw = Math.max(2, Math.round((0.03 + random() * 0.22) * width));
    const bh = Math.max(1, Math.round((0.006 + random() * 0.05) * height));
    const x0 = Math.max(0, Math.floor(random() * (width - bw)));
    const y0 = Math.max(0, Math.floor(random() * (height - bh)));
    const mode = Math.floor(random() * 4);
    const channel = Math.floor(random() * 3);

    const yEnd = Math.min(height, y0 + bh);
    const columns = Math.min(bw, width - x0);
    for (let y = y0; y < yEnd; y++) {
      const first = (y * width + x0) * 4;
      for (let x = 0; x < columns; x++) {
        const o = first + x * 4;
        if (mode === 0) {
          dst[o] = 255 - dst[o];
          dst[o + 1] = 255 - dst[o + 1];
          dst[o + 2] = 255 - dst[o + 2];
        } else if (mode === 1) {
          const keep = dst[o + channel];
          dst[o] = dst[o + 1] = dst[o + 2] = 0;
          dst[o + channel] = Math.min(255, keep * 1.4 + 20);
        } else if (mode === 2) {
          dst[o] = (dst[o] >> 6) << 6;
          dst[o + 1] = Math.min(255, ((dst[o + 1] >> 6) << 6) + 40);
          dst[o + 2] = (dst[o + 2] >> 6) << 6;
        } else {
          dst[o] = dst[first];
          dst[o + 1] = dst[first + 1];
          dst[o + 2] = dst[first + 2];
        }
      }
    }
  }
}

// The whole pipeline. `input` is never modified; `output` is fully rewritten.
function renderGlitch(input, output, params, seed, cell = 1) {
  const { width, height } = input;
  const fx = effectStrengths(params);

  if (isUntouched(fx)) {
    output.data.set(input.data);
    return;
  }

  applyDisplacement(input.data, output.data, width, height, buildRows(width, height, fx, seed));
  if (fx.noise > 0) {
    applyNoise(output.data, width, height, fx, seed, cell);
    applyBlocks(output.data, width, height, fx, seed);
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

// Many slider events can fire between two screen refreshes: render once per frame at most.
function schedulePreview() {
  if (state.frame || !state.preview) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    drawPreview();
  });
}

function drawPreview() {
  const { input, output } = state.preview;
  const started = performance.now();

  if (state.comparing) {
    outputCtx.putImageData(input, 0, 0);
  } else {
    renderGlitch(input, output, state.params, state.seed);
    outputCtx.putImageData(output, 0, 0);
  }

  const untouched = state.comparing || isUntouched(effectStrengths(state.params));
  const stateLabel = $('r-state');
  stateLabel.textContent = untouched ? 'Original' : 'Glitched';
  stateLabel.classList.toggle('is-live', !untouched);
  $('r-time').textContent = `${(performance.now() - started).toFixed(1)} ms`;
}

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

async function decodeFile(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Some formats (SVG for instance) only decode through an <img> element.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The image could not be decoded.'));
    };
    image.src = url;
  });
}

async function loadFile(file) {
  if (!file || state.busy) return;
  if (file.type && !file.type.startsWith('image/')) {
    showToast(`"${file.name}" is not an image. Try a PNG, JPEG or WebP file.`, true);
    return;
  }

  setBusy('Decoding image');
  await nextPaint();
  try {
    const image = await decodeFile(file);
    setSource(image, file.name);
    if (image.close) image.close();
  } catch {
    showToast(`"${file.name}" could not be read as an image.`, true);
  } finally {
    setBusy(null);
  }
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

// Stores the original and prepares the smaller working copy used by the preview.
function setSource(image, name) {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  if (!naturalWidth || !naturalHeight) throw new Error('The image has no size.');

  const fit = Math.min(1, Math.sqrt(SOURCE_MAX_PIXELS / (naturalWidth * naturalHeight)));
  const width = Math.max(1, Math.round(naturalWidth * fit));
  const height = Math.max(1, Math.round(naturalHeight * fit));
  const canvas = createCanvas(width, height);
  canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0, width, height);

  const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(width, height));
  const previewWidth = Math.max(1, Math.round(width * scale));
  const previewHeight = Math.max(1, Math.round(height * scale));
  const small = createCanvas(previewWidth, previewHeight);
  const smallCtx = small.getContext('2d', { willReadFrequently: true });
  smallCtx.imageSmoothingQuality = 'high';
  smallCtx.drawImage(canvas, 0, 0, previewWidth, previewHeight);

  if (state.source) state.source.canvas.width = 0; // release the previous image
  state.source = { canvas, name, width, height };
  state.preview = {
    input: smallCtx.getImageData(0, 0, previewWidth, previewHeight),
    output: new ImageData(previewWidth, previewHeight),
  };
  small.width = 0;

  ui.output.width = previewWidth;
  ui.output.height = previewHeight;
  ui.empty.hidden = true;
  ui.output.hidden = false;
  ui.readout.hidden = false;
  ui.exportButton.disabled = false;

  $('r-name').textContent = name;
  $('r-name').title = name;
  $('r-size').textContent =
    fit < 1 ? `${width} × ${height} (from ${naturalWidth} × ${naturalHeight})` : `${width} × ${height}`;
  updateSeedLabel();
  schedulePreview();
}

// A generated picture, for trying the effects without a file.
function loadTestPattern() {
  const width = 1600;
  const height = 1000;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, width, height);
  sky.addColorStop(0, '#1b1f3a');
  sky.addColorStop(0.5, '#7a2f5c');
  sky.addColorStop(1, '#f2a65a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  const sun = ctx.createRadialGradient(1080, 420, 20, 1080, 420, 330);
  sun.addColorStop(0, '#fff6d6');
  sun.addColorStop(0.45, '#ffb347');
  sun.addColorStop(1, 'rgba(255,120,80,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, width, height);

  ['#f4f4f4', '#f6e53a', '#3de0e0', '#4ade5b', '#e04ad8', '#e5484d', '#3d5af1'].forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(110 + i * 62, 120, 62, 250);
  });

  ctx.fillStyle = '#0d0f16';
  ctx.beginPath();
  ctx.moveTo(0, 1000);
  ctx.lineTo(0, 760);
  ctx.lineTo(330, 560);
  ctx.lineTo(610, 730);
  ctx.lineTo(900, 500);
  ctx.lineTo(1250, 760);
  ctx.lineTo(1600, 640);
  ctx.lineTo(1600, 1000);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 3;
  for (let r = 60; r <= 180; r += 60) {
    ctx.beginPath();
    ctx.arc(1330, 210, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 118px Helvetica, Arial, sans-serif';
  ctx.fillText('TEST PATTERN', 104, 900);
  ctx.font = '500 30px Menlo, Consolas, monospace';
  ctx.fillText('GLITCH/PLAYGROUND  1600 × 1000', 110, 946);

  setSource(canvas, 'test-pattern');
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

// Writes the current settings back into the sliders, numbers and switches.
function syncControls() {
  for (const name of SLIDERS) {
    const input = $(name);
    input.value = state.params[name];
    $(`${name}-out`).textContent = state.params[name];
    const percent = ((state.params[name] - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--fill', `${percent}%`);
  }
  for (const name of TOGGLES) {
    const on = state.params[`${name}On`];
    $(`${name}-on`).checked = on;
    document.querySelector(`[data-effect="${name}"]`).classList.toggle('is-off', !on);
  }
}

function updateSeedLabel() {
  $('r-seed').textContent = (state.seed >>> 16).toString(16).toUpperCase().padStart(4, '0');
}

function newSeed() {
  state.seed = (Math.random() * 0xffffffff) >>> 0;
  updateSeedLabel();
}

function resetEffects() {
  state.params = { ...DEFAULTS };
  syncControls();
  schedulePreview();
}

function randomize() {
  const between = (min, max) => Math.round(min + Math.random() * (max - min));
  const params = {
    intensity: between(55, 100),
    rgb: between(6, 46),
    displacement: between(15, 90),
    noise: Math.round(Math.pow(Math.random(), 1.6) * 70),
    frequency: between(15, 85),
    rgbOn: Math.random() < 0.85,
    displacementOn: Math.random() < 0.85,
    noiseOn: Math.random() < 0.75,
  };
  // Never land on a result that looks like the untouched image.
  if (!params.rgbOn && !params.displacementOn) params.displacementOn = true;

  state.params = params;
  newSeed();
  syncControls();
  schedulePreview();
}

function bindControls() {
  for (const name of SLIDERS) {
    $(name).addEventListener('input', (event) => {
      state.params[name] = Number(event.target.value);
      syncControls();
      schedulePreview();
    });
  }
  for (const name of TOGGLES) {
    $(`${name}-on`).addEventListener('change', (event) => {
      state.params[`${name}On`] = event.target.checked;
      syncControls();
      schedulePreview();
    });
  }

  const actions = {
    reset: resetEffects,
    randomize,
    pick: () => ui.file.click(),
    sample: loadTestPattern,
    reseed: () => {
      newSeed();
      schedulePreview();
    },
  };
  document.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', actions[button.dataset.action]);
  });

  ui.exportButton.addEventListener('click', exportPng);
  ui.file.addEventListener('change', () => {
    loadFile(ui.file.files[0]);
    ui.file.value = ''; // lets the same file be chosen again
  });
}

// Hold the button (mouse, touch or keyboard) to see the original image.
function bindCompare() {
  const set = (on) => {
    if (state.comparing === on) return;
    state.comparing = on;
    ui.compare.classList.toggle('is-held', on);
    schedulePreview();
  };
  ui.compare.addEventListener('pointerdown', (event) => {
    ui.compare.setPointerCapture(event.pointerId);
    set(true);
  });
  for (const type of ['pointerup', 'pointercancel', 'blur']) {
    ui.compare.addEventListener(type, () => set(false));
  }
  ui.compare.addEventListener('keydown', (event) => {
    if (event.key === ' ' || event.key === 'Enter') set(true);
  });
  ui.compare.addEventListener('keyup', () => set(false));
  ui.compare.addEventListener('contextmenu', (event) => event.preventDefault());
}

function bindDropAndPaste() {
  let depth = 0; // dragenter and dragleave also fire for child elements
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    depth++;
    ui.stage.classList.add('is-dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) ui.stage.classList.remove('is-dragging');
  });
  // Without this the browser would navigate away to the dropped file.
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    ui.stage.classList.remove('is-dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  window.addEventListener('paste', (event) => {
    const file = [...(event.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) loadFile(file);
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `glitch-playground-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.png`;
}

// Renders the effects again on the full-size original, then downloads the result.
async function exportPng() {
  if (!state.source || state.busy) return;
  setBusy('Rendering full resolution');
  await nextPaint();

  let canvas = null;
  try {
    const { canvas: source, width, height } = state.source;
    const input = source.getContext('2d').getImageData(0, 0, width, height);
    const output = new ImageData(width, height);
    const cell = Math.max(1, Math.round(width / state.preview.input.width));
    renderGlitch(input, output, state.params, state.seed, cell);

    canvas = createCanvas(width, height);
    canvas.getContext('2d').putImageData(output, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The browser could not encode the PNG.');

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = exportName();
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    showToast(`Saved ${link.download} (${width} × ${height})`);
  } catch {
    showToast('The export failed. The image may be too large for this device.', true);
  } finally {
    if (canvas) canvas.width = 0;
    setBusy(null);
  }
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

function setBusy(message) {
  state.busy = Boolean(message);
  ui.busy.hidden = !message;
  ui.busy.textContent = message || '';
  ui.exportButton.disabled = state.busy || !state.source;
}

// Gives the browser a chance to paint the busy message before heavy work starts.
function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

let toastTimer = 0;
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.toggle('is-error', isError);
  ui.toast.hidden = false;
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 4500);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

bindControls();
bindCompare();
bindDropAndPaste();
syncControls();
