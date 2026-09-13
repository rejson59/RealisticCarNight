import { createCanvas } from '@napi-rs/canvas';
import * as THREE from 'three';
globalThis.document = { createElement: (t) => { if (t !== 'canvas') throw new Error(t); return createCanvas(2,2); } };
const { City, CITY } = await import('../src/world/City.js');
const { Car } = await import('../src/world/Car.js');
const { Autopilot } = await import('../src/core/Autopilot.js');
const scene = new THREE.Scene();
const city = new City(scene, null);
const car = new Car(scene);
city.setQuality(3);
const ap = new Autopilot();
car.pos.set(57,0,57); car.heading = Math.PI; car.reset();
ap.snap(car);
const dt = 1/60;
let slow = 0, worst = null;
for (let i=0;i<60*90;i++){
  const inp = ap.update(dt, car);
  const before = car.pos.clone();
  car.update(dt, inp, city);
  const moved = Math.hypot(car.pos.x-before.x, car.pos.z-before.z);
  if (inp.throttle && car.speedKmh < 5) { slow++; if(!worst) worst = {frame:i, x:car.pos.x, z:car.pos.z, dir:ap.dir, i:ap.i, j:ap.j, wp:JSON.stringify(ap.waypoints)}; }
  if (i % (60*10) === 0) console.log(`t=${(i/60).toFixed(0)}s v=${car.speedKmh.toFixed(0)} pos=(${car.pos.x.toFixed(0)},${car.pos.z.toFixed(0)}) hdg=${(car.heading*180/Math.PI).toFixed(0)} dir=${ap.dir} ij=${ap.i},${ap.j} wp0=(${ap.waypoints[0]?.x.toFixed(0)},${ap.waypoints[0]?.z.toFixed(0)}) unstuck=${ap.unstuck.toFixed(1)}`);
}
console.log('slowFrames', slow);
console.log('worst', worst);
