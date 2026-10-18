import fs from 'node:fs/promises';
import path from 'node:path';
import { cropPng, findPatch, patchClip, patchMatch } from './vision.js';

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

// Expands the recording's option steps for one room:
//  - { type: 'timer' } -> presses of the Round Timer arrow. The game offers
//    lengths that cycle (3 -> 6 -> 10 -> 20 -> 3) and a freshly loaded page
//    always starts at timer.startMinutes.
//  - { type: 'teams' } -> a click on the (unticked) Teams box, or nothing.
// The invite link is checked afterwards, so a miscount never reaches the group.
export function withOptions(rec, { minutes, teams = false } = {}, timer) {
  const want = minutes ?? timer.startMinutes;
  const to = timer.options.indexOf(want);
  if (to < 0) throw new Error(`Round length must be one of ${timer.options.join(', ')} minutes`);
  const presses = (to - timer.options.indexOf(timer.startMinutes) + timer.options.length) % timer.options.length;
  const recalibrate = (what) => new Error(`The recording has no ${what} step; run "npm run calibrate" again`);
  if (presses > 0 && !(rec.timer && rec.steps.some((s) => s.type === 'timer'))) throw recalibrate('round-timer');
  if (teams && !(rec.teamsBox && rec.steps.some((s) => s.type === 'teams'))) throw recalibrate('teams');

  const steps = rec.steps.flatMap((s) => {
    if (s.type === 'timer') {
      const arrow = { type: 'click', x: rec.timer.x, y: rec.timer.y, patch: rec.timer.patch, holdMs: 80, waitBeforeMs: 800 };
      return Array.from({ length: presses }, () => ({ ...arrow }));
    }
    if (s.type === 'teams') return teams ? [{ type: 'click', holdMs: 80, waitBeforeMs: 800, ...rec.teamsBox }] : [];
    return [s];
  });
  return { ...rec, steps };
}

// Replays a calibrated recording. Before each click it hovers the target and,
// when the recording holds a snapshot of that spot, waits until the screen
// matches it again. A slow load then delays the click instead of wasting it.
// After each click it waits for the next step's spot to appear, and clicks
// again while the clicked spot still looks untouched: the game sometimes
// shows a screen before it accepts input, and swallows the click.
// If a spot never matches: with strictVisual the replay fails (a click on the
// wrong thing could build a wrong room), otherwise it clicks anyway.
// While waiting, known popups (rec.popups: a close button and its snapshot,
// e.g. the game's "Check out our NEW GAME" promo) are closed when they show.
// The game also rotates nag screens over its menu (promos, "Sign In"); their
// close buttons all look alike (0.90-0.99 similar), so while waiting for the
// first step (the bare main menu) any close button found on screen
// (rec.closeButton) is clicked too. Later steps have close buttons of their
// own dialogs, so this only runs before the first click.
export async function replay(page, rec, opts) {
  const {
    speed, minGapMs, maxGapMs, visualCheck, strictVisual, minSimilarity, visualThreshold,
    visualTimeoutMs, reclickMs, clickDelayMs = 0, firstStepTimeoutMs, debugDir, log, shouldStop = () => false,
  } = opts;
  // With debugDir, a full screenshot is saved before every click and re-click.
  const snap = async (name) => {
    if (debugDir) await page.screenshot({ path: path.join(debugDir, `${name}.png`) }).catch(() => {});
  };
  const vp = page.viewportSize();
  const sameViewport = vp.width === rec.viewport.width && vp.height === rec.viewport.height;
  if (!sameViewport) log.warn(`Viewport ${vp.width}x${vp.height} differs from recording ${rec.viewport.width}x${rec.viewport.height}; scaling clicks, visual check off`);
  const sx = vp.width / rec.viewport.width;
  const sy = vp.height / rec.viewport.height;
  const checks = visualCheck && sameViewport;
  const match = { minSimilarity, maxDiff: visualThreshold };
  // The game's menu-ready callback fires before the menu takes input, so the
  // first click may need much longer than the rest.
  const timeoutFor = (i) => (i === 0 ? Math.max(visualTimeoutMs, firstStepTimeoutMs ?? 0) : visualTimeoutMs);
  const popups = rec.popups ?? [];
  const onPopup = (popup) => log.warn(`Closing popup "${popup.name}"`);
  const fail = (msg) => {
    if (strictVisual) throw new Error(msg);
    log.warn(`${msg}; continuing anyway`);
  };

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
    if (checks && step.patch) {
      const r = await waitForPatch(page, step, rec.viewport, match, timeoutFor(i), shouldStop, popups, onPopup, i === 0 ? rec.closeButton : null);
      await page.mouse.move(x, y); // a closed popup may have moved the pointer
      if (shouldStop()) return;
      if (r.matched) log.info(`Step ${i + 1}: matched (${r.score})`);
      else fail(`Step ${i + 1} at (${step.x}, ${step.y}): screen never matched the recording (last ${r.score})`);
    }
    await snap(`step${String(i + 1).padStart(2, '0')}-before`);
    await sleep(clickDelayMs);
    await click(page, step);

    const next = rec.steps[i + 1];
    if (checks && step.patch && next?.type === 'click' && next.patch) {
      let reclicks = 0;
      const appeared = await confirmClick(page, step, next, { x, y }, rec.viewport, match, timeoutFor(i), reclickMs, clickDelayMs, shouldStop, popups, onPopup, async () => {
        log.warn(`Step ${i + 1}: the screen did not react, clicking again`);
        await snap(`step${String(i + 1).padStart(2, '0')}-reclick${++reclicks}`);
      });
      if (shouldStop()) return;
      if (!appeared) fail(`Step ${i + 2} at (${next.x}, ${next.y}) never appeared after step ${i + 1}`);
    }
  }
}

