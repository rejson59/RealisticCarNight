import * as THREE from 'three';
import { CITY } from './City.js';
import { mulberry32 } from '../core/utils.js';

/** Ambient AI cars cruising the grid + the elevated loop, with lit lamps. */
export class Traffic {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.rnd = mulberry32(4242);
    this.cars = [];
    this.pool = [];
    for (let i = 0; i < 22; i++) this.pool.push(this._makeCar());
    this.positions = [];
    this.setCount(10);
  }

  _makeCar() {
    const rnd = this.rnd;
    const g = new THREE.Group();
    const palette = [0x101318, 0x1a1d24, 0x2a0d10, 0x0d1a2a, 0x20242a, 0x101a14];
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
    this.scene.add(g);
    return g;
  }

  setCount(n) {
    this.pool.forEach((c, i) => {
      const active = i < n;
      c.visible = active;
      if (active && !this.cars.includes(c)) this._spawn(c);
      if (!active && this.cars.includes(c)) this.cars.splice(this.cars.indexOf(c), 1);
    });
    while (this.cars.length < n) {
      const c = this.pool.find((p) => p.visible && !this.cars.includes(p));
      if (!c) break;
      this._spawn(c);
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
      car.u = rnd();
      car.speed = 14 + rnd() * 10;
    } else {
      car.mode = 'grid';
      car.axisX = rnd() < 0.5;
      car.line = this.city.roadLines[(rnd() * this.city.roadLines.length) | 0];
      car.dir = rnd() < 0.5 ? 1 : -1;
      car.lane = car.dir * ROAD * 0.24;
      car.t = -HALF - 20 + rnd() * (EXTENT + 40);
      car.speed = 9 + rnd() * 9;
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

  update(dt) {
    const { HALF } = CITY;
    this.positions.length = 0;
    for (const car of this.cars) {
      if (car.mode === 'elev') {
        car.u = (car.u + (car.speed * dt) / 1600) % 1;
      } else {
        car.t += car.speed * car.dir * dt;
        if (car.t > HALF + 30) car.t = -HALF - 30;
        if (car.t < -HALF - 30) car.t = HALF + 30;
      }
      this._place(car);
      this.positions.push(car.mesh.position.x, car.mesh.position.z);
    }
  }
}
