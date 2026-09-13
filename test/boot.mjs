/**
 * Real boot test: runs the actual game (src/main.js) in jsdom with a mocked
 * WebGL2 context, a mocked WebAudio context and a real 2D canvas
 * (@napi-rs/canvas), then drives a few hundred frames of gameplay.
 *
 * There is no browser in CI, so this is the closest thing to "does it actually
 * start": it catches import errors, DOM id mismatches, exceptions in boot
 * steps (city, car, traffic, PMREM env bake, pipeline construction), broken
 * settings/quality paths and anything that throws inside the frame loop.
 *
 * What it cannot check: GLSL (see test/shaders.mjs) and how the image looks.
 *
 * Run: node test/boot.mjs      (needs: npm i --no-save jsdom)
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { createWebGL2Mock } from './gl-mock.mjs';

const root = resolve(import.meta.dirname, '..');
const JSDOM_PATH = existsSync(resolve(root, 'node_modules/jsdom')) ? 'jsdom' : null;
if (!JSDOM_PATH) {
  console.log('jsdom not installed — skipping the boot test.');
  console.log('  npm i --no-save jsdom');
  process.exit(0);
}
const { JSDOM } = await import(JSDOM_PATH);

/* ------------------------------------------------------------ error traps */
const errors = [];
const warns = [];
// print immediately as well: swallowing the exception would otherwise let the
// process exit silently with code 0 and hide the real failure
// jsdom keeps its rAF loop alive forever, so an exception must force an exit or
// the process would hang until the outer timeout
const dieSoon = () => setTimeout(() => process.exit(1), 300);
process.on('uncaughtException', (e) => {
  errors.push(`uncaughtException: ${e.stack || e}`);
  process.stderr.write(`\n[uncaughtException] ${e && e.stack ? e.stack : e}\n`);
  dieSoon();
});
process.on('unhandledRejection', (e) => {
  errors.push(`unhandledRejection: ${e?.stack || e}`);
  process.stderr.write(`\n[unhandledRejection] ${e && e.stack ? e.stack : e}\n`);
  dieSoon();
});

/* ------------------------------------------------------------------- DOM */
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'https://rejson59.github.io/RealisticCarNight/',
  pretendToBeVisual: true,     // gives us requestAnimationFrame
  runScripts: 'outside-only',
});
const { window } = dom;

// canvas: real 2D (napi), mocked WebGL2
const origGetContext = window.HTMLCanvasElement.prototype.getContext;
window.HTMLCanvasElement.prototype.getContext = function patched(type, attrs) {
  if (type === '2d') {
    if (!this.__napi) {
      this.__napi = createCanvas(this.width || 300, this.height || 150);
      this.__napiCtx = this.__napi.getContext('2d');
      // napi-canvas only accepts its own canvas/image objects, but the app
      // passes jsdom <canvas> elements around (procedural textures) — unwrap
      const unwrap = (v) => (v && v.__napi) ? v.__napi : v;
      const rawDraw = this.__napiCtx.drawImage.bind(this.__napiCtx);
      this.__napiCtx.drawImage = (img, ...rest) => rawDraw(unwrap(img), ...rest);
      const rawPattern = this.__napiCtx.createPattern.bind(this.__napiCtx);
      this.__napiCtx.createPattern = (img, rep) => rawPattern(unwrap(img), rep);
    }
    return this.__napiCtx;
  }
  if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
    if (!this.__gl) this.__gl = createWebGL2Mock(this);
    return this.__gl;
  }
  return origGetContext.call(this, type, attrs);
};
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
window.HTMLCanvasElement.prototype.setPointerCapture = function () {};
window.HTMLCanvasElement.prototype.releasePointerCapture = function () {};

// keep the backing store in sync when three/HUD resize a canvas
const sizePatch = (prop) => {
  const desc = Object.getOwnPropertyDescriptor(window.HTMLCanvasElement.prototype, prop)
    || { get() { return this[`_${prop}`] ?? 300; }, set(v) { this[`_${prop}`] = v; } };
  Object.defineProperty(window.HTMLCanvasElement.prototype, prop, {
    get: desc.get,
    set(v) {
      desc.set.call(this, v);
      if (this.__napi) this.__napi[prop] = v;
      if (this.__gl) this.__gl[`drawingBuffer${prop === 'width' ? 'Width' : 'Height'}`] = v;
    },
    configurable: true,
  });
};
sizePatch('width');
sizePatch('height');

