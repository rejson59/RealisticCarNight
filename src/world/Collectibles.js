import * as THREE from 'three';
import { CITY } from './City.js';
import { mulberry32, canvasTexture, radialGlowTexture } from '../core/utils.js';

/**
 * Neon rings floating over the lanes. Drive through them for points;
 * back-to-back pickups raise a combo multiplier. Drift points accrue while
 * the tyres scrub. One instanced mesh per layer (ring, ground glow, beacon).
 */
const PALETTE = [
  [0.25, 2.1, 2.5],   // cyan
  [2.4, 0.3, 1.1],    // magenta
  [0.5, 2.3, 1.2],    // mint
  [2.3, 1.4, 0.35],   // amber
  [1.4, 0.6, 2.5],    // violet
];

export class Collectibles {
  constructor(scene, city, count = 24) {
    this.scene = scene;
    this.city = city;
    this.count = count;
    this.rnd = mulberry32(9001);
    this.items = [];
    this.enabled = true;
    this.time = 0;
    this.score = 0;
    this.ringsCollected = 0;
    this.combo = 1;
    this.comboTimer = 0;
    this.drift = 0;
    this.positions = [];
    this.onCollect = null;      // (points, combo) => {}
    this._build();
    for (let i = 0; i < count; i++) {
      const it = { state: 0, pop: 0, respawn: 0, phase: this.rnd() * 7, axisX: false, x: 0, z: 0, yaw: 0, tint: 0 };
      this.items.push(it);
      this._place(it, true);
    }
    this._writeAll();
  }

  _build() {
    const N = this.count;

    // the ring itself
    const ringGeo = new THREE.TorusGeometry(1.25, 0.09, 10, 30);
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.ringMesh = new THREE.InstancedMesh(ringGeo, this.ringMat, N);
    this.ringMesh.frustumCulled = false;
    this.scene.add(this.ringMesh);

    // wet-asphalt glow under each ring (also mirrors in the puddles)
    const glowGeo = new THREE.PlaneGeometry(4.6, 4.6);
    glowGeo.rotateX(-Math.PI / 2);
    this.glowMat = new THREE.MeshBasicMaterial({
      map: canvasTexture(radialGlowTexture(128)),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      color: 0xffffff, opacity: 0.5,
    });
    this.glowMesh = new THREE.InstancedMesh(glowGeo, this.glowMat, N);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 2;
    this.scene.add(this.glowMesh);

    // tall view-facing beacon so rings are findable from far away
    const beamGeo = new THREE.PlaneGeometry(1, 1);
    this.beamMat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 aColor;
        varying vec3 vColor;
        varying vec2 vUv2;
        void main(){
          vec4 mv = viewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float sx = length(instanceMatrix[0].xyz);
          float sy = length(instanceMatrix[1].xyz);
          mv.xy += position.xy * vec2(sx, sy);
          gl_Position = projectionMatrix * mv;
          vColor = aColor;
          vUv2 = uv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying vec2 vUv2;
        void main(){
          float side = smoothstep(0.0, 0.35, vUv2.x) * smoothstep(1.0, 0.65, vUv2.x);
          float up = pow(1.0 - vUv2.y, 1.8);
          float a = side * up * 0.55;
          gl_FragColor = vec4(vColor * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.beamMesh = new THREE.InstancedMesh(beamGeo, this.beamMat, N);
    this.beamMesh.frustumCulled = false;
    this.beamColors = new Float32Array(N * 3);
    beamGeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(this.beamColors, 3));
    this.scene.add(this.beamMesh);

    this._m4 = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._v = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  /** random lane spot on a mid-block stretch of road */
  _place(it, first = false) {
    const { ROAD, HALF, EXTENT } = CITY;
    const lines = this.city.roadLines;
    for (let tries = 0; tries < 12; tries++) {
      it.axisX = this.rnd() < 0.5;
      const line = lines[(this.rnd() * lines.length) | 0];
      const lane = (this.rnd() < 0.5 ? -1 : 1) * ROAD * 0.24;
      let along = -HALF + 16 + this.rnd() * (EXTENT - 32);
      // keep rings clear of intersections so they sit on open asphalt
      let ok = true;
      for (const L of lines) {
        if (Math.abs(along - L) < 15) { ok = false; break; }
      }
      if (!ok) continue;
      it.x = it.axisX ? along : line + lane;
      it.z = it.axisX ? line + lane : along;
      it.yaw = it.axisX ? Math.PI / 2 : 0;
      break;
    }
    it.tint = (this.rnd() * PALETTE.length) | 0;
    it.state = 0;
    it.pop = 0;
    it.respawn = 0;
    if (!first) this._write(it, this.items.indexOf(it));
  }

  setEnabled(on) {
    this.enabled = on;
    this.ringMesh.visible = on;
    this.glowMesh.visible = on;
    this.beamMesh.visible = on;
  }

  reset() {
    this.score = 0; this.ringsCollected = 0; this.combo = 1; this.comboTimer = 0; this.drift = 0;
    this.items.forEach((it, i) => { this._place(it, true); this._write(it, i); });
  }

  /* ------------------------------------------------------------- update */
  update(dt, carPos, car) {
    this.time += dt;
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 1;
    }
    // drift scoring: scrub + speed = points
    if (car && this.enabled) {
      const scrub = car.skidAmount;
      if (scrub > 0.2 && car.speedKmh > 28) {
        this.drift += scrub * car.speedKmh * dt * 0.55;
      }
    }

    this.positions.length = 0;
    let dirty = false;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.state === 2) {
        if (this.time > it.respawn) { this._place(it); dirty = true; }
        else continue;
      }
      if (it.state === 1) {
        it.pop += dt;
        if (it.pop > 0.45) {
          it.state = 2;
          it.respawn = this.time + 2.5 + this.rnd() * 5;
        }
        dirty = true;
      } else if (this.enabled && carPos) {
        const d = Math.hypot(carPos.x - it.x, carPos.z - it.z);
        if (d < 2.1) {
          it.state = 1; it.pop = 0;
          this.ringsCollected += 1;
          const points = Math.round(100 * this.combo);
          this.score += points;
          this.combo = Math.min(9, this.combo + 1);
          this.comboTimer = 6.5;
          this.onCollect?.(points, this.combo);
          dirty = true;
        }
      }
      if (it.state === 0) this.positions.push(it.x, it.z);
      dirty = true;   // bobbing/wobble animates every frame anyway
    }
    if (dirty) this._writeAll();
  }

