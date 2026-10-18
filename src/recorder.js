import { cropPng, patchClip } from './vision.js';

const DRAG_PX = 12;
const FRAME_INTERVAL_MS = 150;
const MODIFIER_KEYS = ['Shift', 'Control', 'Alt', 'Meta'];

// Turns the raw input a Host reports in record mode into replayable steps.
// Each click also stores a snapshot of what was under the cursor, so replay
// can wait until the screen looks the same before clicking there. The
// snapshot comes from a frame grabbed just before the press: one taken after
// the pointerdown event arrives already shows the button's pressed tint.
export function startRecording(host, viewport, log) {
  const steps = [];
  const patches = [];
  let lastEnd = Date.now();
  let down = null;
  let frame = null;
  let active = true;

  (async () => {
    while (active) {
      try {
        frame = await host.page.screenshot();
      } catch {
        // Page busy or navigating; try again next tick.
      }
      await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS));
    }
  })();

  const onInput = (e) => {
    const now = Date.now();
    if (e.kind === 'down') {
      const step = { type: 'click', x: Math.round(e.x), y: Math.round(e.y), holdMs: 80, waitBeforeMs: now - lastEnd };
      steps.push(step);
      down = { x: e.x, y: e.y, t: now, step };
      const clip = patchClip(e.x, e.y, viewport);
      const before = frame;
      // Never a clipped screenshot here: it disturbs Unity's input (see replay.js).
      patches.push((before ? Promise.resolve(before) : host.page.screenshot()).then((full) => cropPng(full, clip))
        .then((buf) => { step.patch = buf.toString('base64'); })
        .catch((err) => log.warn('Patch capture failed:', err.message)));
      log.info(`click #${steps.length} at (${step.x}, ${step.y}) after ${step.waitBeforeMs} ms`);
    } else if (e.kind === 'up' && down) {
      down.step.holdMs = now - down.t;
      if (Math.hypot(e.x - down.x, e.y - down.y) > DRAG_PX) log.warn('That looked like a drag; it will replay as a click where you pressed.');
      down = null;
      lastEnd = now;
    } else if (e.kind === 'key' && !MODIFIER_KEYS.includes(e.key)) {
      steps.push({ type: 'key', key: e.key, waitBeforeMs: now - lastEnd });
      lastEnd = now;
      log.info(`key #${steps.length}: ${e.key}`);
    }
  };
  host.on('input', onInput);

  return {
    steps,
    async finish(meta = {}) {
      active = false;
      host.off('input', onInput);
      await Promise.all(patches);
      return { recordedAt: new Date().toISOString(), viewport, ...meta, steps };
    },
  };
}
