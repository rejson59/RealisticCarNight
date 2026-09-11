import * as THREE from 'three';
import { canvasTexture, headlightPoolTexture } from '../core/utils.js';

/**
 * Procedural night-street coupe (black paint, tinted glass, spoiler,
 * glowing light bars) + arcade physics with a drift-friendly handbrake.
 */
export class Car {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);

    // -------------------------------------------------- materials
    this.paint = new THREE.MeshPhysicalMaterial({
      color: 0x11131a,
      metalness: 0.55,
      roughness: 0.24,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      envMapIntensity: 2.6,
      reflectivity: 0.9,
    });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x05070c,
      metalness: 0.7,
      roughness: 0.06,
      envMapIntensity: 2.0,
      clearcoat: 1,
    });
    const darkTrim = new THREE.MeshStandardMaterial({ color: 0x0a0b0e, roughness: 0.6, metalness: 0.4 });
    this.headMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4.5, 5.0, 5.6) });
    this.tailMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.2, 0.12, 0.15) });

    // -------------------------------------------------- body (extruded side profile)
    const profile = new THREE.Shape();
    const pts = [
      [-2.28, 0.42], [-2.34, 0.72], [-2.26, 1.00], [-1.55, 1.04],
      [-1.18, 1.06], [1.02, 1.04], [1.86, 0.98], [2.30, 0.86],
      [2.34, 0.62], [2.24, 0.40], [1.9, 0.32], [-1.9, 0.32],
    ];
    profile.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) profile.lineTo(pts[i][0], pts[i][1]);
    profile.closePath();
    const bodyGeo = new THREE.ExtrudeGeometry(profile, {
      depth: 1.72, bevelEnabled: true, bevelThickness: 0.10, bevelSize: 0.10, bevelSegments: 3, steps: 1,
    });
    bodyGeo.rotateY(-Math.PI / 2);
    bodyGeo.translate(0, 0, 0);
    bodyGeo.computeVertexNormals();
    const body = new THREE.Mesh(bodyGeo, this.paint);
    body.position.x = 0.86; // center the extruded width (bevel included)
    body.castShadow = true;
    this.group.add(body);

    // glass canopy
    const canopy = new THREE.Shape();
    const cp = [
      [-1.20, 1.02], [-0.62, 1.42], [0.30, 1.40], [0.98, 1.02],
      [0.80, 0.98], [-1.02, 0.98],
    ];
    canopy.moveTo(cp[0][0], cp[0][1]);
    for (let i = 1; i < cp.length; i++) canopy.lineTo(cp[i][0], cp[i][1]);
    canopy.closePath();
    const canopyGeo = new THREE.ExtrudeGeometry(canopy, {
      depth: 1.5, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2, steps: 1,
    });
    canopyGeo.rotateY(-Math.PI / 2);
    const canopyMesh = new THREE.Mesh(canopyGeo, glass);
    canopyMesh.position.x = 0.75;
    this.group.add(canopyMesh);

    // roof panel
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.06, 1.0), this.paint);
    roof.position.set(0, 1.43, -0.14);
    roof.rotation.x = -0.02;
    this.group.add(roof);

    // spoiler
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.05, 0.34), this.paint);
    wing.position.set(0, 1.16, -2.12);
    wing.rotation.x = 0.14;
    this.group.add(wing);
    for (const sx of [-0.6, 0.6]) {
      const sup = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.16), darkTrim);
      sup.position.set(sx, 1.06, -2.08);
      this.group.add(sup);
    }

    // front grille + mirrors + sills
    const grille = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.22, 0.1), darkTrim);
    grille.position.set(0, 0.62, 2.30);
    this.group.add(grille);
    for (const sx of [-1, 1]) {
      const mir = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.22), this.paint);
      mir.position.set(sx * 0.95, 1.06, 0.72);
      this.group.add(mir);
      const sill = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 2.6), darkTrim);
      sill.position.set(sx * 0.86, 0.36, 0);
      this.group.add(sill);
    }

    // light bars
    const hlL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.13, 0.08), this.headMat);
    hlL.position.set(-0.62, 0.80, 2.32);
    const hlR = hlL.clone(); hlR.position.x = 0.62;
    this.group.add(hlL, hlR);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.11, 0.06), this.tailMat);
    tail.position.set(0, 0.86, -2.32);
    this.group.add(tail);
    this.tailMesh = tail;

    // interior glow (dashboard + cabin light) — like the screenshots
    const dash = new THREE.Mesh(
      new THREE.PlaneGeometry(1.1, 0.28),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.4, 1.0, 0.55) })
    );
    dash.position.set(0, 1.0, 0.62);
    dash.rotation.x = -0.5;
    this.group.add(dash);
    this.cabinLight = new THREE.PointLight(0xffc98a, 2.2, 4.5, 2);
    this.cabinLight.position.set(0, 1.25, 0.1);
    this.group.add(this.cabinLight);

    // -------------------------------------------------- wheels
    this.wheels = [];
    this.steerNodes = [];
    const tireGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 20);
    tireGeo.rotateZ(Math.PI / 2);
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 });
    const rimGeo = new THREE.CylinderGeometry(0.21, 0.21, 0.27, 14);
    rimGeo.rotateZ(Math.PI / 2);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ad, metalness: 0.95, roughness: 0.25, envMapIntensity: 1.4 });
    this.rimMat = rimMat;
    const positions = [
      { x: -0.84, z: 1.42, steer: true }, { x: 0.84, z: 1.42, steer: true },
      { x: -0.84, z: -1.42, steer: false }, { x: 0.84, z: -1.42, steer: false },
    ];
    for (const p of positions) {
      const node = new THREE.Group();
      node.position.set(p.x, 0.34, p.z);
      const tire = new THREE.Mesh(tireGeo, tireMat);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      tire.castShadow = true;
      node.add(tire, rim);
      for (let s = 0; s < 5; s++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, 0.34), rimMat);
        spoke.rotation.x = (s / 5) * Math.PI * 2;
        spoke.position.set(0, 0, 0);
        const pivot = new THREE.Group();
        pivot.rotation.x = (s / 5) * Math.PI * 2;
        pivot.add(spoke);
        spoke.position.set(0, 0.11, 0);
        spoke.rotation.x = 0;
        node.add(pivot);
      }
      this.group.add(node);
      this.wheels.push({ node, spin: tire, steer: p.steer });
      if (p.steer) this.steerNodes.push(node);
    }

    // -------------------------------------------------- lights (real)
    this.spotL = new THREE.SpotLight(0xcfe0ff, 420, 130, 0.58, 0.6, 1.35);
    this.spotR = this.spotL.clone();
    this.spotL.position.set(-0.62, 0.8, 2.2);
    this.spotR.position.set(0.62, 0.8, 2.2);
    this.spotTargetL = new THREE.Object3D();
    this.spotTargetR = new THREE.Object3D();
    this.spotTargetL.position.set(-2.2, -0.5, 26);
    this.spotTargetR.position.set(2.2, -0.5, 26);
    this.group.add(this.spotL, this.spotR, this.spotTargetL, this.spotTargetR);
    this.spotL.target = this.spotTargetL;
    this.spotR.target = this.spotTargetR;
    this.brakeLight = new THREE.PointLight(0xff2222, 0, 7, 2);
    this.brakeLight.position.set(0, 0.95, -2.6);
    this.group.add(this.brakeLight);

    // ground spill in front of the headlights (subtle!)
    const spill = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 16),
      new THREE.MeshBasicMaterial({
        map: canvasTexture(headlightPoolTexture()), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.3,
      })
    );
    spill.rotation.x = -Math.PI / 2;
    spill.position.set(0, 0.16, 9.0);
    this.group.add(spill);
    this.spill = spill;

    // -------------------------------------------------- state
    this.pos = new THREE.Vector3(57, 0, 57);
    this.heading = Math.PI;          // face -z? (0 => +z); start facing city center
    this.vf = 0;                     // forward m/s
    this.vl = 0;                     // lateral m/s
    this.steer = 0;                  // smoothed steering -1..1
    this.wheelSpin = 0;
    this.slip = 0;
    this.radius = 1.15;
    this.glassMat = glass;
    this.resetRequested = false;
    this.update(0, { throttle: 0, brake: 0, left: false, right: false, handbrake: false }, null);
  }

  /** night-city env map so the paint shows clean, colourful reflections */
  setEnvMaps(tex, intensity = 2.6) {
    this.paint.envMap = tex;
    this.paint.envMapIntensity = intensity;
    this.paint.needsUpdate = true;
    this.glassMat.envMap = tex;
    this.glassMat.envMapIntensity = 2.4;
    this.glassMat.needsUpdate = true;
    this.rimMat.envMap = tex;
    this.rimMat.needsUpdate = true;
  }

  reset() {
    this.vf = 0; this.vl = 0; this.slip = 0; this.steer = 0;
  }

  get speedKmh() { return Math.abs(this.vf) * 3.6; }

  /**
   * @param {number} dt
   * @param {{throttle:number,brake:number,left:boolean,right:boolean,handbrake:boolean}} input
   * @param {City|null} city
   */
  update(dt, input, city) {
    if (dt <= 0) dt = 0.0001;
    const steerTarget = input.steer !== undefined
      ? THREE.MathUtils.clamp(input.steer, -1, 1)
      : (input.left ? 1 : 0) - (input.right ? 1 : 0);
    this.steer += (steerTarget - this.steer) * Math.min(1, dt * 7);

    const speed = Math.abs(this.vf);
    // engine / drag
    const accel = 15.5;
    const brakeForce = 30;
    const drag = 0.011;
    const roll = 0.55;
    let a = input.throttle * accel * (this.vf < 0 ? 0.6 : 1);
    a -= input.brake * (this.vf > 0.5 ? brakeForce : -8); // brake or reverse
    a -= drag * this.vf * speed;
    a -= roll * Math.sign(this.vf) * Math.min(1, speed);
    if (input.handbrake) a -= 6 * Math.sign(this.vf) * Math.min(1, speed);
    this.vf = THREE.MathUtils.clamp(this.vf + a * dt, -11, 62);

    // steering: speed-sensitive
    const maxSteer = 0.62;
    const steerAngle = this.steer * maxSteer / (1 + Math.pow(speed / 16, 1.35));
    const wheelbase = 2.84;
    this.heading += (this.vf / wheelbase) * Math.tan(steerAngle) * dt;

    // lateral slip (drift)
    const grip = input.handbrake ? 2.1 : 7.5;
    this.vl -= this.vl * Math.min(1, grip * dt);
    this.vl += steerAngle * this.vf * Math.min(1, speed / 22) * 2.4 * dt * (input.handbrake ? 2.4 : 1);
    this.vl = THREE.MathUtils.clamp(this.vl, -16, 16);
    this.slip += ((this.vl * 0.045) - this.slip) * Math.min(1, dt * 6);

    // integrate
    const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
    const rx = Math.cos(this.heading), rz = -Math.sin(this.heading);
    let nx = this.pos.x + (fx * this.vf + rx * this.vl) * dt;
    let nz = this.pos.z + (fz * this.vf + rz * this.vl) * dt;

    if (city) {
      const res = city.collide(nx, nz, this.radius);
      if (res.hit) {
        // push-out direction = wall normal; kill only the velocity into it,
        // so the car keeps sliding along walls instead of gluing to them
        const px = res.x - nx, pz = res.z - nz;
        const pl = Math.hypot(px, pz);
        nx = res.x; nz = res.z;
        if (pl > 1e-6) {
          const nX = px / pl, nZ = pz / pl;
          let vx = fx * this.vf + rx * this.vl;
          let vz = fz * this.vf + rz * this.vl;
          const vn = vx * nX + vz * nZ;
          if (vn < 0) {
            vx -= nX * vn * 1.4;
            vz -= nZ * vn * 1.4;
            this.vf = vx * fx + vz * fz;
            this.vl = vx * rx + vz * rz;
          }
        }
      }
    }
    this.pos.x = nx; this.pos.z = nz;

    // visual transform
    this.group.position.set(this.pos.x, 0.02, this.pos.z);
    this.group.rotation.y = this.heading - this.slip;
    // body roll & pitch
    const rollAngle = -this.vl * 0.012 - this.steer * speed * 0.0006;
    const pitch = THREE.MathUtils.clamp((input.throttle - input.brake) * 0.012, -0.02, 0.02);
    this.group.rotation.z += (rollAngle - this.group.rotation.z) * Math.min(1, dt * 5);
    this.group.rotation.x += (pitch - this.group.rotation.x) * Math.min(1, dt * 5);

    // wheels
    this.wheelSpin += (this.vf / 0.34) * dt;
    for (const w of this.wheels) {
      w.spin.rotation.x = this.wheelSpin;
      w.node.children.forEach((c) => { if (c.isGroup) c.rotation.x = this.wheelSpin; });
    }
    for (const n of this.steerNodes) n.rotation.y = this.steer * 0.42 / (1 + Math.pow(speed / 30, 1.2));

    // lights state
    const braking = input.brake > 0.05 || input.handbrake;
    this.tailMat.color.setRGB(braking ? 5.0 : 3.0, braking ? 0.18 : 0.12, braking ? 0.2 : 0.15);
    this.brakeLight.intensity = braking ? 6 : 1.6;
    const reverse = this.vf < -0.4;
    void reverse;

    return this.pos;
  }
}
