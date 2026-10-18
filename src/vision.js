import { PNG } from 'pngjs';

export const PATCH_SIZE = 40;

// Square clip centred on (x, y), kept inside the viewport.
export function patchClip(x, y, viewport, size = PATCH_SIZE) {
  const w = Math.min(size, viewport.width);
  const h = Math.min(size, viewport.height);
  const left = Math.max(0, Math.min(viewport.width - w, Math.round(x - w / 2)));
  const top = Math.max(0, Math.min(viewport.height - h, Math.round(y - h / 2)));
  return { x: left, y: top, width: w, height: h };
}

// Cuts `clip` out of a full-viewport PNG and returns it as a PNG buffer.
export function cropPng(png, clip) {
  const src = PNG.sync.read(png);
  const out = new PNG({ width: clip.width, height: clip.height });
  for (let row = 0; row < clip.height; row++) {
    const start = ((clip.y + row) * src.width + clip.x) * 4;
    src.data.copy(out.data, row * clip.width * 4, start, start + clip.width * 4);
  }
  return PNG.sync.write(out);
}

// Mean absolute RGB difference (0-255) between two same-sized PNG buffers.
export function patchDiff(pngA, pngB) {
  const a = PNG.sync.read(pngA);
  const b = PNG.sync.read(pngB);
  if (a.width !== b.width || a.height !== b.height) return 255;
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
  }
  return sum / ((a.data.length / 4) * 3);
}

const FLAT_STD = 4;

function luminance(png) {
  const { data } = PNG.sync.read(png);
  const out = new Float64Array(data.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return out;
}

// Normalized cross-correlation of luminance (-1..1), or null when either
// patch is too flat to have a shape. Unlike a colour difference it ignores
// uniform brightness changes, so a button tinted by hover or press still
// matches its normal state, while a different button or screen does not.
// Measured on the real game: matches 0.91-1.00, look-alikes 0.12-0.66.
export function patchSimilarity(pngA, pngB) {
  const a = luminance(pngA);
  const b = luminance(pngB);
  if (a.length !== b.length) return -1;
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a);
  const mb = mean(b);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  const n = a.length;
  if (Math.sqrt(aa / n) < FLAT_STD || Math.sqrt(bb / n) < FLAT_STD) return null;
  return ab / Math.sqrt(aa * bb);
}

// Shape similarity when both patches have a shape; colour difference for flat ones.
export function patchMatch(pngA, pngB, { minSimilarity, maxDiff }) {
  const similarity = patchSimilarity(pngA, pngB);
  if (similarity !== null) return { matched: similarity >= minSimilarity, score: `similarity ${similarity.toFixed(3)}` };
  const diff = patchDiff(pngA, pngB);
  return { matched: diff <= maxDiff, score: `diff ${diff.toFixed(1)}` };
}
