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
for (const n of [0, 5, 18, 9]) traffic.setCount(n);
traffic.update(dt);
console.log('traffic pool OK, positions:', traffic.positions.length / 2);

// straight-line acceleration on an open road
car.reset();
car.pos.set(57, 0, 57);
car.heading = 0; // +z road runs along z at x=57
const straight = { throttle: 1, brake: 0, left: false, right: false, handbrake: false };
for (let i = 0; i < 60 * 5; i++) car.update(dt, straight, city);
console.log(`straight 5 s: ${car.speedKmh.toFixed(0)} km/h at (${car.pos.x.toFixed(1)}, ${car.pos.z.toFixed(1)})`);
if (car.speedKmh < 90) throw new Error('car too slow after 5 s of throttle');
if (Math.abs(car.pos.x - 57) > 2) throw new Error('car drifted off the straight road');

// autopilot: 90 s of self-driving on the grid
const { Autopilot } = await import('../src/core/Autopilot.js');
const ap = new Autopilot();
car.reset();
car.pos.set(57, 0, 57);
car.heading = Math.PI;
ap.snap(car);
let apStuck = 0;
let minSpeed = 999;
for (let i = 0; i < 60 * 90; i++) {
  const ain = ap.update(dt, car);
  if (ain.throttle && car.speedKmh < 5) apStuck++;
  car.update(dt, ain, city);
  if (i > 600) minSpeed = Math.min(minSpeed, car.speedKmh);
  if (!isFinite(car.pos.x) || !isFinite(car.pos.z)) throw new Error('autopilot NaN');
}
console.log(`autopilot 90 s: ${car.speedKmh.toFixed(0)} km/h at (${car.pos.x.toFixed(0)}, ${car.pos.z.toFixed(0)}), slowFrames=${apStuck}`);
if (Math.abs(car.pos.x) > CITY.HALF + 10 || Math.abs(car.pos.z) > CITY.HALF + 10) throw new Error('autopilot left the city');
if (apStuck > 240) throw new Error('autopilot stuck too often');

console.log('HEADLESS TEST PASSED ✔');
