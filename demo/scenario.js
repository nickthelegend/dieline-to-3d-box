/**
 * The take. Executes the beats from recording.md in order, on the real app.
 *
 * Every "is it done yet" is a poll of real app state (fold value, material maps,
 * readout text) — never "wait for another element to appear", which is the check
 * that has silently passed on a broken app before.
 */
(async () => {
  const D = window.__demo;
  const { clickAt, dragTo, glide, until, line, hold, sleep, app, fold, readout, centreOf, reveal } = D;
  const log = [];
  const fail = (e) => { console.log('DEMO_FAILED ' + (e && e.message ? e.message : e)); throw e; };

  try {
    // Scope failure checks to this run: remember how many errors already exist.
    window.__errBefore = (window.__demoErrors || []).length;

    D.start();

    /* b01 / intro — the flat sheet, already parsed */
    line('intro');
    await until('APP_READY', () => app() && app().model && /parsed/.test(document.getElementById('status').textContent));
    await glide(innerWidth * 0.62, innerHeight * 0.5, 900);
    await hold();

    /* b02 — the readout */
    line('b02_readout');
    await until('READOUT_18_PANELS', () => readout()['panels found'] === '18');
    await glide(210, 300, 700);
    await glide(210, 430, 1100);
    await hold();

    /* b03 — linework + legend */
    line('b03_linework');
    await until('LINEWORK_BUILT', () => app().model.linework.length === 16 && app().model.linework.every(l => l.visible));
    await glide(150, 545, 800);
    await hold();

    /* b04 — THE FOLD (real click on the real button) */
    line('b04_fold');
    const [px, py] = await reveal('#play');
    await clickAt(px, py);
    await until('FOLD_REACHED_1', () => fold() === 1, 25000);   // real value, not a class
    await hold();

    /* b05 — orbit the closed carton */
    line('b05_orbit');
    {
      const cam = app().viewer.camera.position.clone();
      const tgt = app().viewer.controls.target.clone();
      await dragTo(innerWidth * 0.66, innerHeight * 0.42, innerWidth * 0.50, innerHeight * 0.50, 1800);
      await until('ORBIT_MOVED', () => app().viewer.camera.position.distanceTo(cam) > 1);
      if (app().viewer.controls.target.distanceTo(tgt) > 0.5) throw new Error('DEMO_ORBIT_MOVED_TARGET');
    }
    await hold();

    /* b06 — scrub the fold with real input events */
    line('b06_scrub');
    {
      const s = document.getElementById('scrub');
      const b = s.getBoundingClientRect();
      await glide(b.right - 8, b.top + b.height / 2, 600);
      const setScrub = (v) => {
        s.value = String(v);
        s.dispatchEvent(new Event('input', { bubbles: true }));
        D.cursorTo(b.left + (b.width * v) / 1000, b.top + b.height / 2);
      };
      for (let v = 1000; v >= 380; v -= 20) { setScrub(v); await sleep(16); }
      await until('SCRUB_TRACKS', () => Math.abs(fold() * 1000 - Number(s.value)) < 1);
      await sleep(500);
      for (let v = 380; v <= 1000; v += 20) { setScrub(v); await sleep(16); }
      await until('SCRUB_BACK_TO_CLOSED', () => Math.abs(fold() - 1) < 1e-6);
    }
    await hold();

    /* b07 — colour the panels */
    line('b07_panels');
    {
      const [cx, cy] = await reveal('#tPanelMap');
      await clickAt(cx, cy);
      await until('PANELS_COLOURED', () => {
        const c = app().model.views.map(v => v.mesh.material[0].color.getHexString());
        return new Set(c).size === c.length && c.length === 16;
      });
      await sleep(400);
      await clickAt(cx, cy);   // back to board so the next beats read cleanly
      await until('PANELS_BOARD', () => app().model.views.every(v => v.mesh.material[0].color.getHexString() === 'e9e2d2'));
    }
    await hold();

    /* b08 — the raster path: same carton, traced from pixels */
    line('b08_raster');
    await window.__demoUpload('sample_dieline.png');
    await until('RASTER_PARSED', () => readout().source === 'bitmap (traced)' && readout()['closed box'] === '154.5 × 95.5 × 17.5 mm', 40000);
    {
      const [bx, by] = await reveal('#play');
      await clickAt(bx, by);
      await until('RASTER_FOLDED', () => fold() === 1, 25000);
    }
    await hold();

    /* b09 — artwork prints onto the folded box */
    line('b09_artwork');
    await window.__demoUpload('art_dieline.png');
    await until('ART_PARSED', () => readout().source === 'bitmap (traced)', 40000);
    await until('ART_MAPPED', () => app().model.views.every(v => !!v.mesh.material[0].map));
    {
      const [bx, by] = await reveal('#play');
      await clickAt(bx, by);
      await until('ART_FOLDED', () => fold() === 1, 25000);
      app().viewer.frame(app().model.measure(), 3.14159, 1.15);
      await sleep(700);
      await dragTo(innerWidth * 0.62, innerHeight * 0.45, innerWidth * 0.52, innerHeight * 0.40, 1500);
    }
    await hold();

    /* b10 / outro */
    line('outro');
    await dragTo(innerWidth * 0.60, innerHeight * 0.45, innerWidth * 0.44, innerHeight * 0.52, 2200);
    await hold();

    const grew = (window.__demoErrors || []).length - window.__errBefore;
    console.log('DEMO_MARKS ' + JSON.stringify(D.marks));
    console.log(grew > 0
      ? 'DEMO_FAILED CONSOLE_ERRORS_DURING_TAKE ' + grew
      : 'DEMO_COMPLETE ' + Math.round(performance.now()) );
    window.__demoDone = true;
  } catch (e) { window.__demoDone = true; fail(e); }
})();
