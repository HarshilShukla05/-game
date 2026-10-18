import fs from 'node:fs/promises';
import { patchClip, patchDiff } from './vision.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export async function loadRecording(file) {
  let rec;
  try {
    rec = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`No recording at ${file}. Run "npm run calibrate" first.`);
    throw err;
  }
  if (!Array.isArray(rec.steps) || rec.steps.length === 0) throw new Error(`Recording ${file} has no steps`);
  return rec;
}

// Replays a calibrated recording. Before each click it hovers the target and,
// when the recording holds a snapshot of that spot, waits until the screen
// matches it again. A slow load then delays the click instead of wasting it.
// If the screen never matches, it clicks anyway after visualTimeoutMs and
// lets the caller's link timeout decide.
export async function replay(page, rec, opts) {
  const { speed, minGapMs, maxGapMs, visualCheck, visualThreshold, visualTimeoutMs, firstStepTimeoutMs, log, shouldStop = () => false } = opts;
  const vp = page.viewportSize();
  const sameViewport = vp.width === rec.viewport.width && vp.height === rec.viewport.height;
  if (!sameViewport) log.warn(`Viewport ${vp.width}x${vp.height} differs from recording ${rec.viewport.width}x${rec.viewport.height}; scaling clicks, visual check off`);
  const sx = vp.width / rec.viewport.width;
  const sy = vp.height / rec.viewport.height;

  for (const [i, step] of rec.steps.entries()) {
    if (shouldStop()) return;
    // Human pauses (reading, hesitating) are capped; the visual check covers slow loads.
    await sleep(clamp(step.waitBeforeMs * speed, minGapMs, maxGapMs));
    if (shouldStop()) return;

    if (step.type === 'key') {
      await page.keyboard.press(step.key === ' ' ? 'Space' : step.key);
      continue;
    }

    const x = step.x * sx;
    const y = step.y * sy;
    await page.mouse.move(x, y, { steps: 4 });
    if (visualCheck && sameViewport && step.patch) {
      // The game's menu-ready callback fires before Unity's own loading screen
      // is gone, so the first click may have to wait much longer than the rest.
      const timeoutMs = i === 0 ? Math.max(visualTimeoutMs, firstStepTimeoutMs ?? 0) : visualTimeoutMs;
      const matched = await waitForPatch(page, step, rec.viewport, visualThreshold, timeoutMs, shouldStop);
      if (!matched) log.warn(`Step ${i + 1}: screen did not match the recording, clicking anyway`);
    }
    await page.mouse.down();
    await sleep(clamp(step.holdMs ?? 80, 40, 400));
    await page.mouse.up();
  }
}

async function waitForPatch(page, step, viewport, threshold, timeoutMs, shouldStop) {
  const expected = Buffer.from(step.patch, 'base64');
  const clip = patchClip(step.x, step.y, viewport);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !shouldStop()) {
    const shot = await page.screenshot({ clip });
    if (patchDiff(shot, expected) <= threshold) return true;
    await sleep(250);
  }
  return false;
}
