// Scripts injected into the game page before any of its own code runs.
// They are serialized by Playwright, so each function must be self-contained.

// Reports game signals to Node through the exposed `__skBridge` binding:
//  - copy:         the game copies its invite link via window.copyText(link)
//                  (see smashkarts.io/scripts/main.js). execCommand('copy') and
//                  navigator.clipboard are hooked too in case the path changes.
//  - menuReady:    Unity calls window.onLoadingToMainMenuComplete() when the
//                  main menu is up.
//  - loadingState: Unity calls window.updateLoadingState(state) while loading.
// With opts.photonPort443, Photon WebSockets on ports 1909x are moved to 443,
// for networks that only allow 443 out (some cloud sandboxes). Photon serves
// the same endpoints on 443.
// With opts.netCapture, every WebSocket frame (both ways) is reported as
//  - net: { frames: [{ ws, dir: 'open' | 'in' | 'out' | 'close', t, url?, b64?, text? }] }
//    batched every 200 ms; t is epoch ms with sub-ms precision.
export function pageHooks(opts) {
  if (window.top !== window) return;
  const send = (e) => {
    try { window.__skBridge(e); } catch { /* binding not ready */ }
  };

  if (opts && (opts.photonPort443 || opts.netCapture)) {
    const OrigWS = window.WebSocket;
    const now = () => performance.timeOrigin + performance.now();
    let queue = [];
    let flushTimer = null;
    let sockets = 0;
    const record = (frame) => {
      queue.push(frame);
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          const frames = queue;
          queue = [];
          send({ type: 'net', frames });
        }, 200);
      }
    };
    const b64 = (buf) => {
      const bytes = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };
    const capture = (id, dir, data, t) => {
      if (typeof data === 'string') record({ ws: id, dir, t, text: data });
      else if (data instanceof ArrayBuffer) record({ ws: id, dir, t, b64: b64(data) });
      else if (ArrayBuffer.isView(data)) record({ ws: id, dir, t, b64: b64(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) });
      else if (data instanceof Blob) data.arrayBuffer().then((buf) => record({ ws: id, dir, t, b64: b64(buf) }));
    };
    const PatchedWS = function (url, protocols) {
      const m = opts.photonPort443 && String(url).match(/^wss:\/\/([^/:]+\.(?:photonengine\.io|exitgames\.com)):(\d+)(.*)$/);
      const target = m && m[2] !== '443' ? `wss://${m[1]}:443${m[3]}` : url;
      const ws = protocols === undefined ? new OrigWS(target) : new OrigWS(target, protocols);
      if (opts.netCapture) {
        const id = ++sockets;
        record({ ws: id, dir: 'open', t: now(), url: String(target) });
        const origSend = ws.send;
        ws.send = function (data) {
          capture(id, 'out', data, now());
          return origSend.call(this, data);
        };
        ws.addEventListener('message', (e) => capture(id, 'in', e.data, now()));
        ws.addEventListener('close', (e) => record({ ws: id, dir: 'close', t: now(), code: e.code }));
      }
      return ws;
    };
    PatchedWS.prototype = OrigWS.prototype;
    Object.assign(PatchedWS, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
    window.WebSocket = PatchedWS;
  }

  let realCopyText;
  Object.defineProperty(window, 'copyText', {
    configurable: true,
    get() {
      if (!realCopyText) return undefined;
      return function (text) {
        send({ type: 'copy', text: String(text), via: 'copyText' });
        return realCopyText.apply(this, arguments);
      };
    },
    set(fn) { realCopyText = fn; },
  });

  const origExec = Document.prototype.execCommand;
  Document.prototype.execCommand = function (cmd) {
    if (String(cmd).toLowerCase() === 'copy') {
      const el = document.activeElement;
      const text = el && typeof el.value === 'string' ? el.value : String(window.getSelection());
      send({ type: 'copy', text, via: 'execCommand' });
    }
    return origExec.apply(this, arguments);
  };

  if (navigator.clipboard && navigator.clipboard.writeText) {
    const origWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => {
      send({ type: 'copy', text: String(text), via: 'clipboard' });
      return origWrite(text);
    };
  }

  // main.js declares these as plain global functions, so wrap them as soon
  // as they exist (long before Unity finishes loading and calls them).
  const wrap = (name, before) => {
    const fn = window[name];
    if (typeof fn !== 'function' || fn.__skWrapped) return typeof fn === 'function';
    const wrapped = function () {
      before.apply(this, arguments);
      return fn.apply(this, arguments);
    };
    wrapped.__skWrapped = true;
    window[name] = wrapped;
    return true;
  };
  const timer = setInterval(() => {
    const a = wrap('onLoadingToMainMenuComplete', () => send({ type: 'menuReady' }));
    const b = wrap('updateLoadingState', (s) => send({ type: 'loadingState', value: String(s) }));
    if (a && b) clearInterval(timer);
  }, 50);
}

// Calibration only: reports raw pointer and key input so a human run through
// the menus can be recorded and replayed.
export function inputRecorder() {
  if (window.top !== window) return;
  const send = (e) => {
    try { window.__skBridge(e); } catch { /* binding not ready */ }
  };
  const opts = { capture: true, passive: true };
  window.addEventListener('pointerdown', (e) => send({ type: 'input', kind: 'down', x: e.clientX, y: e.clientY }), opts);
  window.addEventListener('pointerup', (e) => send({ type: 'input', kind: 'up', x: e.clientX, y: e.clientY }), opts);
  window.addEventListener('keydown', (e) => {
    if (!e.repeat) send({ type: 'input', kind: 'key', key: e.key });
  }, opts);
}
