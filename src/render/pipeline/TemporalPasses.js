import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Fullscreen draw without auto-clear — `FullScreenQuad.render()` runs
 * `renderer.render()`, which would clear the depth attachment of the target the
 * composer ping-pongs into, and later passes still need that depth.
 */
function drawQuad(renderer, fsq) {
  const ac = renderer.autoClear;
  renderer.autoClear = false;
  fsq.render(renderer);
  renderer.autoClear = ac;
}

export const DYNAMIC_LAYER = 1;

/* ============================================================ VELOCITY PASS
 * Per-pixel motion vectors for dynamic objects (player car, AI cars).
 * Static geometry gets its motion for free from depth reprojection in the
 * resolve pass; only movers are rendered here (one extra subset draw with a
 * 2-float shader, on a dedicated layer).
 * Output RG16F = currentUv - previousUv.
 */
export class VelocityPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.meshes = [];
    this.registered = new Set();
    /** set by the orchestrator: current-frame projection WITHOUT jitter, so
     *  motion vectors describe real movement, not the TAA sample offset. */
    this.unjitteredProj = new THREE.Matrix4();
    this.prevViewProj = new THREE.Matrix4();
    this.velRT = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPrevModel: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
      },
      vertexShader: /* glsl */`
        uniform mat4 uPrevModel;
        uniform mat4 uPrevViewProj;
        varying vec2 vVel;
        void main() {
          vec4 cur = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec4 prev = uPrevViewProj * (uPrevModel * vec4(position, 1.0));
          vec2 a = cur.xy / max(cur.w, 1e-5) * 0.5 + 0.5;
          vec2 b = prev.xy / max(prev.w, 1e-5) * 0.5 + 0.5;
          vVel = a - b;
          gl_Position = cur;
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vVel;
        void main() { gl_FragColor = vec4(vVel, 0.0, 1.0); }`,
    });
  }

  /**
   * Remember previous-frame world matrices of a subtree so it can be drawn into
   * the velocity buffer. Instanced / skinned / transparent objects are skipped:
   * their per-instance or bind-pose matrices cannot be expressed by a single
   * model matrix, and transparent volumes would overwrite the motion of the
   * geometry behind them. Those pixels fall back to depth reprojection.
   */
  register(root) {
    root.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh) return;
      if (o.userData.velocity === false) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.transparent) return;
      if (this.registered.has(o)) return;
      this.registered.add(o);
      o.layers.enable(DYNAMIC_LAYER);
      if (!o.userData.prevMW) o.userData.prevMW = new THREE.Matrix4();
      o.userData.prevMW.copy(o.matrixWorld);
      o.onBeforeRender = (renderer, scene, camera, geometry, material) => {
        if (material === this.material) {
          this.material.uniforms.uPrevModel.value.copy(o.userData.prevMW);
        }
      };
      this.meshes.push(o);
    });
  }

  /** call once per frame AFTER all animation, before the next frame renders */
  snapshot() {
    for (const m of this.meshes) m.userData.prevMW.copy(m.matrixWorld);
  }

  setSize(w, h) { this.velRT.setSize(w, h); }

  render(renderer) {
    this.material.uniforms.uPrevViewProj.value.copy(this.prevViewProj);
    const prevOverride = this.scene.overrideMaterial;
    const prevMask = this.camera.layers.mask;
    const prevProj = this.camera.projectionMatrix.clone();
    this.scene.overrideMaterial = this.material;
    this.camera.layers.set(DYNAMIC_LAYER);
    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    this.camera.projectionMatrix.copy(this.unjitteredProj);
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.velRT);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);   // colour only: no depth attachment
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;
    this.camera.projectionMatrix.copy(prevProj);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    this.camera.layers.mask = prevMask;
    this.scene.overrideMaterial = prevOverride;
  }

  dispose() {
    this.velRT.dispose();
    this.material.dispose();
    for (const o of this.registered) {
      o.layers.disable(DYNAMIC_LAYER);
      o.onBeforeRender = () => {};
    }
    this.registered.clear();
    this.meshes.length = 0;
  }
}

/* ====================================================== TEMPORAL RESOLVE
 * Depth-reprojection TAA/TAAU resolve:
 *   1. rebuild world position from the depth buffer,
 *   2. reproject with the previous frame's view-proj (=> per-pixel motion
 *      vector for static geometry; dynamic pixels use the velocity buffer),
 *   3. variance-clip the history against a 3x3 neighbourhood of the current
 *      frame (kills ghosting on disocclusions),
 *   4. blend with a motion-aware weight.
 * The resolved frame becomes next frame's history (ping-pong), then is blitted
 * into the composer chain. Rendering happens at `renderScale` resolution, so
 * this pass IS the temporal upscaler.
 */
