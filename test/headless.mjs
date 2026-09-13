/**
 * Headless smoke test: builds the whole city, car and traffic without WebGL
 * (canvas 2D is provided by @napi-rs/canvas) and simulates a few seconds of
 * driving + collisions + quality switching. Run: node test/headless.mjs
 */
import { createCanvas } from '@napi-rs/canvas';
import * as THREE from 'three';

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
    return createCanvas(2, 2);
  },
};

const { City, CITY } = await import('../src/world/City.js');
const { Car } = await import('../src/world/Car.js');
const { Traffic } = await import('../src/world/Traffic.js');
const { QualityManager } = await import('../src/core/QualityManager.js');

const scene = new THREE.Scene();
const t0 = Date.now();
const city = new City(scene, null);
console.log(`city built in ${Date.now() - t0} ms; objects in scene: ${scene.children.length}`);

const car = new Car(scene);
const traffic = new Traffic(scene, city);

// quality tiers
for (let tier = 0; tier < 4; tier++) city.setQuality(tier);
console.log('setQuality 0..3 OK, fog:', scene.fog.density);

// drive: full throttle with some steering & handbrake bursts
const dt = 1 / 60;
let collisions = 0;
const input = { throttle: 1, brake: 0, left: false, right: false, handbrake: false };
for (let i = 0; i < 60 * 40; i++) {
  input.left = Math.sin(i * 0.01) > 0.6;
  input.right = Math.sin(i * 0.01) < -0.6;
  input.handbrake = i > 60 * 30 && i < 60 * 33;
  const before = car.pos.clone();
  car.update(dt, input, city);
  traffic.update(dt);
  city.update(dt, car.pos);
  if (Math.hypot(car.pos.x - before.x, car.pos.z - before.z) < 1e-6) collisions++;
}
console.log(`drove 40 s sim; speed=${car.speedKmh.toFixed(0)} km/h pos=(${car.pos.x.toFixed(1)}, ${car.pos.z.toFixed(1)}) stuckFrames=${collisions}`);
if (!isFinite(car.pos.x) || !isFinite(car.pos.z)) throw new Error('car position NaN!');
if (Math.abs(car.pos.x) > CITY.HALF + 10 || Math.abs(car.pos.z) > CITY.HALF + 10) throw new Error('car escaped city!');

// collision sanity: drop the car inside a block centre, expect push-out
const res = city.collide(-CITY.HALF + CITY.S / 2, -CITY.HALF + CITY.S / 2, 1.15);
console.log('collide inside block ->', res.x.toFixed(1), res.z.toFixed(1), 'hit:', res.hit);
if (!res.hit) throw new Error('expected collision inside block');

// quality manager hysteresis
const qm = new QualityManager();
qm.tier = 2;
for (let i = 0; i < 60 * 20; i++) qm.push(1 / 30); // 30 fps => should drop
console.log('quality after 20 s @30fps:', qm.tier, 'auto:', qm.auto);
if (qm.tier >= 2) throw new Error('adaptive quality did not downgrade');

// traffic counts
for (const n of [0, 5, 18, 9, 18, 12]) traffic.setCount(n);
traffic.update(dt);
console.log('traffic pool OK, positions:', traffic.positions.length / 2);
if (traffic.cars.length !== 12) throw new Error(`setCount leaked cars: ${traffic.cars.length} instead of 12`);
if (traffic.positions.length !== 24) throw new Error('traffic positions out of sync with setCount');
if (traffic.pool.some((m, i) => m.visible !== i < 12)) throw new Error('traffic visibility out of sync');

// straight-line acceleration on an open road
car.reset();
car.pos.set(57, 0, 57);
car.heading = 0; // +z road runs along z at x=57
const straight = { throttle: 1, brake: 0, left: false, right: false, handbrake: false };
for (let i = 0; i < 60 * 5; i++) car.update(dt, straight, city);
console.log(`straight 5 s: ${car.speedKmh.toFixed(0)} km/h at (${car.pos.x.toFixed(1)}, ${car.pos.z.toFixed(1)})`);
if (car.speedKmh < 90) throw new Error('car too slow after 5 s of throttle');
if (Math.abs(car.pos.x - 57) > 2) throw new Error('car drifted off the straight road');

