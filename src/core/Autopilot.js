import * as THREE from 'three';
import { CITY } from '../world/City.js';

/**
 * Autopilot: pure-pursuit driving on the road grid.
 * Follows lane centres, slows down before turns, picks random-ish
 * directions at intersections (mostly straight). Any manual input
 * disengages it (handled in main.js).
 */
export class Autopilot {
  constructor() {
    this.enabled = false;
    this.i = 0; this.j = 0;
    this.dir = 'pz';
    this.waypoints = [];
    this.stuck = 0;
    this.unstuck = 0;
    this.rnd = Math.random;
  }

  static dirs() { return ['px', 'nx', 'pz', 'nz']; }

  dirVec(d) {
    switch (d) {
      case 'px': return [1, 0];
      case 'nx': return [-1, 0];
      case 'pz': return [0, 1];
      default: return [0, -1];
    }
  }

  rightVec(d) {
    const [x, z] = this.dirVec(d);
    return [-z, x]; // heading +90° = right side
  }

  line(k) { return -CITY.HALF + k * CITY.S; }

  snap(car) {
    const { S, HALF, N, ROAD } = CITY;
    const u = car.pos.x + HALF, w = car.pos.z + HALF;
    const i = THREE.MathUtils.clamp(Math.round(u / S), 0, N);
    const j = THREE.MathUtils.clamp(Math.round(w / S), 0, N);
    const du = u - i * S, dw = w - j * S; // offset from nearest road lines
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    const onZ = Math.abs(du) <= ROAD / 2 + 3;   // road running along z
    const onX = Math.abs(dw) <= ROAD / 2 + 3;   // road running along x
    let dir;
    if (onZ && (!onX || Math.abs(du) <= Math.abs(dw))) dir = fz >= 0 ? 'pz' : 'nz';
    else if (onX) dir = fx >= 0 ? 'px' : 'nx';
    else dir = Math.abs(du) < Math.abs(dw) ? (fz >= 0 ? 'pz' : 'nz') : (fx >= 0 ? 'px' : 'nx');
    this.i = i; this.j = j; this.dir = dir;
    this.waypoints = [];
    this._pushNext();
    this._pushNext();
    this.stuck = 0; this.unstuck = 0;
  }

  _advance(dir) {
    if (dir === 'px') this.i = Math.min(CITY.N, this.i + 1);
    else if (dir === 'nx') this.i = Math.max(0, this.i - 1);
    else if (dir === 'pz') this.j = Math.min(CITY.N, this.j + 1);
    else this.j = Math.max(0, this.j - 1);
  }

  _pushNext() {
    const [rx, rz] = this.rightVec(this.dir);
    this._advance(this.dir);
    this.waypoints.push({
      x: this.line(this.i) + rx * 6,
      z: this.line(this.j) + rz * 6,
      dir: this.dir,
    });
  }

  _pickDir() {
    const r = this.rnd();
    const [dx, dz] = this.dirVec(this.dir);
    const left = this.dir === 'px' ? 'pz' : this.dir === 'pz' ? 'nx' : this.dir === 'nx' ? 'nz' : 'px';
    const right = this.dir === 'px' ? 'nz' : this.dir === 'nz' ? 'nx' : this.dir === 'nx' ? 'px' : 'pz';
    const back = this.dir === 'px' ? 'nx' : this.dir === 'nx' ? 'px' : this.dir === 'pz' ? 'nz' : 'pz';
    void dx; void dz;
    let choice = r < 0.62 ? this.dir : r < 0.81 ? left : right;
    // don't drive off the city edge
    const [cx, cz] = this.dirVec(choice);
    const ni = this.i + (cx === 1 ? 1 : cx === -1 ? -1 : 0);
    const nj = this.j + (cz === 1 ? 1 : cz === -1 ? -1 : 0);
    if (ni < 0 || ni > CITY.N || nj < 0 || nj > CITY.N) choice = back === choice ? this.dir : back;
    return choice;
  }

  update(dt, car) {
    const out = { throttle: 0, brake: 0, left: false, right: false, handbrake: false };
    if (this.unstuck > 0) {
      this.unstuck -= dt;
      out.throttle = 0; out.brake = 1; // reverse straight away from the wall
      if (this.unstuck <= 0) this.snap(car);
      return out;
    }
    const wp1 = this.waypoints[0];
    const wp2 = this.waypoints[1];
    if (!wp1 || !wp2) { this.snap(car); return out; }

    const d1 = Math.hypot(wp1.x - car.pos.x, wp1.z - car.pos.z);
    // advance when close enough OR when we've crossed the waypoint's plane
    const [wdx, wdz] = this.dirVec(wp1.dir);
    const crossed = (car.pos.x - wp1.x) * wdx + (car.pos.z - wp1.z) * wdz > 2;
    if (d1 < 16 || crossed) {
      this.waypoints.shift();
      this.dir = this._pickDir();
      this._pushNext();
      return this.update(dt, car);
    }

    // aim point: blend wp1 -> wp2 when close, so turns cut smoothly
    let ax = wp1.x, az = wp1.z;
    if (d1 < 14) {
      const t = ((14 - d1) / 14) * 0.35; // gentle corner cut, stays on asphalt
      ax = THREE.MathUtils.lerp(wp1.x, wp2.x, t);
      az = THREE.MathUtils.lerp(wp1.z, wp2.z, t);
    }
    const speed = car.speedKmh / 3.6;

    // target speed: slow for upcoming turns
    const turning = wp1.dir !== wp2.dir;
    let target = 12.5;
    if (turning && d1 < 34) target = 7.0;
    if (this.dir !== wp2.dir && d1 < 60) target = Math.min(target, 10);

    const headingErr = Math.atan2(ax - car.pos.x, az - car.pos.z) - car.heading;
    const wrapped = Math.atan2(Math.sin(headingErr), Math.cos(headingErr));
    const steerCmd = THREE.MathUtils.clamp(wrapped * 1.5, -1, 1);
    out.steer = steerCmd;   // proportional — the car smooths it internally
    out.right = steerCmd > 0.15;
    out.left = steerCmd < -0.15;
    out.throttle = speed < target ? 1 : 0;
    out.brake = speed > target + 3.5 ? 0.55 : 0;

    // stuck detection (wall graze etc.)
    if (out.throttle && speed < 1.2) this.stuck += dt;
    else this.stuck = 0;
    if (this.stuck > 2.5) { this.unstuck = 1.4; this.stuck = 0; }
    return out;
  }
}
