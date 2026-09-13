import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Vignette + chromatic aberration + radial speed blur + film grain. */
export const VignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uIntensity: { value: 1.0 },
    uBlur: { value: 0.0 },
    uPhoto: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uBlur;
    uniform float uPhoto;
    varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      vec2 d = uv - 0.5;
      float ca = 0.0016 * uIntensity;
      vec3 col;
      if (uBlur > 0.001) {
        // radial speed blur (cheap motion blur at high speed), CA on the centre tap
        vec2 dir = d * uBlur * 0.055;
        vec3 acc = vec3(0.0);
        acc.r = texture2D(tDiffuse, uv + d * ca).r;
        acc.g = texture2D(tDiffuse, uv).g;
        acc.b = texture2D(tDiffuse, uv - d * ca).b;
        acc += texture2D(tDiffuse, uv - dir).rgb;
        acc += texture2D(tDiffuse, uv - dir * 2.0).rgb;
        acc += texture2D(tDiffuse, uv - dir * 3.0).rgb;
        col = acc * 0.25;
      } else {
        col.r = texture2D(tDiffuse, uv + d * ca).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - d * ca).b;
      }
      // vignette (deeper in photo mode)
      float v = smoothstep(mix(0.92, 0.86, uPhoto), mix(0.30, 0.22, uPhoto), length(d) * 1.35);
      col *= mix(mix(0.62, 0.5, uPhoto), 1.0, v);
      // teal-shadow / warm-highlight grade, pushed a touch further in photo mode
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 shadows = mix(vec3(0.80, 1.02, 1.06), vec3(0.76, 1.03, 1.10), uPhoto);
      vec3 highs   = mix(vec3(1.07, 0.99, 0.91), vec3(1.10, 1.00, 0.88), uPhoto);
      col *= mix(shadows, highs, smoothstep(0.02, 0.45, luma));
      // fine film grain
      float n = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 137.0);
      col += (n - 0.5) * 0.028 * uIntensity * (1.0 + uPhoto * 0.6);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/**
 * EffectComposer wrapper: bloom + grade + output, rebuilt per quality tier.
 * Photo mode adds bloom, grain and a deeper vignette for screenshots.
 */
export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.photo = false;
    this.vigPass = null;
    this.bloom = null;
    this.bloomBase = 0.7;
  }

  build(settings, dpr) {
    if (this.composer) this.composer.dispose?.();
    const w = Math.floor(innerWidth * dpr);
    const h = Math.floor(innerHeight * dpr);
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      samples: settings.msaa,
      depthBuffer: true,
    });
    const composer = new EffectComposer(this.renderer, rt);
    composer.setPixelRatio(dpr);
    composer.setSize(innerWidth, innerHeight);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomBase = settings.bloom;
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(Math.max(2, w * settings.bloomScale), Math.max(2, h * settings.bloomScale)),
      settings.bloom * (this.photo ? 1.25 : 1), 0.38, 0.8
    );
    composer.addPass(bloom);
    this.bloom = bloom;
    if (settings.vignette) {
      const vig = new ShaderPass(VignetteShader);
      vig.uniforms.uIntensity.value = this.tier >= 2 ? 1.0 : 0.6;
      composer.addPass(vig);
      this.vigPass = vig;
    } else {
      this.vigPass = null;
    }
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  setTier(tier) { this.tier = tier; }

  setPhoto(on) {
    this.photo = on;
    if (this.bloom) this.bloom.strength = this.bloomBase * (on ? 1.25 : 1);
    if (this.vigPass) this.vigPass.uniforms.uPhoto.value = on ? 1 : 0;
  }

  update(time, blur, dt = 0.016) {
    if (!this.vigPass) return;
    this.vigPass.uniforms.uTime.value = time;
    const u = this.vigPass.uniforms.uBlur;
    u.value += (blur - u.value) * Math.min(1, dt * 3);
  }

  setSize(w, h, dpr) {
    this.composer?.setSize(w, h);
    this.composer?.setPixelRatio(dpr);
  }

  render() { this.composer.render(); }
}