export async function click(page, step) {
  await page.mouse.down();
  await sleep(clamp(step.holdMs ?? 80, 40, 400));
  await page.mouse.up();
}

// Takes full screenshots and crops them here: a clipped page.screenshot makes
// Chromium relayout the page, and Unity then drops or misplaces the next
// click (seen on the real game: Create ignored, a dialog closed by its own
// button). Full screenshots between clicks leave input alone.
// A snapshot may carry its own maxDiff: the Teams box, plain white either way,
// is 27.6 apart ticked vs unticked (hovered unticked: 10), under the general limit.
export const looksLike = (shot, step, viewport, match) =>
  patchMatch(cropPng(shot, patchClip(step.x, step.y, viewport)), Buffer.from(step.patch, 'base64'), { ...match, maxDiff: step.maxDiff ?? match.maxDiff });

// Clicks the close button of the first known popup on screen. Returns true if it did.
async function closePopup(page, shot, popups, viewport, match, onPopup) {
  const popup = popups.find((p) => looksLike(shot, p, viewport, match).matched);
  if (!popup) return false;
  onPopup(popup);
  await page.mouse.move(popup.x, popup.y);
  await click(page, popup);
  await sleep(1500);
  return true;
}

const ANY_CLOSE_MIN_SIMILARITY = 0.85; // close buttons 0.90-0.99, bare menu best 0.63

// Clicks whatever close button is on screen. Returns true if it did.
async function closeAnyButton(page, shot, closeButton, onPopup) {
  const hit = findPatch(shot, Buffer.from(closeButton.patch, 'base64'));
  if (hit.similarity < ANY_CLOSE_MIN_SIMILARITY) return false;
  onPopup({ name: `close button at (${hit.x}, ${hit.y}), similarity ${hit.similarity.toFixed(2)}` });
  await page.mouse.move(hit.x, hit.y);
  await click(page, hit);
  await sleep(1500);
  return true;
}

async function waitForPatch(page, step, viewport, match, timeoutMs, shouldStop, popups, onPopup, closeButton) {
  const deadline = Date.now() + timeoutMs;
  let last = { matched: false, score: 'no check' };
  while (Date.now() < deadline && !shouldStop()) {
    const shot = await page.screenshot();
    last = looksLike(shot, step, viewport, match);
    if (last.matched) return last;
    if (await closePopup(page, shot, popups, viewport, match, onPopup)) continue;
    if (closeButton && (await closeAnyButton(page, shot, closeButton, onPopup))) continue;
    await sleep(250);
  }
  return last;
}

// Waits for `next` to appear; re-clicks `step` (at most every reclickMs) while
// its own spot still matches, i.e. the click had no visible effect. Toggles
// are safe: once toggled, the spot no longer matches its untouched snapshot.
async function confirmClick(page, step, next, at, viewport, match, timeoutMs, reclickMs, clickDelayMs, shouldStop, popups, onPopup, onReclick) {
  const deadline = Date.now() + timeoutMs;
  let lastClick = Date.now();
  while (Date.now() < deadline && !shouldStop()) {
    const shot = await page.screenshot();
    if (looksLike(shot, next, viewport, match).matched) return true;
    if (await closePopup(page, shot, popups, viewport, match, onPopup)) continue;
    if (Date.now() - lastClick >= reclickMs && looksLike(shot, step, viewport, match).matched) {
      await onReclick();
      await page.mouse.move(at.x, at.y);
      await sleep(clickDelayMs);
      await click(page, step);
      lastClick = Date.now();
    }
    await sleep(250);
  }
  return false;
}
