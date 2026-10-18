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
