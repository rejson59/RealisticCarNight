import * as THREE from 'three';
import { CITY } from './City.js';
import { mulberry32 } from '../core/utils.js';

/**
 * Ambient AI traffic cruising the grid and the elevated roads.
 * Right-hand traffic, stops at red lights, keeps a gap behind the car in
 * front, lights its brake lamps and acts as a soft collider for the player.
 */
export class Traffic {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.rnd = mulberry32(4242);
    this.cars = [];
    this.pool = [];
    for (let i = 0; i < 22; i++) this.pool.push(this._makeCar());
    this.positions = [];        // flat [x, z, …] for the minimap
    this.colliders = [];        // [{x, z, r}] for player collisions
    this.setCount(10);
  }

  _makeCar() {
    const rnd = this.rnd;
    const g = new THREE.Group();
    const palette = [0x101318, 0x1a1d24, 0x2a0d10, 0x0d1a2a, 0x20242a, 0x101a14, 0x2b2416];
    const paint = new THREE.MeshStandardMaterial({
      color: palette[(rnd() * palette.length) | 0],
      metalness: 0.8, roughness: 0.35, envMapIntensity: 1.2,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 4.3), paint);
    body.position.y = 0.62;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 2.2), new THREE.MeshStandardMaterial({
      color: 0x05070c, metalness: 0.7, roughness: 0.1, envMapIntensity: 1.5,
    }));
    cabin.position.y = 1.12;
    cabin.position.z = -0.15;
    const headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.6, 4.0, 4.4) });
    const tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 0.12, 0.14) });
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.06), headMat);
    hl.position.set(-0.6, 0.66, 2.16);
    const hr = hl.clone(); hr.position.x = 0.6;
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.1, 0.06), tailMat);
    tl.position.set(-0.62, 0.72, -2.16);
    const tr = tl.clone(); tr.position.x = 0.62;
    g.add(body, cabin, hl, hr, tl, tr);
    g.visible = false;
    g.userData.tail = tailMat;
    this.scene.add(g);
    return g;
  }

  /** how many AI cars are on the road (the pool meshes are reused, never duplicated) */
  setCount(n) {
    n = THREE.MathUtils.clamp(Math.round(n) || 0, 0, this.pool.length);
    const wanted = new Set(this.pool.slice(0, n));
    for (const car of this.cars.slice()) {
      if (!wanted.has(car.mesh)) {
        car.mesh.visible = false;
        this.cars.splice(this.cars.indexOf(car), 1);
      }
    }
    for (const mesh of wanted) {
      mesh.visible = true;
      if (!this.cars.some((c) => c.mesh === mesh)) this._spawn(mesh);
    }
  }

  _spawn(mesh) {
    const rnd = this.rnd;
    const { ROAD, HALF, EXTENT } = CITY;
    const useElev = rnd() < 0.22 && this.city.elevCurves.length;
    const car = { mesh };
    if (useElev) {
      car.mode = 'elev';
      car.curve = this.city.elevCurves[(rnd() * this.city.elevCurves.length) | 0];
      car.len = Math.max(1, car.curve.getLength());
      car.u = rnd();
      car.cruise = 15 + rnd() * 9;
      car.speed = car.cruise;
    } else {
      car.mode = 'grid';
      car.axisX = rnd() < 0.5;
      car.lineIdx = (rnd() * this.city.roadLines.length) | 0;
      car.line = this.city.roadLines[car.lineIdx];
      car.dir = rnd() < 0.5 ? 1 : -1;
      // right-hand traffic: for travel +x the right side is -z, for +z it is +x
      car.lane = -car.dir * ROAD * 0.24;
      car.t = -HALF - 20 + rnd() * (EXTENT + 40);
      car.cruise = 9 + rnd() * 7;
      car.speed = car.cruise;
      car.blocked = false;
      car.braking = false;
    }
    this.cars.push(car);
    this._place(car);
  }

  _place(car) {
    if (car.mode === 'elev') {
      const p = car.curve.getPointAt(car.u % 1);
      const t = car.curve.getTangentAt(car.u % 1);
      car.mesh.position.set(p.x, p.y + 0.05, p.z);
      car.mesh.rotation.y = Math.atan2(t.x, t.z);
    } else if (car.axisX) {
      car.mesh.position.set(car.t, 0.02, car.line + car.lane);
      car.mesh.rotation.y = car.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      car.mesh.position.set(car.line - car.lane, 0.02, car.t);
      car.mesh.rotation.y = car.dir > 0 ? 0 : Math.PI;
    }
  }

  /** next intersection ahead of a grid car (+ distance to its centre) */
  _nextNode(car) {
    const lines = this.city.roadLines;
    let best = null;
    for (let k = 0; k < lines.length; k++) {
      const d = (lines[k] - car.t) * car.dir;
      if (d < 3) continue;
      if (!best || d < best.dist) {
        best = { dist: d, i: car.axisX ? k : car.lineIdx, j: car.axisX ? car.lineIdx : k };
      }
    }
    return best;
  }

  /** cars in the same lane keep a gap so traffic queues at the lights */
  _markBlocked() {
    const grid = this.cars.filter((c) => c.mode === 'grid');
    for (const c of grid) c.blocked = false;
    for (let a = 0; a < grid.length; a++) {
      for (let b = 0; b < grid.length; b++) {
        if (a === b) continue;
        const A = grid[a], B = grid[b];
        if (A.axisX !== B.axisX || A.lineIdx !== B.lineIdx || A.dir !== B.dir) continue;
        let gap = (B.t - A.t) * A.dir;
        if (gap > CITY.EXTENT / 2) gap -= CITY.EXTENT + 40;
        if (gap < -CITY.EXTENT / 2) gap += CITY.EXTENT + 40;
        if (gap > 0.5 && gap < 13) A.blocked = true;
      }
    }
  }

  _targetSpeed(car) {
    let v = car.cruise;
    const node = this._nextNode(car);
    if (node && this.city.lightState) {
      const st = this.city.lightState(node.i, node.j, car.axisX ? 'x' : 'z');
      const d = node.dist - (CITY.ROAD / 2 + 2);   // distance to the stop line
      if (st === 2 || (st === 1 && d > 16)) {
        v = Math.min(v, Math.max(0, (d - 5) * 0.55));
      }
    }
    if (car.blocked) v = Math.min(v, 0.4);
    return v;
  }

  update(dt) {
    const { HALF } = CITY;
    this.positions.length = 0;
    this.colliders.length = 0;
    this._markBlocked();
    for (const car of this.cars) {
      if (car.mode === 'elev') {
        car.u = (car.u + (car.speed * dt) / car.len) % 1;
        car.braking = false;
      } else {
        const target = this._targetSpeed(car);
        const dv = target - car.speed;
        car.speed += THREE.MathUtils.clamp(dv, -11 * dt, 5 * dt);
        car.speed = Math.max(0, car.speed);
        car.braking = dv < -0.8 && car.speed > 0.6;
        car.t += car.speed * car.dir * dt;
        if (car.t > HALF + 30) car.t = -HALF - 30;
        if (car.t < -HALF - 30) car.t = HALF + 30;
      }
      this._place(car);
      const p = car.mesh.position;
      this.positions.push(p.x, p.z);
      this.colliders.push({ x: p.x, z: p.z, r: 1.5, y: p.y });
      const tail = car.mesh.userData.tail;
      if (tail) {
        const on = car.braking;
        tail.color.setRGB(on ? 7.0 : 2.6, on ? 0.2 : 0.1, on ? 0.24 : 0.13);
      }
    }
  }
}
