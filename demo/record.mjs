/**
 * Phase 4 — drive the real app in a real Chrome and capture only the app.
 *
 * Window geometry is fixed by env vars, the capture is cropped to that rect
 * *during* capture (ffmpeg -vf crop on the live input, not a post pass), and
 * every beat start is logged as `DEMO_LINE <ms> <line-id>` the instant it fires.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve('demo');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.DEMO_URL || 'http://localhost:5177/';

// Fixed window geometry — env var, so the crop rect is never guessed.
const WX = +(process.env.DEMO_X ?? 60);
const WY = +(process.env.DEMO_Y ?? 60);
const WW = +(process.env.DEMO_W ?? 1280);
const WH = +(process.env.DEMO_H ?? 820);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const durations = JSON.parse(readFileSync(path.join(ROOT, 'durations.json'), 'utf8'));
const driverSrc = readFileSync(path.join(ROOT, 'driver.js'), 'utf8');
const scenarioSrc = readFileSync(path.join(ROOT, 'scenario.js'), 'utf8');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: null,
  userDataDir: '/tmp/demo-chrome-profile',   // clean, isolated profile
  args: [
    `--app=${URL}`,                          // no toolbar: record only the app
    `--window-position=${WX},${WY}`,
    `--window-size=${WW},${WH}`,
    '--disable-notifications',
    '--disable-infobars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=Translate,MediaRouter',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = (await browser.pages())[0] ?? (await browser.newPage());
page.on('dialog', async (d) => { await d.dismiss(); });      // suppress native dialogs

const marks = [];
const consoleErrors = [];
let recordStart = null;

page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('DEMO_LINE ')) {
    const [, ms, id] = t.split(' ');
    marks.push({ id, pageMs: +ms, wallMs: Date.now(), captureMs: recordStart ? Date.now() - recordStart : null });
    console.log(t + (recordStart ? `   (capture +${((Date.now() - recordStart) / 1000).toFixed(2)}s)` : ''));
  } else if (t.startsWith('DEMO_')) {
    console.log(t);
  }
  if (m.type() === 'error') consoleErrors.push(t);
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

// Real input via CDP. These take the same path as hardware input as far as the
// page is concerned, but never move the host machine's cursor.
await page.exposeFunction('__demoMouseMove', async (x, y) => { await page.mouse.move(x, y); return true; });
await page.exposeFunction('__demoMouseDown', async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); return true; });
await page.exposeFunction('__demoMouseUp',   async (x, y) => { await page.mouse.move(x, y); await page.mouse.up(); return true; });
await page.exposeFunction('__demoClick', async (x, y) => {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 80));
  await page.mouse.up();
  return true;
});

// Real file upload — drives the actual <input type=file>, never the OS picker.
await page.exposeFunction('__demoUploadNative', async (name) => {
  const file = path.join(ROOT, 'fixtures', name);
  if (!existsSync(file)) throw new Error('MISSING_FIXTURE ' + file);
  const input = await page.$('#file');
  await input.uploadFile(file);
  return true;
});

await page.goto(URL, { waitUntil: 'load' });

// Pre-flight: clear any persisted state, then hard reload so nothing carries over.
await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.__app && window.__app.model, { timeout: 30000 });

// Where is the page content on screen? Ask the page, don't assume the chrome height.
const rect = await page.evaluate(() => ({
  x: window.screenX, y: window.screenY,
  ow: window.outerWidth, oh: window.outerHeight,
  iw: window.innerWidth, ih: window.innerHeight,
  dpr: window.devicePixelRatio,
}));
const chromeTop = rect.oh - rect.ih;
const side = Math.max(0, Math.round((rect.ow - rect.iw) / 2));
const even = (n) => (n % 2 ? n - 1 : n);
// 2px vertical inset: measured against a real capture, the reported window
// origin lands one row above the first row of page content, so an uninset crop
// carries a sliver of desktop along the top edge of every frame.
const INSET_Y = 2;
const crop = {
  w: even(Math.round(rect.iw * rect.dpr)),
  h: even(Math.round(rect.ih * rect.dpr) - INSET_Y * 2),
  x: Math.round((rect.x + side) * rect.dpr),
  y: Math.round((rect.y + chromeTop) * rect.dpr) + INSET_Y,
};
console.log('WINDOW', rect, '\nCROP', crop);

// Inject durations + driver, then arm the error collector for THIS run only.
await page.evaluate((d) => { window.__DEMO_DURATIONS = d; }, durations);
await page.evaluate(() => {
  window.__demoErrors = [];
  const e = console.error.bind(console);
  console.error = (...a) => { window.__demoErrors.push(a.join(' ')); e(...a); };
  window.addEventListener('error', (ev) => window.__demoErrors.push(String(ev.message)));
  window.__demoUpload = (n) => window.__demoUploadNative(n);
});
await page.evaluate(driverSrc);
await page.waitForFunction(() => !!window.__demo, { timeout: 10000 });

// ---- start the capture, cropped live ------------------------------------
const outFile = path.join(ROOT, 'out', 'take.mp4');
const ff = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'avfoundation', '-capture_cursor', '0', '-framerate', '30',
  '-i', '0:none',
  '-vf', `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`,
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
  outFile,
]);
ff.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.log('ffmpeg: ' + s); });

await sleep(2500);                       // let the encoder settle before the first beat
recordStart = Date.now();
console.log('RECORDING_STARTED');

let result = 'DEMO_UNKNOWN';
try {
  const done = page.evaluate(scenarioSrc);
  const finished = await Promise.race([
    page.waitForFunction(
      () => window.__demoDone === true,
      { timeout: 300000 },
    ).then(() => 'ok').catch(() => 'timeout'),
    done.then(() => 'ok').catch((e) => 'error:' + e.message),
  ]);
  result = finished;
} catch (e) {
  result = 'error:' + e.message;
}

await sleep(1200);
ff.stdin.write('q');
await new Promise((r) => ff.on('close', r));
const takeMs = Date.now() - recordStart;

const grewErrors = consoleErrors.length;
const report = {
  takeSeconds: +(takeMs / 1000).toFixed(2),
  result,
  video: outFile,
  crop, window: rect,
  consoleErrorsDuringTake: grewErrors,
  consoleErrorSamples: consoleErrors.slice(0, 5),
  signingBeats: [],
  marks: marks.map((m) => ({
    id: m.id,
    captureOffsetSeconds: +(m.captureMs / 1000).toFixed(3),
    audioDurationSeconds: durations[m.id],
    signing: false,
  })),
};
writeFileSync(path.join(ROOT, 'out', 'beat-marks.json'), JSON.stringify(report, null, 2) + '\n');
console.log('\n' + JSON.stringify(report, null, 2));

await browser.close();
process.exit(result === 'ok' && grewErrors === 0 ? 0 : 1);