// autopilot: 180 s of self-driving on the grid, with traffic + lights running
const { Autopilot } = await import('../src/core/Autopilot.js');
const driveSeconds = (seed, seconds, trafficObj = traffic) => {
  const ap = new Autopilot(seed);
  car.reset();
  car.pos.set(57, 0, 57);
  car.heading = Math.PI;
  ap.snap(car, city);
  let sum = 0, n = 0, stuck = 0, offroad = 0, maxOff = 0;
  for (let i = 0; i < 60 * seconds; i++) {
    city.update(dt, car.pos);
    trafficObj.update(dt);
    const ain = ap.update(dt, car, city, trafficObj.positions);
    if (ain.throttle > 0.2 && car.speedKmh < 5) stuck++;
    car.update(dt, ain, city);
    if (!isFinite(car.pos.x) || !isFinite(car.pos.z)) throw new Error('autopilot NaN');
    sum += car.speedKmh; n++;
    const u = car.pos.x + CITY.HALF, w = car.pos.z + CITY.HALF;
    const off = Math.min(
      Math.abs(u - Math.round(u / CITY.S) * CITY.S),
      Math.abs(w - Math.round(w / CITY.S) * CITY.S)
    );
    maxOff = Math.max(maxOff, off);
    if (off > CITY.ROAD / 2) offroad++;
  }
  return { avg: sum / n, stuck, offroad, maxOff, x: car.pos.x, z: car.pos.z };
};

traffic.setCount(14);
const d1 = driveSeconds(20260912, 180);
console.log(`autopilot 180 s: avg ${d1.avg.toFixed(1)} km/h, offroad ${d1.offroad}, maxLateralOffset ${d1.maxOff.toFixed(1)} m, slowFrames=${d1.stuck}`);
if (Math.abs(d1.x) > CITY.HALF + 10 || Math.abs(d1.z) > CITY.HALF + 10) throw new Error('autopilot left the city');
if (d1.stuck > 120) throw new Error('autopilot stuck too often');
if (d1.offroad > 0) throw new Error('autopilot drove off the asphalt');
if (d1.maxOff > CITY.ROAD / 2) throw new Error('autopilot left its lane');
if (d1.avg < 18) throw new Error('autopilot crawls (avg < 18 km/h)');
// determinism: same seed + same world state => the very same drive
const freshWorld = () => {
  city.time = 0;
  const t = new Traffic(scene, city);
  t.setCount(14);
  city.dynamicColliders = t.colliders;
  return t;
};
const w2 = freshWorld(); const d2 = driveSeconds(20260912, 60, w2);
const w3 = freshWorld(); const d3 = driveSeconds(20260912, 60, w3);
city.dynamicColliders = traffic.colliders;
if (Math.abs(d2.x - d3.x) > 0.01 || Math.abs(d2.z - d3.z) > 0.01) throw new Error('autopilot is not deterministic');
console.log('autopilot determinism OK');

// traffic must respect the lights: with 14 cars some are always waiting
let moving = 0;
for (let i = 0; i < 60 * 30; i++) { city.update(dt, car.pos); traffic.update(dt); }
for (const c of traffic.cars) if (c.mode === 'grid' && c.speed > 3) moving++;
console.log(`traffic after 30 s: ${moving}/${traffic.cars.filter((c) => c.mode === 'grid').length} grid cars moving`);
if (moving === traffic.cars.filter((c) => c.mode === 'grid').length) throw new Error('no traffic car ever stops at a red light');
// right-hand traffic: a car heading +x must sit on the -z side of its line
const xCar = traffic.cars.find((c) => c.mode === 'grid' && c.axisX && c.dir > 0);
if (xCar && xCar.mesh.position.z > xCar.line) throw new Error('traffic drives on the left');

// ---- settings & records (no localStorage in node: must fall back to defaults)
const { Settings, Records } = await import('../src/core/Settings.js');
const st = new Settings();
st.set('traffic', 1.5);
if (st.get('traffic') !== 1.5) throw new Error('settings.set failed');
st.patch({ fov: 6, radio: 0.2 });
if (st.get('fov') !== 6 || st.get('radio') !== 0.2) throw new Error('settings.patch failed');
st.reset();
if (st.get('traffic') !== 1 || st.get('firstRun') !== false) throw new Error('settings.reset failed');
const rec = new Records();
if (!rec.submit({ score: 500, topSpeed: 180, distance: 4000 }).includes('punkty')) throw new Error('records.submit broken');
if (rec.submit({ score: 100 }).length) throw new Error('records accepted a worse score');
console.log('settings + records OK');

// ---- traffic lights: crossing axes must never be green at the same time
const { lightStateAt, LIGHT_CYCLE } = await import('../src/world/City.js');
for (let t = 0; t < LIGHT_CYCLE * 4; t += 0.25) {
  if (lightStateAt(t, 3, 4, 'x') === 0 && lightStateAt(t, 3, 4, 'z') === 0) {
    throw new Error('both axes green at once');
  }
}
console.log('light cycle OK');

