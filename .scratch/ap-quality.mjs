import { createCanvas } from '@napi-rs/canvas';
import * as THREE from 'three';
globalThis.document = { createElement: (t) => { if (t !== 'canvas') throw new Error(t); return createCanvas(2,2); } };
const { City, CITY } = await import('../src/world/City.js');
const { Car } = await import('../src/world/Car.js');
const { Traffic } = await import('../src/world/Traffic.js');
const { Autopilot } = await import('../src/core/Autopilot.js');
const scene = new THREE.Scene();
const city = new City(scene, null); city.setQuality(3);
const car = new Car(scene);
const traffic = new Traffic(scene, city); traffic.setCount(14);
city.dynamicColliders = traffic.colliders;
const dt = 1/60;
function run(seed, seconds) {
  const ap = new Autopilot(seed);
  car.reset(); car.pos.set(57,0,57); car.heading = Math.PI;
  ap.snap(car, city);
  let sum=0, n=0, stopped=0, offroad=0, hits=0, maxOff=0;
  for (let i=0;i<60*seconds;i++){
    city.update(dt, car.pos); traffic.update(dt);
    const inp = ap.update(dt, car, city, traffic.positions);
    const before = car.pos.clone();
    car.update(dt, inp, city);
    if (Math.hypot(car.pos.x-before.x, car.pos.z-before.z) < 1e-7 && inp.throttle>0.2) hits++;
    sum += car.speedKmh; n++;
    if (car.speedKmh < 2) stopped++;
    // lateral offset from nearest road centreline
    const u = car.pos.x + CITY.HALF, w = car.pos.z + CITY.HALF;
    const du = Math.abs(u - Math.round(u/CITY.S)*CITY.S);
    const dw = Math.abs(w - Math.round(w/CITY.S)*CITY.S);
    const off = Math.min(du, dw);
    maxOff = Math.max(maxOff, off);
    if (off > CITY.ROAD/2) offroad++;
  }
  console.log(`seed ${seed}: avg ${(sum/n).toFixed(1)} km/h, stopped ${(100*stopped/n).toFixed(1)}%, offroad ${(100*offroad/n).toFixed(2)}%, maxOff ${maxOff.toFixed(1)}, blockedFrames ${hits}, end (${car.pos.x.toFixed(0)},${car.pos.z.toFixed(0)})`);
}
for (const s of [20260912, 7, 999, 31337]) run(s, 180);