const ResolveShader = {
  uniforms: {
    tCurrent: { value: null },
    tDepth: { value: null },
    tHistory: { value: null },
    tVelocity: { value: null },
    uUseVelocity: { value: 0 },
    uInvViewProj: { value: new THREE.Matrix4() },
    uPrevViewProj: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uHistoryWeight: { value: 0.93 },
    uReset: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tCurrent;
    uniform sampler2D tDepth;
    uniform sampler2D tHistory;
    uniform sampler2D tVelocity;
    uniform float uUseVelocity;
    uniform mat4 uInvViewProj;
    uniform mat4 uPrevViewProj;
    uniform vec2 uTexel;
    uniform float uHistoryWeight;
    uniform float uReset;
    varying vec2 vUv;

    vec3 sampleCur(vec2 uv) { return texture2D(tCurrent, uv).rgb; }

    void main() {
      vec2 uv = vUv;
      vec3 cur = sampleCur(uv);
      float depth = texture2D(tDepth, uv).r;

      // --- motion vector: reproject static world through the previous view-proj
      vec2 prevUv = uv;
      if (depth < 0.99999) {
        vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
        vec4 wp = uInvViewProj * ndc;
        wp /= max(wp.w, 1e-6);
        vec4 pc = uPrevViewProj * wp;
        prevUv = pc.xy / max(pc.w, 1e-6) * 0.5 + 0.5;
      }
      vec2 vel = vec2(0.0);
      if (uUseVelocity > 0.5) {
        vel = texture2D(tVelocity, uv).rg;
        if (dot(vel, vel) > 1e-10) prevUv = uv - vel;   // mover: trust its own vector
      }
      vec2 motion = uv - prevUv;

      bool valid = prevUv.x > 0.001 && prevUv.x < 0.999 && prevUv.y > 0.001 && prevUv.y < 0.999;

      // --- variance clipping: 3x3 neighbourhood statistics of the current frame
      vec3 m0 = sampleCur(uv + vec2(-1.0, -1.0) * uTexel);
      vec3 m1 = sampleCur(uv + vec2( 0.0, -1.0) * uTexel);
      vec3 m2 = sampleCur(uv + vec2( 1.0, -1.0) * uTexel);
      vec3 m3 = sampleCur(uv + vec2(-1.0,  0.0) * uTexel);
      vec3 m4 = cur;
      vec3 m5 = sampleCur(uv + vec2( 1.0,  0.0) * uTexel);
      vec3 m6 = sampleCur(uv + vec2(-1.0,  1.0) * uTexel);
      vec3 m7 = sampleCur(uv + vec2( 0.0,  1.0) * uTexel);
      vec3 m8 = sampleCur(uv + vec2( 1.0,  1.0) * uTexel);
      vec3 mn = min(m4, min(min(m0, m1), min(m2, min(m3, min(m5, min(m6, min(m7, m8)))))));
      vec3 mx = max(m4, max(max(m0, m1), max(m2, max(m3, max(m5, max(m6, max(m7, m8)))))));
      vec3 mean = (m0 + m1 + m2 + m3 + m4 + m5 + m6 + m7 + m8) / 9.0;
      vec3 var0 = (m0-mean)*(m0-mean) + (m1-mean)*(m1-mean) + (m2-mean)*(m2-mean)
                + (m3-mean)*(m3-mean) + (m4-mean)*(m4-mean) + (m5-mean)*(m5-mean)
                + (m6-mean)*(m6-mean) + (m7-mean)*(m7-mean) + (m8-mean)*(m8-mean);
      vec3 sigma = sqrt(var0 / 9.0);
      vec3 boxMin = max(mn, mean - 1.15 * sigma);
      vec3 boxMax = min(mx, mean + 1.15 * sigma);

      // --- history weight (motion-aware): fast pixels keep less of the past
      float motionPx = length(motion / uTexel);
      float w = uHistoryWeight / (1.0 + motionPx * 0.45);
      if (!valid || uReset > 0.5) w = 0.0;

      // First frame after a reset must not touch the history buffer at all:
      // uninitialised GPU memory can hold NaN, and mix(cur, NaN, 0.0) is NaN,
      // which would then be written back and poison every following frame.
      if (w <= 0.0) { gl_FragColor = vec4(cur, 1.0); return; }

      vec3 hist = texture2D(tHistory, prevUv).rgb;
      // NaN/Inf guard: lessThan/greaterThanEqual are false for NaN, so anything
      // non-finite (or absurdly bright) is replaced by the current sample
      bool sane = all(lessThan(hist, vec3(1.0e4))) && all(greaterThanEqual(hist, vec3(0.0)));
      hist = sane ? clamp(hist, boxMin, boxMax) : cur;

      gl_FragColor = vec4(mix(cur, hist, w), 1.0);
    }`,
};

const CopyShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(tDiffuse, vUv); }`,
};

export class TemporalResolvePass extends Pass {
  constructor() {
    super();
    this.needsSwap = true;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    this.history = [new THREE.WebGLRenderTarget(2, 2, opts), new THREE.WebGLRenderTarget(2, 2, opts)];
    this.hIndex = 0;
    this.material = new THREE.ShaderMaterial(ResolveShader);
    this.copyMaterial = new THREE.ShaderMaterial(CopyShader);
    this.fsq = new FullScreenQuad(this.material);
    this.fsqCopy = new FullScreenQuad(this.copyMaterial);
    this.reset();
  }

  reset() {
    this.hIndex = 0;
    this.material.uniforms.uReset.value = 1;
  }

  setSize(w, h) {
    this.history[0].setSize(w, h);
    this.history[1].setSize(w, h);
    this.material.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.reset();
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    const writeTarget = this.history[1 - this.hIndex];
    const readTarget = this.history[this.hIndex];
    u.tCurrent.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.tHistory.value = readTarget.texture;

    renderer.setRenderTarget(writeTarget);
    drawQuad(renderer, this.fsq);

    this.copyMaterial.uniforms.tDiffuse.value = writeTarget.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    drawQuad(renderer, this.fsqCopy);

    this.hIndex = 1 - this.hIndex;
    u.uReset.value = 0;
  }

  dispose() {
    this.history[0].dispose();
    this.history[1].dispose();
    this.material.dispose();
    this.copyMaterial.dispose();
    this.fsq.dispose();
    this.fsqCopy.dispose();
  }
}