// ---- collectibles: pickup, combo, drift and respawn
const { Collectibles } = await import('../src/world/Collectibles.js');
const col = new Collectibles(scene, city, 10);
city.time = 0;
let picked = 0;
col.onCollect = () => { picked++; };
const ring = col.items.find((it) => it.state === 0);
car.reset();
car.pos.set(ring.x, 0, ring.z);
car.heading = ring.axisX ? Math.PI / 2 : 0;
col.update(dt, car.pos, car);
if (picked !== 1 || col.score !== 100) throw new Error('ring was not collected');
const ring2 = col.items.find((it) => it.state === 0);
car.pos.set(ring2.x, 0, ring2.z);
col.update(dt, car.pos, car);
if (col.combo !== 3) throw new Error('combo did not rise');
// drift scoring
car.vf = 15; car.skidAmount = 0.8;
for (let i = 0; i < 60; i++) col.update(dt, car.pos, car);
if (col.drift <= 0) throw new Error('drift points did not accrue');
// popped rings respawn somewhere else, count stays constant
for (let i = 0; i < 60 * 20; i++) col.update(dt, car.pos, car);
if (col.items.filter((it) => it.state === 0).length + col.items.filter((it) => it.state === 1).length < 8) {
  throw new Error('rings did not respawn');
}
console.log(`collectibles OK: score=${col.score} drift=${col.drift.toFixed(0)} rings=${col.ringsCollected}`);


// ---- render pipeline: jitter, LUT and profile logic (pure JS, no WebGL)
const { buildLUT, LUT_SIZE, halfToFloat } = await import('../src/render/pipeline/lut.js');
const { JITTER_SEQUENCE, halton23, applyJitter, clearJitter } = await import('../src/render/pipeline/jitter.js');
const { PIPE_PROFILES, Pipeline } = await import('../src/render/Pipeline.js');

// Halton(2,3) stays in [0,1) and its base-2 radical inverse over the first
// 2^k indices has the exact closed-form mean 0.5 - 1/2^(k+1) (low discrepancy)
let hSum = 0;
for (let i = 1; i <= 16; i++) {
  const [hx, hy] = halton23(i);
  if (hx < 0 || hx >= 1 || hy < 0 || hy >= 1) throw new Error('halton23 out of range');
}
for (let i = 0; i < 16; i++) hSum += halton23(i)[0];
if (Math.abs(hSum / 16 - (0.5 - 1 / 32)) > 1e-12) throw new Error('halton23 base-2 mean is not exact');

// jitter: sub-pixel, unbiased, no repeated samples (repeats would waste frames)
if (JITTER_SEQUENCE.length !== 16) throw new Error('jitter sequence length');
const seenJitter = new Set();
let jxSum = 0; let jySum = 0;
for (const [a, b] of JITTER_SEQUENCE) {
  if (Math.abs(a) > 0.5 || Math.abs(b) > 0.5) throw new Error('jitter leaves the pixel footprint');
  const k = `${a.toFixed(4)}:${b.toFixed(4)}`;
  if (seenJitter.has(k)) throw new Error('duplicate jitter sample');
  seenJitter.add(k);
  jxSum += a; jySum += b;
}
if (Math.abs(jxSum) > 0.5 || Math.abs(jySum) > 0.5) throw new Error('jitter sequence is biased');

// one pixel of jitter == 2/width in NDC, and it must be undone after the frame
const jcam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
applyJitter(jcam, 3, 1600, 900);
const want8 = (2 * JITTER_SEQUENCE[3][0]) / 1600;
const want9 = (2 * JITTER_SEQUENCE[3][1]) / 900;
if (Math.abs(jcam.projectionMatrix.elements[8] - want8) > 1e-12) throw new Error('jitter X amplitude');
if (Math.abs(jcam.projectionMatrix.elements[9] - want9) > 1e-12) throw new Error('jitter Y amplitude');
clearJitter(jcam);
if (jcam.projectionMatrix.elements[8] !== 0 || jcam.projectionMatrix.elements[9] !== 0) {
  throw new Error('jitter was not cleared (would double up next frame)');
}