/* --------------------------------------------------------------- WebAudio */
function audioParam(value = 0) {
  const noop = () => param;
  const param = {
    value, defaultValue: value, minValue: -3.4e38, maxValue: 3.4e38,
    setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop,
    setTargetAtTime: noop, setValueCurveAtTime: noop, cancelScheduledValues: noop,
    cancelAndHoldAtTime: noop,
  };
  return param;
}
function audioNode(extra = {}) {
  const node = {
    numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2,
    connect: (dst) => dst, disconnect: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    onended: null,
    ...extra,
  };
  return new Proxy(node, {
    get(t, p) {
      if (p in t) return t[p];
      // anything else an AudioNode might expose is treated as an AudioParam
      if (!t.__params) t.__params = {};
      if (!t.__params[p]) t.__params[p] = audioParam();
      return t.__params[p];
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.state = 'running';
    this.destination = audioNode();
    this.listener = {
      setPosition: () => {}, setOrientation: () => {}, positionX: audioParam(),
      forwardX: audioParam(), upX: audioParam(),
    };
    this.__t0 = Date.now();
  }
  get currentTimeLive() { return (Date.now() - this.__t0) / 1000; }
  createGain() { return audioNode({ gain: audioParam(1) }); }
  createOscillator() {
    return audioNode({
      frequency: audioParam(440), detune: audioParam(0), type: 'sine',
      start: () => {}, stop: () => {}, setPeriodicWave: () => {},
    });
  }
  createBiquadFilter() {
    return audioNode({
      frequency: audioParam(350), Q: audioParam(1), gain: audioParam(0), detune: audioParam(0),
      type: 'lowpass', getFrequencyResponse: () => {},
    });
  }
  createBufferSource() {
    return audioNode({
      buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: audioParam(1),
      detune: audioParam(0), start: () => {}, stop: () => {},
    });
  }
  createDelay(max = 1) { return audioNode({ delayTime: audioParam(0), __max: max }); }
  createDynamicsCompressor() {
    return audioNode({
      threshold: audioParam(-24), knee: audioParam(30), ratio: audioParam(12),
      attack: audioParam(0.003), release: audioParam(0.25), reduction: 0,
    });
  }
  createWaveShaper() { return audioNode({ curve: null, oversample: 'none' }); }
  createStereoPanner() { return audioNode({ pan: audioParam(0) }); }
  createConvolver() { return audioNode({ buffer: null, normalize: true }); }
  createAnalyser() {
    return audioNode({
      fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0.8,
      getByteFrequencyData: () => {}, getFloatFrequencyData: () => {}, getByteTimeDomainData: () => {},
    });
  }
  createChannelMerger() { return audioNode(); }
  createChannelSplitter() { return audioNode(); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
      getChannelData: (i) => data[i] || data[0],
      copyFromChannel: () => {}, copyToChannel: () => {},
    };
  }
  createPeriodicWave() { return {}; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  decodeAudioData() { return Promise.resolve(this.createBuffer(2, 1024, this.sampleRate)); }
}

/* ------------------------------------------------------------- globals */
const g = globalThis;
// Node 21+ exposes some of these as getter-only (navigator, performance, ...)
const setGlobal = (name, value) => {
  try {
    g[name] = value;
    if (g[name] !== value) throw new Error('read-only');
  } catch {
    Object.defineProperty(g, name, { value, configurable: true, writable: true });
  }
};

setGlobal('window', window);
setGlobal('document', window.document);
setGlobal('navigator', window.navigator);
setGlobal('location', window.location);
setGlobal('localStorage', window.localStorage);
setGlobal('sessionStorage', window.sessionStorage);
setGlobal('history', window.history);
setGlobal('HTMLElement', window.HTMLElement);
setGlobal('HTMLCanvasElement', window.HTMLCanvasElement);
setGlobal('HTMLInputElement', window.HTMLInputElement);
setGlobal('Element', window.Element);
setGlobal('Node', window.Node);
setGlobal('Event', window.Event);
setGlobal('CustomEvent', window.CustomEvent);
setGlobal('MouseEvent', window.MouseEvent);
setGlobal('PointerEvent', window.PointerEvent || window.MouseEvent);
setGlobal('KeyboardEvent', window.KeyboardEvent);
setGlobal('Image', window.Image);
setGlobal('Blob', window.Blob);
setGlobal('URL', window.URL);
const bindOr = (fn, fallback) => (typeof fn === 'function' ? fn.bind(window) : fallback);
setGlobal('requestAnimationFrame', bindOr(window.requestAnimationFrame,
  (cb) => setTimeout(() => cb(Date.now()), 16)));
setGlobal('cancelAnimationFrame', bindOr(window.cancelAnimationFrame, (id) => clearTimeout(id)));
// jsdom has no matchMedia: provide the minimum the app expects
setGlobal('matchMedia', bindOr(window.matchMedia, (query) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => false,
})));
window.matchMedia = globalThis.matchMedia;
setGlobal('getComputedStyle', bindOr(window.getComputedStyle, () => ({ getPropertyValue: () => '' })));
setGlobal('devicePixelRatio', 1);
// NOTE: do NOT override globalThis.performance — jsdom's Performance.now()
// delegates to the Node global, so replacing it recurses until the stack blows.
setGlobal('self', window);
setGlobal('innerWidth', window.innerWidth);
setGlobal('innerHeight', window.innerHeight);
window.innerWidth = 1280;
window.innerHeight = 720;
setGlobal('innerWidth', 1280);
setGlobal('innerHeight', 720);
window.AudioContext = MockAudioContext;
window.webkitAudioContext = MockAudioContext;
setGlobal('AudioContext', MockAudioContext);

