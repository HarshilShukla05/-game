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

// Finds where `template` (a PNG patch) best matches inside a full-viewport PNG,
// by luminance correlation: a coarse scan every `stride` px, then a 1 px
// refinement around the best spot. Returns { x, y, similarity } (x, y = centre).
export function findPatch(fullPng, template, { stride = 4, region } = {}) {
  const full = PNG.sync.read(fullPng);
  const tpl = PNG.sync.read(template);
  const W = full.width;
  const lum = new Float32Array(full.width * full.height);
  for (let i = 0; i < lum.length; i++) lum[i] = 0.299 * full.data[i * 4] + 0.587 * full.data[i * 4 + 1] + 0.114 * full.data[i * 4 + 2];
  const tw = tpl.width;
  const th = tpl.height;
  const n = tw * th;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = 0.299 * tpl.data[i * 4] + 0.587 * tpl.data[i * 4 + 1] + 0.114 * tpl.data[i * 4 + 2];
  const tMean = t.reduce((s, v) => s + v, 0) / n;
  let tVar = 0;
  for (let i = 0; i < n; i++) { t[i] -= tMean; tVar += t[i] * t[i]; }

  const score = (left, top) => {
    let sum = 0;
    let sumSq = 0;
    let dot = 0;
    for (let r = 0; r < th; r++) {
      const row = (top + r) * W + left;
      for (let c = 0; c < tw; c++) {
        const v = lum[row + c];
        sum += v;
        sumSq += v * v;
        dot += v * t[r * tw + c];
      }
    }
    const varI = sumSq - (sum * sum) / n;
    return varI > 1e-6 && tVar > 1e-6 ? dot / Math.sqrt(varI * tVar) : -1;
  };

  const { x0 = 0, y0 = 0, x1 = full.width, y1 = full.height } = region ?? {};
  let best = { left: 0, top: 0, s: -2 };
  for (let top = y0; top + th <= y1; top += stride) {
    for (let left = x0; left + tw <= x1; left += stride) {
      const s = score(left, top);
      if (s > best.s) best = { left, top, s };
    }
  }
  const coarse = best;
  for (let top = Math.max(y0, coarse.top - stride); top <= Math.min(y1 - th, coarse.top + stride); top++) {
    for (let left = Math.max(x0, coarse.left - stride); left <= Math.min(x1 - tw, coarse.left + stride); left++) {
      const s = score(left, top);
      if (s > best.s) best = { left, top, s };
    }
  }
  return { x: best.left + Math.floor(tw / 2), y: best.top + Math.floor(th / 2), similarity: best.s };
}
