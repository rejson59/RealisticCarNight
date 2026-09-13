import * as THREE from 'three';

export const CAM_NAMES = ['Kamera: pościgowa', 'Kamera: maska', 'Kamera: zderzak', 'Kamera: filmowa'];

/**
 * All camera modes + the photo-mode orbit.
 *   0 chase   — damped follow, FOV opens with speed
 *   1 hood    — driver's eye over the dashboard
 *   2 bumper  — low & wide, strongest sense of speed
 *   3 film    — slow drone-like orbit around the car
 * Photo mode: free orbit you drag around, wheel zooms, idle drifts slowly.
 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.mode = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.fovOffset = 0;
    this.shake = 0;          // extra camera shake (impacts)
    this.photo = {
      active: false, yaw: 0.7, pitch: 0.16, dist: 10.5,
      dragYaw: 0, dragPitch: 0, idle: 0,
    };
    this._film = 0;
  }

  setMode(i) {
    this.mode = ((i % CAM_NAMES.length) + CAM_NAMES.length) % CAM_NAMES.length;
    return this.mode;
  }

  cycle() { return this.setMode(this.mode + 1); }

  setPhoto(on) {
    this.photo.active = on;
    if (on) { this.photo.idle = 0; }
  }

  /** pointer drag / wheel from the UI layer */
  photoDrag(dx, dy) {
    this.photo.yaw -= dx * 0.005;
    this.photo.pitch = THREE.MathUtils.clamp(this.photo.pitch + dy * 0.004, -0.12, 0.75);
    this.photo.idle = 0;
  }

  photoZoom(delta) {
    this.photo.dist = THREE.MathUtils.clamp(this.photo.dist + delta * 0.012, 4.5, 26);
    this.photo.idle = 0;
  }

  update(dt, car) {
    const cam = this.camera;
    const kmh = car.speedKmh;
    const fx = Math.sin(car.heading), fz = Math.cos(car.heading);

    if (this.photo.active) {
      const p = this.photo;
      p.idle += dt;
      if (p.idle > 2.5) p.yaw += dt * 0.07;      // gentle cinematic drift
      const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
      this.pos.set(
        car.pos.x + Math.sin(p.yaw) * cp * p.dist,
        1.1 + sp * p.dist,
        car.pos.z + Math.cos(p.yaw) * cp * p.dist
      );
      this.look.set(car.pos.x, 1.05, car.pos.z);
      cam.position.copy(this.pos);
      cam.lookAt(this.look);
      const fov = 46 + this.fovOffset;
      if (Math.abs(cam.fov - fov) > 0.1) {
        cam.fov += (fov - cam.fov) * Math.min(1, dt * 4);
        cam.updateProjectionMatrix();
      }
      return;
    }

    if (this.mode === 0) {
      const dist = 6.3 + kmh * 0.040;
      const height = 2.05 + kmh * 0.008;
      const desired = new THREE.Vector3(car.pos.x - fx * dist, height, car.pos.z - fz * dist);
      const look = new THREE.Vector3(
        car.pos.x + fx * (6.5 + kmh * 0.06), 1.0, car.pos.z + fz * (6.5 + kmh * 0.06)
      );
      this.pos.lerp(desired, 1 - Math.exp(-dt * 4.6));
      this.look.lerp(look, 1 - Math.exp(-dt * 7.5));
      this._setFov(dt, 62 + Math.min(24, kmh * 0.11));
    } else if (this.mode === 1) {
      this.pos.set(car.pos.x + fx * 0.35, 1.18, car.pos.z + fz * 0.35);
      this.look.set(car.pos.x + fx * 40, 1.0, car.pos.z + fz * 40);
      this._setFov(dt, 70 + Math.min(18, kmh * 0.08));
    } else if (this.mode === 2) {
      const dist = 3.1 + kmh * 0.012;
      const desired = new THREE.Vector3(car.pos.x - fx * dist, 0.62, car.pos.z - fz * dist);
      const look = new THREE.Vector3(car.pos.x + fx * 14, 0.85, car.pos.z + fz * 14);
      this.pos.lerp(desired, 1 - Math.exp(-dt * 9));
      this.look.lerp(look, 1 - Math.exp(-dt * 9));
      this._setFov(dt, 80 + Math.min(16, kmh * 0.10));
    } else {
      this._film += dt * 0.26;
      const a = this._film;
      const r = 10.5 + Math.sin(a * 0.7) * 2.2;
      const desired = new THREE.Vector3(
        car.pos.x + Math.sin(a) * r, 4.4 + Math.sin(a * 0.53) * 1.4, car.pos.z + Math.cos(a) * r
      );
      this.pos.lerp(desired, 1 - Math.exp(-dt * 2.4));
      this.look.lerp(new THREE.Vector3(car.pos.x, 1.1, car.pos.z), 1 - Math.exp(-dt * 4));
      this._setFov(dt, 50 + Math.min(8, kmh * 0.03));
    }

    const shake = Math.pow(Math.min(1, kmh / 230), 2) * 0.045 + this.shake;
    this.shake = Math.max(0, this.shake - dt * 1.8);
    cam.position.set(
      this.pos.x + (Math.random() - 0.5) * shake,
      this.pos.y + (Math.random() - 0.5) * shake,
      this.pos.z + (Math.random() - 0.5) * shake
    );
    cam.lookAt(this.look);
  }

  _setFov(dt, fov) {
    const target = fov + this.fovOffset;
    const cam = this.camera;
    if (Math.abs(cam.fov - target) > 0.1) {
      cam.fov += (target - cam.fov) * Math.min(1, dt * 3);
      cam.updateProjectionMatrix();
    }
  }
}
