/**
 * Demo driver — injected into the running app.
 *
 * Every interaction here is real: real pointer events at real coordinates, real
 * input events, real file uploads, real state polled out of the app. Nothing is
 * staged and nothing is faked. The SVG cursor is cosmetic only — the events it
 * accompanies are dispatched at the same coordinates whether or not it exists.
 *
 * One clock: each beat calls line(id) to stamp its start, then hold() blocks for
 * that line's *measured* audio duration plus a breath. Nothing is timed by eye.
 */
(() => {
  const BREATH_MS = 450;

  // ---- overlay: SVG cursor + click ring -----------------------------------
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('id', '__demo_overlay');
  Object.assign(svg.style, {
    position: 'fixed', inset: '0', width: '100%', height: '100%',
    pointerEvents: 'none', zIndex: '2147483647',
  });
  const ring = document.createElementNS(ns, 'circle');
  ring.setAttribute('r', '0'); ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', '#16233c'); ring.setAttribute('stroke-width', '2');
  ring.setAttribute('opacity', '0');
  const cursor = document.createElementNS(ns, 'path');
  // A plain arrow pointer, drawn from its own tip.
  cursor.setAttribute('d', 'M0,0 L0,17 L4.2,13.2 L7,19.4 L9.6,18.2 L6.9,12.2 L12,12 Z');
  cursor.setAttribute('fill', '#10192b');
  cursor.setAttribute('stroke', '#fff');
  cursor.setAttribute('stroke-width', '1.2');
  cursor.setAttribute('stroke-linejoin', 'round');
  svg.append(ring, cursor);
  document.body.appendChild(svg);

  const pos = { x: innerWidth * 0.5, y: innerHeight * 0.62 };
  const place = () => cursor.setAttribute('transform', `translate(${pos.x},${pos.y})`);
  place();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /** Ease the SVG cursor to (x,y). Never touches the hardware cursor. */
  function glide(x, y, ms = 700) {
    return new Promise((done) => {
      const x0 = pos.x, y0 = pos.y, t0 = performance.now();
      let lastMove = 0;
      (function step(now) {
        const t = Math.min(1, (now - t0) / ms), e = easeInOut(t);
        pos.x = x0 + (x - x0) * e;
        pos.y = y0 + (y - y0) * e;
        place();
        if (now - lastMove > 16) { lastMove = now; window.__demoMouseMove(Math.round(pos.x), Math.round(pos.y)); }
        t < 1 ? requestAnimationFrame(step) : done();
      })(t0);
    });
  }

  function ringPulse(x, y) {
    const t0 = performance.now(), DUR = 520;
    ring.setAttribute('cx', x); ring.setAttribute('cy', y);
    (function step(now) {
      const t = Math.min(1, (now - t0) / DUR);
      ring.setAttribute('r', String(4 + 26 * t));
      ring.setAttribute('opacity', String((1 - t) * 0.85));
      if (t < 1) requestAnimationFrame(step);
    })(t0);
  }

  /**
   * Input goes through CDP (Input.dispatchMouseEvent), injected by the harness.
   * That is real browser-level input — it takes the same path as hardware input,
   * so `setPointerCapture` and OrbitControls behave exactly as for a real mouse.
   * It does NOT move the host machine's cursor, so nothing can steal it; the SVG
   * arrow above is what the viewer sees, and it tracks the same coordinates.
   *
   * Synthetic JS PointerEvents were tried first and are not good enough:
   * OrbitControls calls setPointerCapture(pointerId) on pointerdown, which
   * throws for an id that was never a real pointer, so the drag never arms.
   */
  async function clickAt(x, y) {
    await glide(x, y, 650);
    ringPulse(x, y);
    if (!document.elementFromPoint(x, y)) throw new Error(`DEMO_NO_ELEMENT_AT ${x},${y}`);
    await window.__demoClick(Math.round(x), Math.round(y));
    return document.elementFromPoint(x, y);
  }

  /** Real drag — used to orbit the 3D view. */
  async function dragTo(x0, y0, x1, y1, ms = 1400) {
    await glide(x0, y0, 500);
    ringPulse(x0, y0);
    await window.__demoMouseDown(Math.round(x0), Math.round(y0));
    const t0 = performance.now();
    let last = 0;
    await new Promise((done) => {
      (function step(now) {
        const t = Math.min(1, (now - t0) / ms), e = easeInOut(t);
        const x = x0 + (x1 - x0) * e, y = y0 + (y1 - y0) * e;
        pos.x = x; pos.y = y; place();
        if (now - last > 16) { last = now; window.__demoMouseMove(Math.round(x), Math.round(y)); }
        t < 1 ? requestAnimationFrame(step) : done();
      })(t0);
    });
    await window.__demoMouseMove(Math.round(x1), Math.round(y1));
    await window.__demoMouseUp(Math.round(x1), Math.round(y1));
  }

  /** Types into a real field at ~24 cps with jitter, firing real input events. */
  async function typeInto(el, text) {
    el.focus();
    el.value = '';
    for (const ch of text) {
      el.value += ch;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
      await sleep(1000 / 24 + (Math.random() * 26 - 13));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Poll real state. Throws a NAMED error so a failed take says which beat died. */
  async function until(label, predicate, timeoutMs = 20000) {
    const t0 = performance.now();
    for (;;) {
      let ok = false;
      try { ok = await predicate(); } catch { ok = false; }
      if (ok) return performance.now() - t0;
      if (performance.now() - t0 > timeoutMs) throw new Error(`DEMO_TIMEOUT_${label}`);
      await sleep(90);
    }
  }

  // ---- one clock ----------------------------------------------------------
  const marks = [];
  let t0 = null;
  let current = null;

  function start() { t0 = performance.now(); }
  function line(id) {
    if (t0 === null) start();
    const ms = Math.round(performance.now() - t0);
    const dur = (window.__DEMO_DURATIONS || {})[id];
    if (dur === undefined) throw new Error(`DEMO_NO_DURATION_FOR_${id}`);
    current = { id, ms, durationMs: Math.round(dur * 1000), signing: false };
    marks.push(current);
    // The recorder greps stdout for this exact shape.
    console.log(`DEMO_LINE ${ms} ${id}`);
    return current;
  }
  /** Block for this beat's measured audio duration plus a breath. */
  async function hold(extraMs = 0) {
    if (!current) throw new Error('DEMO_HOLD_WITHOUT_LINE');
    await sleep(current.durationMs + BREATH_MS + extraMs);
  }

  const app = () => window.__app;
  const fold = () => app().model.foldValue;
  const readout = () => {
    const r = document.getElementById('readout');
    const k = [...r.children], o = {};
    for (let i = 0; i < k.length; i++) if (k[i].className === 'k') o[k[i].textContent] = k[i + 1].textContent;
    return o;
  };
  const centreOf = (sel) => {
    const b = document.querySelector(sel).getBoundingClientRect();
    return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)];
  };

  /**
   * Scroll a control into view and hand back its centre, but only after
   * confirming that point really hits it. A click aimed at a control that has
   * scrolled below the fold lands on the canvas and does nothing at all — the
   * take then runs on happily and fails later somewhere unrelated.
   */
  async function reveal(sel) {
    const el = document.querySelector(sel);
    if (!el) throw new Error('DEMO_NO_ELEMENT_' + sel.replace(/\W/g, ''));
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(260);
    const b = el.getBoundingClientRect();
    const c = [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)];
    const hit = document.elementFromPoint(c[0], c[1]);
    if (hit !== el && !el.contains(hit) && !hit?.contains(el)) {
      throw new Error('DEMO_OCCLUDED_' + sel.replace(/\W/g, ''));
    }
    return c;
  }

  window.__demo = {
    glide, clickAt, dragTo, typeInto, until, line, hold, sleep, start,
    marks, app, fold, readout, centreOf, reveal,
    cursorTo: (x, y) => { pos.x = x; pos.y = y; place(); },
  };
  console.log('DEMO_DRIVER_READY');
})();
