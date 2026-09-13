import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VelocityPass, TemporalResolvePass } from './pipeline/TemporalPasses.js';
import { AmbientOcclusionPass, DOFPass, PresentPass } from './pipeline/ImagePasses.js';
import { applyJitter, clearJitter } from './pipeline/jitter.js';
import { buildLUT, LUT_SIZE } from './pipeline/lut.js';

/**
 * Per-tier rendering pipeline profiles — the "DLSS-like" budget table.
 *
 * `renderScale` < 1 means the scene is rasterised at a fraction of the display
 * resolution and reconstructed temporally (sub-pixel jitter + history +
 * variance clip) before a CAS present pass — the classical TAAU route to
 * DLSS-style upscaling, and what buys the FPS headroom for AO/DOF/glare.
 *
 * `msaa` is the fallback path: when the player switches temporal upscaling off
 * the pipeline returns to native resolution *plus* hardware multisampling, so
 * the image is never soft and aliased at the same time.
 *
 * Everything below is per-frame cost budgeting for a WebGL2 mobile/desktop mix:
 *   0 NISKA   plain raster              – weak phones
 *   1 ŚREDNIA plain raster + grade      – integrated GPUs
 *   2 WYSOKA  0.85× + TAA + AO          – the sweet spot
 *   3 ULTRA   0.70× + TAA + MV + AO + DOF – desktop / good phones
 */
export const PIPE_PROFILES = [
  {
    renderScale: 1.0, taa: false, velocity: false, ao: false, dof: false, msaa: 0,
    bloom: 0.5, bloomScale: 0.25, lut: 'natural', sharpen: 0.35, grain: 0.02,
  },
  {
    renderScale: 1.0, taa: false, velocity: false, ao: false, dof: false, msaa: 0,
    bloom: 0.62, bloomScale: 0.35, lut: 'natural', sharpen: 0.45, grain: 0.022,
  },
  {
    renderScale: 0.85, taa: true, velocity: false, ao: true, dof: false, msaa: 4,
    bloom: 0.75, bloomScale: 0.5, lut: 'natural', sharpen: 0.62, grain: 0.026,
  },
  {
    renderScale: 0.7, taa: true, velocity: true, ao: true, dof: true, msaa: 4,
    bloom: 0.85, bloomScale: 0.6, lut: 'natural', sharpen: 0.72, grain: 0.028,
  },
];

/**
 * Modular render pipeline — one object owns the whole post chain.
 *
 *   scene ─► RenderPass (jittered camera, internal res, HDR colour + depth)
 *        ├─ VelocityPass       motion vectors of registered dynamic meshes
 *        ├─ TemporalResolve    history + reprojection + variance clip   ← TAAU
 *        ├─ AmbientOcclusion   depth-only GTAO-ish, half res, bilateral
 *        ├─ DOFPass            CoC gather (subtle bokeh)
 *        ├─ UnrealBloom        physically-minded glare on HDR values
 *        ├─ OutputPass         ACESFilmic tonemap + sRGB encode
 *        └─ PresentPass        CAS + 3D LUT + CA + speed blur + vignette + grain
 *                             ► screen at display resolution
 *
 * How a frame is driven from the game loop:
 *   pipe.beginFrame();   // jitter + reprojection matrices
 *   pipe.render();       // composer.render()
 *   pipe.endFrame();     // clear jitter, snapshot motion, advance history
 */