  _writeAll() {
    for (let i = 0; i < this.items.length; i++) this._write(this.items[i], i);
  }

  _write(it, i) {
    const t = this.time;
    let scale = 1, glow = 1, beam = 1;
    let y = 1.12 + Math.sin(t * 1.9 + it.phase) * 0.09;
    if (it.state === 1) {
      const p = Math.min(1, it.pop / 0.45);
      scale = 1 + p * 1.1;
      glow = beam = 1 - p;
    } else if (it.state === 2) {
      scale = 0.0001; glow = 0; beam = 0;
    }
    const wobble = Math.sin(t * 1.3 + it.phase) * 0.4;

    // ring
    this._e.set(0, it.yaw + wobble, 0);
    this._q.setFromEuler(this._e);
    this._v.set(scale, scale, scale);
    this._m4.compose(this._p.set(it.x, y, it.z), this._q, this._v);
    this.ringMesh.setMatrixAt(i, this._m4);
    const col = PALETTE[it.tint];
    this._c.setRGB(col[0] * glow, col[1] * glow, col[2] * glow);
    this.ringMesh.setColorAt(i, this._c);

    // ground glow
    this._e.set(0, 0, 0);
    this._q.setFromEuler(this._e);
    this._v.set(scale * (1 + Math.sin(t * 2.2 + it.phase) * 0.06), 1, scale);
    this._m4.compose(this._p.set(it.x, 0.09, it.z), this._q, this._v);
    this.glowMesh.setMatrixAt(i, this._m4);
    this._c.setRGB(col[0] * glow * 0.5, col[1] * glow * 0.5, col[2] * glow * 0.5);
    this.glowMesh.setColorAt(i, this._c);

    // beacon beam
    this._v.set(1.1 * scale, 7.5, 1);
    this._m4.compose(this._p.set(it.x, 3.7, it.z), this._q, this._v);
    this.beamMesh.setMatrixAt(i, this._m4);
    this.beamColors[i * 3] = col[0] * beam * 0.5;
    this.beamColors[i * 3 + 1] = col[1] * beam * 0.5;
    this.beamColors[i * 3 + 2] = col[2] * beam * 0.5;

    this.ringMesh.instanceMatrix.needsUpdate = true;
    if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
    this.glowMesh.instanceMatrix.needsUpdate = true;
    if (this.glowMesh.instanceColor) this.glowMesh.instanceColor.needsUpdate = true;
    this.beamMesh.instanceMatrix.needsUpdate = true;
    this.beamMesh.geometry.attributes.aColor.needsUpdate = true;
  }
}