// console.error from the app/jsdom counts as a failure (three logs real problems there)
const origError = console.error;
console.error = (...a) => { errors.push(`console.error: ${a.join(' ')}`); };
const origWarn = console.warn;
console.warn = (...a) => { warns.push(`console.warn: ${a.join(' ')}`); };

/* ---------------------------------------------------------------- boot */
const frames = [];
const mod = await import('../src/main.js');
const game = mod.game || window.__game;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const loadingDone = () => window.document.getElementById('loading')?.classList.contains('done');

let waited = 0;
while (!loadingDone() && waited < 40000) { await sleep(50); waited += 50; }
if (!loadingDone()) {
  errors.push(`boot did not finish in 40 s (status: "${window.document.getElementById('loadStatus')?.textContent}")`);
}

// count rendered frames through requestAnimationFrame instrumentation
const rafOrig = window.requestAnimationFrame.bind(window);
let frameCount = 0;
window.requestAnimationFrame = (cb) => rafOrig((t) => { frameCount++; cb(t); });
g.requestAnimationFrame = window.requestAnimationFrame;

// start the game (this is what the player clicks)
window.document.getElementById('startBtn')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await sleep(2500);
frames.push(frameCount);

// a couple of interactions that exercise real code paths
const key = (code, type = 'keydown') => window.dispatchEvent(new window.KeyboardEvent(type, { code, bubbles: true }));
for (const code of ['KeyW', 'KeyD', 'Space']) key(code);
await sleep(1200);
key('KeyW', 'keyup'); key('KeyD', 'keyup'); key('Space', 'keyup');

// camera cycle, perf overlay, menu, photo mode, quality cycle
for (const code of ['KeyC', 'KeyC', 'KeyG', 'KeyO', 'KeyQ']) {
  key(code); await sleep(250); key(code, 'keyup'); await sleep(150);
}
key('KeyO'); await sleep(300);            // close the menu again
key('KeyF'); await sleep(600);            // photo mode on (forces full-res pipeline)
key('KeyF'); await sleep(400);            // photo mode off
await sleep(800);