export class Pipeline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.frame = 0;
    this.tier = 2;
    this.profile = PIPE_PROFILES[2];
    this.css = { w: 1280, h: 720 };
    this.dpr = 1;
    this.scale = 1;
    this.internal = { w: 1280, h: 720 };
    this.stats = { taa: false, ao: false, dof: false, velocity: false, scale: 1, msaa: 0, lut: 'natural', internal: [1280, 720] };

    this._luts = {};
    this._prevViewProj = new THREE.Matrix4();   // previous frame, unjittered
    this._curViewProj = new THREE.Matrix4();    // current frame, unjittered
    this._invViewProj = new THREE.Matrix4();    // current frame, jittered
    this._projUnjit = new THREE.Matrix4();
    this._usesVelocity = false;
    this._hasPrev = false;
    this.photo = false;
    this.composer = null;
  }

  /* ------------------------------------------------------------ configure */
  /**
   * Rebuild the chain for a quality tier + user overrides. Cheap enough to call
   * from the settings menu or from the auto-quality governor; all passes are
   * created once and reused, only the render targets are reallocated.
   *
   * @param {number} tier 0..3 index into PIPE_PROFILES
   * @param {object} [user] overrides
   * @param {boolean} [user.taa]    temporal upscaling / TAA
   * @param {boolean} [user.ao]     ambient occlusion
   * @param {boolean} [user.dof]    depth of field
   * @param {string}  [user.lut]    'natural' | 'film' | 'vivid' | 'none'
   * @param {number}  [user.sharpen] CAS strength 0..1
   * @param {boolean} [user.photo]  force full internal resolution (screenshots)
   */
  configure(tier, user = {}) {
    this.tier = tier;
    const base = PIPE_PROFILES[tier] || PIPE_PROFILES[2];
    const p = { ...base };
    if (user.taa !== undefined) p.taa = !!user.taa;
    if (user.ao !== undefined) p.ao = !!user.ao;
    if (user.dof !== undefined) p.dof = !!user.dof;
    if (user.lut) p.lut = user.lut;
    if (user.sharpen !== undefined) p.sharpen = user.sharpen;

    if (!p.taa) {
      p.renderScale = 1;    // native path
      p.velocity = false;
    } else {
      p.msaa = 0;           // jittered samples already cover the edges
    }
    if (user.photo) p.renderScale = 1;

    this.profile = p;
    this.scale = p.renderScale;
    this.internal = {
      w: Math.max(2, Math.round(this.css.w * this.dpr * this.scale)),
      h: Math.max(2, Math.round(this.css.h * this.dpr * this.scale)),
    };
    this._rebuild();
  }

  _lut(name) {
    if (name === 'none') return null;
    if (!this._luts[name]) this._luts[name] = buildLUT(name);
    return this._luts[name];
  }

  _ensurePasses() {
    if (!this.renderPass) this.renderPass = new RenderPass(this.scene, this.camera);
    if (!this.velocityPass) this.velocityPass = new VelocityPass(this.scene, this.camera);
    if (!this.resolvePass) this.resolvePass = new TemporalResolvePass();
    if (!this.aoPass) this.aoPass = new AmbientOcclusionPass();
    if (!this.dofPass) this.dofPass = new DOFPass();
    if (!this.bloomPass) {
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.75, 0.38, 0.8);
    }
    if (!this.outputPass) this.outputPass = new OutputPass();
    if (!this.presentPass) this.presentPass = new PresentPass();
  }

  _rebuild() {
    const p = this.profile;
    const { w, h } = this.internal;
    this._ensurePasses();

    // free the previous chain (render targets + their depth textures)
    if (this.composer) {
      this.composer.dispose();
      this.composer = null;
    }

    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: p.taa ? 0 : p.msaa,
      depthBuffer: true,
      stencilBuffer: false,
    });
    rt.depthTexture = new THREE.DepthTexture(w, h);
    this.depthTexture = rt.depthTexture;

    const composer = new EffectComposer(this.renderer, rt);
    composer.setPixelRatio(1);   // we manage resolution ourselves
    composer.setSize(w, h);

    composer.addPass(this.renderPass);

    this._usesVelocity = !!p.velocity;
    if (this._usesVelocity) {
      this.velocityPass.setSize(w, h);
      composer.addPass(this.velocityPass);
    }
    if (p.taa) {
      this.resolvePass.setSize(w, h);
      composer.addPass(this.resolvePass);
    }
    if (p.ao) {
      this.aoPass.setSize(w, h);
      this.aoPass.setCamera(this.camera);
      this.aoPass.setDepthTexture(rt.depthTexture);
      composer.addPass(this.aoPass);
    }
    if (p.dof) {
      this.dofPass.setSize(w, h);
      this.dofPass.setCamera(this.camera);
      this.dofPass.setDepthTexture(rt.depthTexture);
      composer.addPass(this.dofPass);
    }

    this.bloomPass.strength = p.bloom * (this.photo ? 1.25 : 1);
    this.bloomPass.resolution.set(Math.max(2, w * p.bloomScale), Math.max(2, h * p.bloomScale));
    composer.addPass(this.bloomPass);
    composer.addPass(this.outputPass);

    const pu = this.presentPass.material.uniforms;
    pu.uLut.value = this._lut(p.lut);
    pu.uLutSize.value = LUT_SIZE;
    pu.uLutMix.value = p.lut === 'none' ? 0 : 1;
    pu.uSharpen.value = p.sharpen;
    pu.uGrain.value = p.grain;
    this.presentPass.setInternalSize(w, h);
    this.presentPass.setSize(Math.round(this.css.w * this.dpr), Math.round(this.css.h * this.dpr));
    composer.addPass(this.presentPass);

    this.composer = composer;
    this.stats = {
      taa: !!p.taa, ao: !!p.ao, dof: !!p.dof, velocity: this._usesVelocity,
      msaa: p.taa ? 0 : p.msaa, scale: this.scale, lut: p.lut, internal: [w, h],
    };
    this.resetHistory();
  }

  /* --------------------------------------------------------------- sizing */
  /** @param {number} cssW css pixels @param {number} cssH @param {number} dpr device pixel ratio */
  setSize(cssW, cssH, dpr) {
    this.css = { w: cssW, h: cssH };
    this.dpr = dpr;
    const dw = Math.max(2, Math.round(cssW * dpr));
    const dh = Math.max(2, Math.round(cssH * dpr));
    const iw = Math.max(2, Math.round(dw * this.scale));
    const ih = Math.max(2, Math.round(dh * this.scale));
    this.presentPass?.setSize(dw, dh);
    if (!this.composer) { this.internal = { w: iw, h: ih }; return; }
    if (iw === this.internal.w && ih === this.internal.h) return;
    this.internal = { w: iw, h: ih };

    this.composer.setSize(iw, ih);
    this.velocityPass.setSize(iw, ih);
    this.resolvePass.setSize(iw, ih);
    this.aoPass.setSize(iw, ih);
    this.dofPass.setSize(iw, ih);
    this.presentPass.setInternalSize(iw, ih);
    this.bloomPass.resolution.set(
      Math.max(2, iw * this.profile.bloomScale),
      Math.max(2, ih * this.profile.bloomScale)
    );
    this.stats.internal = [iw, ih];
    this.resetHistory();
  }

  /* -------------------------------------------------------------- framing */
  /**
   * Register a subtree whose motion should be written to the velocity buffer.
   * Idempotent: already-known meshes are skipped, so it is safe to call after
   * every traffic respawn.
   */
  registerDynamic(root) {
    this._ensurePasses();
    this.velocityPass.register(root);
  }

  /** drop the temporal history (resize, tier change, screenshot, teleport) */
  resetHistory() {
    this.resolvePass?.reset();
    this._hasPrev = false;
  }

  setFocus(dist) { this.dofPass?.setFocus(dist); }

  setSpeedBlur(b) {
    if (this.presentPass) this.presentPass.material.uniforms.uBlur.value = b;
  }

  setTime(t) {
    if (this.presentPass) this.presentPass.material.uniforms.uTime.value = t;
  }

  /**
   * Photo mode: no temporal blur, deeper vignette, a touch more grain and a
   * stronger glare so screenshots look like long-exposure night photography.
   */
  setPhoto(on) {
    this.photo = !!on;
    if (this.presentPass) this.presentPass.material.uniforms.uPhoto.value = on ? 1 : 0;
    if (this.bloomPass) this.bloomPass.strength = this.profile.bloom * (on ? 1.25 : 1);
  }

  /** once per frame BEFORE drawing: jitter, matrices, uniforms */
  beginFrame() {
    if (!this.composer) return;   // not configured yet — render() falls back
    // a composer runs renderer.render() many times per frame and each call
    // resets the counters — accumulate them manually so the perf overlay shows
    // the real cost of the whole chain (scene + velocity + AO + bloom mips)
    if (this.renderer.info) {
      this.renderer.info.autoReset = false;
      this.renderer.info.reset();
    }
    const cam = this.camera;
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    clearJitter(cam);

    // unjittered view-projection → motion vectors + history reprojection
    this._projUnjit.copy(cam.projectionMatrix);
    this._curViewProj.multiplyMatrices(this._projUnjit, cam.matrixWorldInverse);

    if (this.profile.taa) {
      applyJitter(cam, this.frame, this.internal.w, this.internal.h);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }
    // reconstruction uses the *jittered* inverse so it matches the depth buffer
    this._invViewProj.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);

    if (this.resolvePass) {
      const u = this.resolvePass.material.uniforms;
      u.uInvViewProj.value.copy(this._invViewProj);
      u.uPrevViewProj.value.copy(this._prevViewProj);
      u.tVelocity.value = this._usesVelocity ? this.velocityPass.velRT.texture : null;
      u.uUseVelocity.value = this._usesVelocity ? 1 : 0;
    }
    this.velocityPass.unjitteredProj.copy(this._projUnjit);
    if (this._hasPrev) this.velocityPass.prevViewProj.copy(this._prevViewProj);
    this.aoPass.setCamera(cam);
  }

  render() {
    if (!this.composer) { this.renderer.render(this.scene, this.camera); return; }
    this.composer.render();
  }

  /** once per frame AFTER drawing: history + previous-frame motion state */
  endFrame() {
    if (!this.composer) return;
    this._prevViewProj.copy(this._curViewProj);
    this._hasPrev = true;
    if (this._usesVelocity) this.velocityPass.snapshot();
    clearJitter(this.camera);   // never leak the jitter into game logic
    this.frame += 1;
  }

  dispose() {
    this.composer?.dispose();
    this.velocityPass?.dispose();
    this.resolvePass?.dispose();
    this.aoPass?.dispose();
    this.dofPass?.dispose();
    this.bloomPass?.dispose();
    this.outputPass?.dispose();
    this.presentPass?.dispose();
    for (const l of Object.values(this._luts)) l.dispose();
    this._luts = {};
  }
}

/**
 * Standalone factory — the "one function that configures a Three.js canvas"
 * entry point used by the docs and easy to lift into another project.
 *
 * @example
 *   const pipe = createPipeline(renderer, scene, camera, { tier: 3, lut: 'film' });
 *   pipe.registerDynamic(carGroup);
 *   function loop() {
 *     pipe.beginFrame();
 *     pipe.setFocus(camera.position.distanceTo(target));
 *     pipe.render();
 *     pipe.endFrame();
 *     requestAnimationFrame(loop);
 *   }
 */
export function createPipeline(renderer, scene, camera, { tier = 3, cssWidth, cssHeight, pixelRatio, ...user } = {}) {
  const p = new Pipeline(renderer, scene, camera);
  const w = cssWidth ?? (typeof innerWidth === 'number' ? innerWidth : 1280);
  const h = cssHeight ?? (typeof innerHeight === 'number' ? innerHeight : 720);
  const dpr = pixelRatio ?? Math.min(2, renderer.getPixelRatio?.() ?? 1);
  p.setSize(w, h, dpr);
  p.configure(tier, user);
  return p;
}
