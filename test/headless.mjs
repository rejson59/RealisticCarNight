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

console.log('HEADLESS TEST PASSED ✔');