/* ------------------------------------------- real gameplay / pipeline state */
if (!game) errors.push('main.js did not export the game instance');
else {
  // the loop must really drive the pipeline
  if (!(game.pipe.frame > 100)) errors.push(`pipeline rendered only ${game.pipe.frame} frames`);
  if (game.camera.projectionMatrix.elements[8] !== 0
    || game.camera.projectionMatrix.elements[9] !== 0) {
    errors.push('camera jitter leaked out of the frame (would double up every frame)');
  }
  if (!(game.renderer.info.render.calls > 0)) errors.push('renderer reported no draw calls');

  // driving: holding W must actually accelerate the car
  const kmhBefore = game.car.speedKmh;
  key('KeyW');
  await sleep(1500);
  key('KeyW', 'keyup');
  if (!(game.car.speedKmh > kmhBefore + 5)) {
    errors.push(`car did not accelerate (before ${kmhBefore.toFixed(1)}, after ${game.car.speedKmh.toFixed(1)} km/h)`);
  }

  // REGRESSION: the quality tier is the ceiling — user switches may only take
  // effects away, never add AO/DOF/TAA to a tier that does not offer them
  const checkTier = async (tier, expect) => {
    game.settings.set('quality', tier);
    game._applySettings('quality');
    await sleep(120);
    const st = game.pipe.stats;
    for (const [k, v] of Object.entries(expect)) {
      if (st[k] !== v) {
        errors.push(`tier ${tier}: expected ${k}=${v}, got ${k}=${st[k]} (stats ${JSON.stringify(st)})`);
      }
    }
    // internal size must follow BOTH the tier scale and the dpr the tier sets
    const dpr = game.renderer.getPixelRatio();
    const want = Math.max(2, Math.round(1280 * dpr * game.pipe.scale));
    if (st.internal[0] !== want) {
      errors.push(`tier ${tier}: internal width ${st.internal[0]} != css 1280 * dpr ${dpr} * scale ${game.pipe.scale} = ${want}`);
    }
    const pu = game.pipe.presentPass.material.uniforms;
    if (process.env.DEBUG_TIER) {
      console.log(`[dbg] tier=${tier} css=${JSON.stringify(game.pipe.css)} dpr=${game.pipe.dpr} scale=${game.pipe.scale} internal=${JSON.stringify(game.pipe.internal)} rendererPR=${game.renderer.getPixelRatio()} uOutRes=${pu.uOutRes.value.x}x${pu.uOutRes.value.y} uTexelIn=${pu.uTexelIn.value.x} passes=${game.pipe.composer.passes.map((x) => x.constructor.name).join(',')}`);
    }
    if (pu.uOutRes.value.x !== Math.round(1280 * dpr) || pu.uOutRes.value.y !== Math.round(720 * dpr)) {
      errors.push(`tier ${tier}: present pass uOutRes ${pu.uOutRes.value.x}x${pu.uOutRes.value.y} != drawing buffer ${Math.round(1280 * dpr)}x${Math.round(720 * dpr)}`);
    }
    const wantTexel = 1 / want;
    if (Math.abs(pu.uTexelIn.value.x - wantTexel) > 1e-6) {
      errors.push(`tier ${tier}: present pass uTexelIn.x ${pu.uTexelIn.value.x} != 1/${want}`);
    }
  };
  await checkTier(0, { taa: false, ao: false, dof: false, velocity: false, scale: 1 });
  await checkTier(1, { taa: false, ao: false, dof: false, scale: 1 });
  await checkTier(2, { taa: true, ao: true, dof: false, scale: 0.85 });
  await checkTier(3, { taa: true, ao: true, dof: true, velocity: true, scale: 0.7 });

  // user switches still work *within* the tier ceiling
  game.settings.set('ao', false);
  game._applySettings('ao');
  await sleep(100);
  if (game.pipe.stats.ao !== false) errors.push('turning AO off in the menu did not reach the pipeline');
  game.settings.set('ao', true);
  game._applySettings('ao');

  // turning TAA off must fall back to native resolution + MSAA
  game.settings.set('upscale', false);
  game._applySettings('upscale');
  await sleep(100);
  if (game.pipe.stats.scale !== 1 || game.pipe.stats.msaa !== 4) {
    errors.push(`TAA off should mean native + MSAA, got scale=${game.pipe.stats.scale} msaa=${game.pipe.stats.msaa}`);
  }
  game.settings.set('upscale', true);
  game._applySettings('upscale');
  await sleep(100);

  // photo mode: full internal resolution, no temporal blend in the capture
  key('KeyF'); await sleep(400);
  if (game.pipe.scale !== 1) errors.push(`photo mode must render at 1.0x, got ${game.pipe.scale}`);
  game.capturePhoto();
  key('KeyF'); await sleep(300);
  if (game.pipe.scale !== 0.7) errors.push(`leaving photo mode must restore the tier scale, got ${game.pipe.scale}`);

  // focus distance follows the camera
  if (!(game.pipe.dofPass.material.uniforms.uFocus.value > 0)) {
    errors.push('DOF focus distance was never set');
  }

  game.settings.set('quality', 'auto');
  game._applySettings('quality');
  await sleep(200);
}

const info = window.document.getElementById('perfBox')?.textContent || '';
const tier = window.document.getElementById('tierBox')?.textContent || '';
const fps = window.document.getElementById('fpsBox')?.textContent || '';

/* --------------------------------------------------------------- report */
console.error = origError;
console.warn = origWarn;

// jsdom prints its own limitations through console.error/warn (no navigation,
// no canvas toBlob, ...) — those are environment gaps, not app bugs
const jsdomNoise = /Not implemented|jsdom|Error: Could not parse CSS/i;
const realErrors = errors.filter((e) => !jsdomNoise.test(e));
const realWarns = warns.filter((w) => !jsdomNoise.test(w));
console.log(`boot OK in ${waited} ms; frames rendered: ${frameCount}`);
console.log(`HUD: tier="${tier}" fps="${fps}"`);
if (info) console.log(`perf panel: ${info.replace(/\n/g, ' | ')}`);
if (realWarns.length) console.log(`warnings (${realWarns.length}): ${realWarns.slice(0, 6).join(' ~ ')}`);

if (frameCount < 30) errors.push(`only ${frameCount} frames rendered in ~5 s (the loop is not running)`);
if (realErrors.length) {
  console.error(`\nBOOT TEST FAILED — ${realErrors.length} problem(s):`);
  for (const e of realErrors.slice(0, 12)) console.error(`\n--- ${e}`);
  dom.window.close();
  process.exit(1);
}
console.log('BOOT TEST PASSED ✔');
// jsdom keeps the rAF loop alive forever — leave explicitly
dom.window.close();
process.exit(0);
