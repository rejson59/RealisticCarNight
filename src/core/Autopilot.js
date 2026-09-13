import * as THREE from 'three';
import { CITY, lightStateAt } from '../world/City.js';
import { mulberry32 } from './utils.js';

/**
 * Autopilot — pure pursuit over a planned route on the road grid.
 *
 * The route is a polyline of lane points: right-hand traffic, one point per
 * intersection plus an entry/exit pair whenever we turn, so corners are cut
 * along a proper arc instead of scraping the kerb. It obeys traffic lights,
 * brakes for the car in front, never U-turns unless cornered and knows how to
 * reverse out when it gets wedged against a wall.
 */
const LANE = 6.2;                       // lane centre offset from the road centreline
const CRUISE = 13.4;                    // m/s (~48 km/h)
const CORNER = 5.8;                     // m/s (~21 km/h)
const STOP_LINE = CITY.ROAD / 2 + 2.0;  // how far before a node centre we halt
const CORNER_PAD = 8;                   // entry/exit points around a turning node

const VEC = { px: [1, 0], nx: [-1, 0], pz: [0, 1], nz: [0, -1] };
const LEFT = { px: 'pz', pz: 'nx', nx: 'nz', nz: 'px' };
const RIGHT = { px: 'nz', nz: 'nx', nx: 'pz', pz: 'px' };
const BACK = { px: 'nx', nx: 'px', pz: 'nz', nz: 'pz' };

export class Autopilot {
  constructor(seed = 20260912) {
    this.enabled = false;
    this.rng = mulberry32(seed);        // deterministic: same drive every run
    this.i = 0;
    this.j = 0;
    this.dir = 'pz';
    this.route = [];                    // upcoming waypoints
    this.stuck = 0;
    this.unstuck = 0;
    this.unstuckSteer = 0;
    this.redWait = 0;
    this.ignoreLights = 0;
    this.city = null;
    this.debug = null;
  }

  static dirs() { return ['px', 'nx', 'pz', 'nz']; }

  dirVec(d) { return VEC[d] || VEC.pz; }

  /** right-hand traffic: for dir [dx, dz] the right side is [dz, -dx] */
  rightVec(d) { const [x, z] = this.dirVec(d); return [z, -x]; }

  line(k) { return -CITY.HALF + k * CITY.S; }

  _inBounds(i, j) { return i >= 0 && i <= CITY.N && j >= 0 && j <= CITY.N; }

  _advance(i, j, d) {
    const [dx, dz] = this.dirVec(d);
    return [i + dx, j + dz];
  }

  /* -------------------------------------------------------------- snap */
  /** Attach the autopilot to the car: figure out road, lane and direction. */
  snap(car, city) {
    if (city) this.city = city;
    const { S, HALF, N, ROAD } = CITY;
    const u = car.pos.x + HALF, w = car.pos.z + HALF;
    const i = THREE.MathUtils.clamp(Math.round(u / S), 0, N);
    const j = THREE.MathUtils.clamp(Math.round(w / S), 0, N);
    const du = u - i * S;   // lateral offset from the road running along Z
    const dw = w - j * S;   // lateral offset from the road running along X
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    const onZ = Math.abs(du) <= ROAD / 2 + 4;
    const onX = Math.abs(dw) <= ROAD / 2 + 4;
    let dir;
    if (onZ && (!onX || Math.abs(du) <= Math.abs(dw))) dir = fz >= 0 ? 'pz' : 'nz';
    else if (onX) dir = fx >= 0 ? 'px' : 'nx';
    else dir = Math.abs(du) < Math.abs(dw) ? (fz >= 0 ? 'pz' : 'nz') : (fx >= 0 ? 'px' : 'nx');

    // node we have just passed (so the next planned node is in front of us)
    let ni = i, nj = j;
    if (dir === 'pz') nj = Math.floor(w / S);
    else if (dir === 'nz') nj = Math.ceil(w / S);
    else if (dir === 'px') ni = Math.floor(u / S);
    else ni = Math.ceil(u / S);
    ni = THREE.MathUtils.clamp(ni, 0, N);
    nj = THREE.MathUtils.clamp(nj, 0, N);

    let guard = 0;
    while (!this._inBounds(...this._advance(ni, nj, dir)) && guard++ < 4) dir = LEFT[dir];

    this.i = ni; this.j = nj; this.dir = dir;
    this.route = [];
    this._plan(); this._plan();
    this.stuck = 0; this.unstuck = 0; this.redWait = 0;
  }