// 3D LUT: 32^3 half-float table, all texels finite and inside [0,1]
const lutNat = buildLUT('natural');
const lutId = buildLUT('none');
if (lutNat.image.width !== LUT_SIZE || lutNat.image.depth !== LUT_SIZE) throw new Error('LUT dimensions');
if (!(lutNat.image.data instanceof Uint16Array)) throw new Error('LUT must be half-float (filterable core in WebGL2)');
const nat = Array.from(lutNat.image.data, halfToFloat);
const ident = Array.from(lutId.image.data, halfToFloat);
let badTexels = 0;
for (const v of nat) if (!Number.isFinite(v) || v < 0 || v > 1) badTexels++;
if (badTexels) throw new Error(`LUT has ${badTexels} invalid texels`);
const lutIdx = (r, g, b) => ((b * LUT_SIZE + g) * LUT_SIZE + r) * 4;
if (Math.abs(ident[lutIdx(16, 16, 16)] - 16 / 31) > 1e-3) throw new Error('bypass LUT is not identity');
if (!(nat[lutIdx(0, 0, 0)] > 0)) throw new Error('natural LUT: blacks not lifted');
if (!(nat[lutIdx(31, 31, 31)] < 1)) throw new Error('natural LUT: whites not rolled off');
if (!(nat[lutIdx(31, 0, 0)] < 1)) throw new Error('natural LUT: saturated red not muted');
if (!(nat[lutIdx(31, 0, 0) + 1] > 0.015)) throw new Error('natural LUT: no split-toning in reds');
if (Math.abs(nat[lutIdx(31, 31, 31)] - nat[lutIdx(31, 31, 31) + 1]) > 1e-3) {
  throw new Error('natural LUT: neutral white must stay neutral');
}
// the grading curve has to be monotonic, otherwise the LUT posterises tones
for (let i = 1; i < LUT_SIZE; i++) {
  if (nat[lutIdx(i, i, i)] < nat[lutIdx(i - 1, i - 1, i - 1)] - 1e-3) {
    throw new Error(`natural LUT: non-monotonic ramp at ${i}`);
  }
}

// profiles: temporal upscaling only ever runs below native resolution,
// and turning it off must fall back to native + MSAA
for (const p of PIPE_PROFILES) {
  if (p.taa && p.renderScale >= 1) throw new Error('TAA without a resolution win');
  if (!p.taa && p.renderScale !== 1) throw new Error('native path must not downscale');
  if (p.velocity && !p.taa) throw new Error('motion vectors without TAA');
}

const stubRenderer = {
  getPixelRatio: () => 1,
  getSize: (v) => v.set(1280, 720),
  getDrawingBufferSize: (v) => v.set(1280, 720),
  setRenderTarget() {}, render() {}, clear() {}, setClearColor() {},
  getRenderTarget: () => null,
  getClearColor: (c) => c.setHex(0x000000),
  getClearAlpha: () => 1,
  autoClear: true,
};
const pcam = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 3200);
const pipe = new Pipeline(stubRenderer, scene, pcam);
pipe.setSize(1920, 1080, 1);
pipe.configure(3, { taa: true, ao: true, dof: true, lut: 'natural' });
if (pipe.internal.w !== Math.round(1920 * 0.7)) throw new Error('ULTRA internal resolution');
if (!pipe.stats.taa || !pipe.stats.ao || !pipe.stats.dof || !pipe.stats.velocity) {
  throw new Error('ULTRA stats incomplete');
}
if (pipe.stats.msaa !== 0) throw new Error('MSAA must be off while TAA runs');
if (!pipe.depthTexture) throw new Error('no depth texture for AO/DOF');

pipe.configure(3, { taa: false, ao: true, dof: true });
if (pipe.scale !== 1 || pipe.stats.msaa !== 4) throw new Error('native fallback must be 1.0x + MSAA');
if (pipe.stats.velocity) throw new Error('velocity pass survived TAA being disabled');

pipe.configure(3, { taa: true, photo: true });
if (pipe.scale !== 1) throw new Error('photo mode must render at full resolution');

// begin/end frame contract: jitter lives only inside the frame
pipe.configure(3, { taa: true });
pipe.registerDynamic(car.group);
pipe.beginFrame();
if (pcam.projectionMatrix.elements[8] === 0) throw new Error('no jitter applied in beginFrame');
const prevBefore = pipe._prevViewProj.clone();
pipe.endFrame();
if (pcam.projectionMatrix.elements[8] !== 0 || pcam.projectionMatrix.elements[9] !== 0) {
  throw new Error('jitter leaked past endFrame');
}
if (pipe._prevViewProj.equals(prevBefore)) throw new Error('previous view-proj not stored');
if (pipe.velocityPass.meshes.length === 0) throw new Error('dynamic meshes not registered');
pipe.dispose();
console.log(`pipeline OK: jitter=16 samples, LUT=${LUT_SIZE}^3, ultra internal ${Math.round(1920 * 0.7)}x${Math.round(1080 * 0.7)}`);

console.log('HEADLESS TEST PASSED ✔');