  /* -------------------------------------------------------- route plan */
  /** Direction choice at node (i, j) when arriving with `dir`. */
  _pickDir(i, j, dir) {
    const cands = [dir, LEFT[dir], RIGHT[dir]].filter(
      (c) => this._inBounds(...this._advance(i, j, c))
    );
    if (!cands.length) return BACK[dir];       // cornered: U-turn
    if (cands.length === 1) return cands[0];
    const r = this.rng();
    const w = cands.map((c) => (c === dir ? 0.64 : 0.18));
    const sum = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let k = 0; k < cands.length; k++) {
      acc += w[k] / sum;
      if (r <= acc) return cands[k];
    }
    return cands[cands.length - 1];
  }

  /** Append the waypoint(s) for the next node and move the state forward. */
  _plan() {
    let [pi, pj] = this._advance(this.i, this.j, this.dir);
    let here = false;
    if (!this._inBounds(pi, pj)) { pi = this.i; pj = this.j; here = true; }
    const nd = this._pickDir(pi, pj, this.dir);
    const px = this.line(pi), pz = this.line(pj);
    const [dx, dz] = this.dirVec(this.dir);
    const [rx, rz] = this.rightVec(this.dir);
    if (nd !== this.dir) {
      this.route.push({
        x: px + rx * LANE - dx * CORNER_PAD,
        z: pz + rz * LANE - dz * CORNER_PAD,
        dir: this.dir, i: pi, j: pj, corner: true, here,
      });
      const [ex, ez] = this.dirVec(nd);
      const [erx, erz] = this.rightVec(nd);
      this.route.push({
        x: px + erx * LANE + ex * CORNER_PAD,
        z: pz + erz * LANE + ez * CORNER_PAD,
        dir: nd, i: pi, j: pj, corner: false, exit: true, here,
      });
    } else {
      this.route.push({
        x: px + rx * LANE, z: pz + rz * LANE,
        dir: this.dir, i: pi, j: pj, corner: false, here,
      });
    }
    this.i = pi; this.j = pj; this.dir = nd;
  }

  /** Drop the waypoints we already passed and keep the route long enough. */
  _consume(car) {
    let guard = 0;
    while (this.route.length && guard++ < 12) {
      const wp = this.route[0];
      const [dx, dz] = this.dirVec(wp.dir);
      const along = (car.pos.x - wp.x) * dx + (car.pos.z - wp.z) * dz;
      const d = Math.hypot(car.pos.x - wp.x, car.pos.z - wp.z);
      if (along > 1.5 || d < 3.2) { this.route.shift(); this._plan(); }
      else break;
    }
    guard = 0;
    while (this.route.length < 4 && guard++ < 12) this._plan();
  }

  /** Point `look` metres ahead along the route polyline (no corner cutting). */
  _aim(car, look) {
    let rem = look;
    let px = car.pos.x, pz = car.pos.z;
    for (const wp of this.route) {
      const d = Math.hypot(wp.x - px, wp.z - pz);
      if (d >= rem) {
        const t = rem / Math.max(d, 1e-4);
        return { x: px + (wp.x - px) * t, z: pz + (wp.z - pz) * t };
      }
      rem -= d; px = wp.x; pz = wp.z;
    }
    return { x: px, z: pz };
  }

  /** Route distance to the next turning entry point. */
  _distToCorner(car) {
    let d = 0, px = car.pos.x, pz = car.pos.z;
    for (const wp of this.route) {
      const seg = Math.hypot(wp.x - px, wp.z - pz);
      if (wp.corner) return d + Math.max(0, seg - CORNER_PAD * 0.5);
      d += seg; px = wp.x; pz = wp.z;
      if (d > 260) break;
    }
    return Infinity;
  }

  /** Nearest red (or unmakeable yellow) stop line ahead, or null. */
  _redStop(car) {
    const city = this.city;
    if (!city || this.ignoreLights > 0) return null;
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    let seen = null;
    for (const wp of this.route) {
      const key = wp.i * 31 + wp.j * 7;
      if (key === seen) continue;
      seen = key;
      const [dx, dz] = this.dirVec(wp.dir);
      const [rx, rz] = this.rightVec(wp.dir);
      const sx = this.line(wp.i) + rx * LANE - dx * STOP_LINE;
      const sz = this.line(wp.j) + rz * LANE - dz * STOP_LINE;
      const along = (sx - car.pos.x) * fx + (sz - car.pos.z) * fz;
      if (along < 2.5) continue;                 // already in the intersection
      const lat = Math.abs((sx - car.pos.x) * fz - (sz - car.pos.z) * fx);
      if (lat > 26) continue;
      const st = lightStateAt(city.time, wp.i, wp.j, wp.dir === 'px' || wp.dir === 'nx' ? 'x' : 'z');
      if (st === 2) return { x: sx, z: sz, along };
      if (st === 1 && along > 26) return { x: sx, z: sz, along };
    }
    return null;
  }

  /** Is there another car right in front of us? */
  _blocked(car, positions) {
    if (!positions || !positions.length) return false;
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);
    for (let k = 0; k < positions.length; k += 2) {
      const dx = positions[k] - car.pos.x, dz = positions[k + 1] - car.pos.z;
      const along = dx * fx + dz * fz;
      if (along < 1.5 || along > 14) continue;
      if (Math.abs(dx * fz - dz * fx) < 2.7) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------ update */
  /**
   * @param {number} dt
   * @param {import('../world/Car.js').Car} car
   * @param {import('../world/City.js').City} [city]
   * @param {number[]} [trafficPositions] flat [x, z, x, z, …] list
   */
  update(dt, car, city, trafficPositions) {
    if (city) this.city = city;
    const out = { throttle: 0, brake: 0, left: false, right: false, handbrake: false, steer: 0 };
    if (this.ignoreLights > 0) this.ignoreLights -= dt;

    // ---- wedged against something: reverse out, then re-plan from scratch
    if (this.unstuck > 0) {
      this.unstuck -= dt;
      out.brake = 1;
      out.steer = this.unstuckSteer;
      out.left = this.unstuckSteer < -0.1;
      out.right = this.unstuckSteer > 0.1;
      if (this.unstuck <= 0) this.snap(car, this.city);
      this.debug = { mode: 'unstuck' };
      return out;
    }

    this._consume(car);
    const wp0 = this.route[0];
    if (!wp0) { this.snap(car, this.city); return out; }

    const speed = car.speedKmh / 3.6;
    const look = 7.5 + speed * 0.85;
    const aim = this._aim(car, look);

    // ---- steering (proportional + a bit of slip damping)
    const err = Math.atan2(aim.x - car.pos.x, aim.z - car.pos.z) - car.heading;
    const wrapped = Math.atan2(Math.sin(err), Math.cos(err));
    let steerCmd = THREE.MathUtils.clamp(wrapped * 1.7 - car.vl * 0.025, -1, 1);

    // ---- target speed
    let target = CRUISE;
    const dc = this._distToCorner(car);
    if (dc < 95) {
      target = Math.min(target, THREE.MathUtils.lerp(CORNER, CRUISE, THREE.MathUtils.clamp((dc - 10) / 75, 0, 1)));
    }
    const stop = this._redStop(car);
    let hold = false;
    if (stop) {
      const braking = speed * speed / 9;              // comfortable stopping distance
      if (stop.along < Math.max(6, braking + 4)) { target = 0; hold = true; }
      else target = Math.min(target, 8);              // creep to the line
    } else if (this._blocked(car, trafficPositions)) {
      target = Math.min(target, 1.5);
      hold = true;
    }

    out.steer = steerCmd;
    out.left = steerCmd < -0.15;
    out.right = steerCmd > 0.15;
    const dv = target - speed;
    out.throttle = hold ? 0 : THREE.MathUtils.clamp(dv * 0.55, 0, 1);
    out.brake = THREE.MathUtils.clamp(-dv * 0.42, 0, hold ? 0.9 : 0.7);

    // ---- stuck detection
    if (out.throttle > 0.2 && speed < 1.3) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt * 2);
    if (this.stuck > 2.2) {
      this.stuck = 0;
      this.unstuck = 1.5;
      this.unstuckSteer = this.rng() < 0.5 ? -0.85 : 0.85;
      this.ignoreLights = 8;
    }
    // waiting at a red for ages (queue of traffic) -> creep through
    if (hold && speed < 0.8) this.redWait += dt;
    else this.redWait = Math.max(0, this.redWait - dt);
    if (this.redWait > 18) { this.redWait = 0; this.ignoreLights = 10; }

    this.debug = { dir: this.dir, node: [this.i, this.j], dc, stop: !!stop, target, aim };
    return out;
  }
}
