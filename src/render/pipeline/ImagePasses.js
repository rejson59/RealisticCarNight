import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Fullscreen passes must not auto-clear: `FullScreenQuad.render()` goes through
 * `renderer.render()`, which clears colour *and depth* of the bound target.
 * The composer ping-pongs between two targets, so a clear here would wipe the
 * depth texture the AO/DOF passes still sample. The quad covers every pixel,
 * so clearing is pure bandwidth waste anyway.
 */
function drawQuad(renderer, fsq) {
  const ac = renderer.autoClear;
  renderer.autoClear = false;
  fsq.render(renderer);
  renderer.autoClear = ac;
}

const QUAD_VS = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** shared helper: raw depth -> |view-space Z| in metres */
const LINZ_GLSL = /* glsl */`
  uniform vec2 uNearFar;
  float linZ(vec2 uv, sampler2D tDepth) {
    float d = texture2D(tDepth, uv).r;
    float near = uNearFar.x, far = uNearFar.y;
    return abs((near * far) / ((far - near) * d - far));
  }`;

/* =============================================================== AMBIENT OCCLUSION
 * Depth-only GTAO-flavoured AO: normals reconstructed from depth derivatives,
 * 12 rotated spiral taps at HALF internal resolution, then a depth-aware
 * bilateral upsample fused into the composite. Zero extra scene draws.
 */
const AO_SHADER = {
  uniforms: {
    tDepth: { value: null },
    uInvProj: { value: new THREE.Matrix4() },
    uTexel: { value: new THREE.Vector2() },
    uRadiusPx: { value: 26.0 },
    uRadius: { value: 1.5 },
    uBias: { value: 0.08 },
    uStrength: { value: 1.7 },
  },
  vertexShader: QUAD_VS,
  fragmentShader: /* glsl */`
    uniform sampler2D tDepth;
    uniform mat4 uInvProj;
    uniform vec2 uTexel;
    uniform float uRadiusPx;
    uniform float uRadius;
    uniform float uBias;
    uniform float uStrength;
    varying vec2 vUv;

    vec3 viewPos(vec2 uv) {
      float d = texture2D(tDepth, uv).r * 2.0 - 1.0;
      vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d, 1.0);
      return v.xyz / max(v.w, 1e-6);
    }

    void main() {
      float rawD = texture2D(tDepth, vUv).r;
      vec3 P = viewPos(vUv);
      // sky / beyond the AO horizon: no occlusion, no derivatives
      if (rawD > 0.99999 || P.z < -220.0) { gl_FragColor = vec4(1.0); return; }
      vec3 dx = viewPos(vUv + vec2(uTexel.x, 0.0)) - viewPos(vUv - vec2(uTexel.x, 0.0));
      vec3 dy = viewPos(vUv + vec2(0.0, uTexel.y)) - viewPos(vUv - vec2(0.0, uTexel.y));
      vec3 N = normalize(cross(dx, dy));
      if (dot(N, -P) < 0.0) N = -N;

      float rot = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.28318;
      float scale = clamp(28.0 / max(-P.z, 1.0), 0.25, 1.8);
      float occ = 0.0;
      for (int i = 0; i < 12; i++) {
        float fi = float(i);
        float ang = rot + fi * 2.39996323;
        float rr = sqrt((fi + 0.5) / 12.0);
        vec2 dir = vec2(cos(ang), sin(ang)) * rr;
        vec3 Q = viewPos(vUv + dir * uTexel * uRadiusPx * scale);
        vec3 v = Q - P;
        float d = length(v);
        if (d > 1e-4 && d < uRadius) {
          occ += max(0.0, dot(N, v / d) - uBias) * (1.0 - d / uRadius);
        }
      }
      float ao = 1.0 - clamp(occ / 12.0 * uStrength, 0.0, 1.0);
      ao = mix(1.0, ao, 0.92);
      gl_FragColor = vec4(vec3(ao), 1.0);
    }`,
};

const AO_COMPOSITE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    tAO: { value: null },
    tDepth: { value: null },
    uTexelAO: { value: new THREE.Vector2() },
    uIntensity: { value: 0.8 },
    uNearFar: { value: new THREE.Vector2(0.3, 3200) },
  },
  vertexShader: QUAD_VS,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tAO;
    uniform sampler2D tDepth;
    uniform vec2 uTexelAO;
    uniform float uIntensity;
    varying vec2 vUv;
    ${LINZ_GLSL}
    void main() {
      vec4 col = texture2D(tDiffuse, vUv);
      float zc = linZ(vUv, tDepth);
      float wsum = 0.0, aosum = 0.0;
      // 5-tap depth-aware bilateral on the half-res AO buffer
      vec2 o0 = vec2(0.0, 0.0), o1 = vec2(1.0, 0.0), o2 = vec2(-1.0, 0.0),
           o3 = vec2(0.0, 1.0), o4 = vec2(0.0, -1.0);
      float a0 = texture2D(tAO, vUv + o0 * uTexelAO).r; float z0 = linZ(vUv + o0 * uTexelAO, tDepth);
      float a1 = texture2D(tAO, vUv + o1 * uTexelAO).r; float z1 = linZ(vUv + o1 * uTexelAO, tDepth);
      float a2 = texture2D(tAO, vUv + o2 * uTexelAO).r; float z2 = linZ(vUv + o2 * uTexelAO, tDepth);
      float a3 = texture2D(tAO, vUv + o3 * uTexelAO).r; float z3 = linZ(vUv + o3 * uTexelAO, tDepth);
      float a4 = texture2D(tAO, vUv + o4 * uTexelAO).r; float z4 = linZ(vUv + o4 * uTexelAO, tDepth);
      float w0 = exp(-abs(z0 - zc) * 0.45);
      float w1 = exp(-abs(z1 - zc) * 0.45);
      float w2 = exp(-abs(z2 - zc) * 0.45);
      float w3 = exp(-abs(z3 - zc) * 0.45);
      float w4 = exp(-abs(z4 - zc) * 0.45);
      aosum = a0*w0 + a1*w1 + a2*w2 + a3*w3 + a4*w4;
      wsum = w0 + w1 + w2 + w3 + w4;
      float ao = aosum / max(wsum, 1e-4);
      col.rgb *= mix(1.0, ao, uIntensity);
      gl_FragColor = col;
    }`,
};

export class AmbientOcclusionPass extends Pass {
  constructor() {
    super();
    this.needsSwap = true;
    this.aoRT = new THREE.WebGLRenderTarget(2, 2, {
      depthBuffer: false, stencilBuffer: false, type: THREE.UnsignedByteType,
    });
    this.aoMaterial = new THREE.ShaderMaterial(AO_SHADER);
    this.compMaterial = new THREE.ShaderMaterial(AO_COMPOSITE_SHADER);
    this.fsqAO = new FullScreenQuad(this.aoMaterial);
    this.fsqComp = new FullScreenQuad(this.compMaterial);
    this.depthTex = null;
  }

  setSize(w, h) {
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    this.aoRT.setSize(hw, hh);
    this.aoMaterial.uniforms.uTexel.value.set(1 / hw, 1 / hh);
    this.compMaterial.uniforms.uTexelAO.value.set(1 / hw, 1 / hh);
  }

  setCamera(camera) {
    this.compMaterial.uniforms.uNearFar.value.set(camera.near, camera.far);
    this.aoMaterial.uniforms.uInvProj.value.copy(camera.projectionMatrix).invert();
  }

  /**
   * The composer ping-pongs its buffers, so only renderTarget1 holds the depth
   * the RenderPass wrote. Pass it in explicitly instead of trusting readBuffer.
   */
  setDepthTexture(tex) { this.depthTex = tex; }

  render(renderer, writeBuffer, readBuffer) {
    const depth = this.depthTex || readBuffer.depthTexture;
    this.aoMaterial.uniforms.tDepth.value = depth;
    renderer.setRenderTarget(this.aoRT);
    drawQuad(renderer, this.fsqAO);

    const u = this.compMaterial.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tAO.value = this.aoRT.texture;
    u.tDepth.value = depth;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    drawQuad(renderer, this.fsqComp);
  }

  dispose() {
    this.aoRT.dispose();
    this.aoMaterial.dispose();
    this.compMaterial.dispose();
    this.fsqAO.dispose();
    this.fsqComp.dispose();
  }
}

/* =============================================================== BOKEH DOF
 * Single-pass, CoC-weighted gather using the depth the TAA pass already has.
 * Deliberately subtle: it separates the car from the neon backdrop instead of
 * turning the game into a blur simulator.
 */
const DOF_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uFocus: { value: 9.0 },
    uRange: { value: 55.0 },
    uMaxRadius: { value: 5.5 },
    uNearFar: { value: new THREE.Vector2(0.3, 3200) },
  },
  vertexShader: QUAD_VS,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uFocus;
    uniform float uRange;
    uniform float uMaxRadius;
    varying vec2 vUv;
    ${LINZ_GLSL}

    float cocAt(vec2 uv) {
      float z = linZ(uv, tDepth);
      float c = clamp(abs(z - uFocus) / uRange, 0.0, 1.0);
      return c * c * (3.0 - 2.0 * c);
    }

    void main() {
      float coc = cocAt(vUv);
      vec3 center = texture2D(tDiffuse, vUv).rgb;
      if (coc < 0.01) { gl_FragColor = vec4(center, 1.0); return; }
      float rad = coc * uMaxRadius;
      vec3 acc = center * (0.4 + coc);
      float wsum = 0.4 + coc;
      for (int i = 0; i < 12; i++) {
        float fi = float(i);
        float ang = fi * 2.39996323;
        float rr = sqrt((fi + 0.5) / 12.0);
        vec2 uv2 = vUv + vec2(cos(ang), sin(ang)) * rr * rad * uTexel;
        float w = cocAt(uv2);
        vec3 s = texture2D(tDiffuse, uv2).rgb;
        acc += s * w;
        wsum += w;
      }
      vec3 blurred = acc / max(wsum, 1e-4);
      gl_FragColor = vec4(mix(center, blurred, clamp(coc * 1.7, 0.0, 1.0)), 1.0);
    }`,
};

export class DOFPass extends Pass {
  constructor() {
    super();
    this.needsSwap = true;
    this.material = new THREE.ShaderMaterial(DOF_SHADER);
    this.fsq = new FullScreenQuad(this.material);
    this.depthTex = null;
  }

  setSize(w, h) { this.material.uniforms.uTexel.value.set(1 / w, 1 / h); }

  setDepthTexture(tex) { this.depthTex = tex; }

  setCamera(camera) {
    this.material.uniforms.uNearFar.value.set(camera.near, camera.far);
  }

  setFocus(dist) { this.material.uniforms.uFocus.value = dist; }

  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.material.uniforms.tDepth.value = this.depthTex || readBuffer.depthTexture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    drawQuad(renderer, this.fsq);
  }

  dispose() { this.material.dispose(); this.fsq.dispose(); }
}

/* =============================================================== PRESENT
 * The display-resolution finish: chromatic aberration, radial speed blur,
 * CAS sharpening (the "upscale present" step of the temporal pipeline),
 * 3D LUT grading, vignette and film grain — one pass, one draw.
 */
const PRESENT_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTexelIn: { value: new THREE.Vector2() },
    uOutRes: { value: new THREE.Vector2() },
    uLut: { value: null },
    uLutSize: { value: 32 },
    uLutMix: { value: 1 },
    uSharpen: { value: 0.6 },
    uGrain: { value: 0.026 },
    uCA: { value: 0.0016 },
    uBlur: { value: 0 },
    uTime: { value: 0 },
    uPhoto: { value: 0 },
  },
  vertexShader: QUAD_VS,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler3D uLut;
    uniform vec2 uTexelIn;
    uniform vec2 uOutRes;
    uniform float uLutSize;
    uniform float uLutMix;
    uniform float uSharpen;
    uniform float uGrain;
    uniform float uCA;
    uniform float uBlur;
    uniform float uTime;
    uniform float uPhoto;
    varying vec2 vUv;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

    void main() {
      vec2 uv = vUv;
      vec2 d = uv - 0.5;

      // chromatic aberration towards the edges
      vec3 c;
      c.r = texture2D(tDiffuse, uv + d * uCA).r;
      c.g = texture2D(tDiffuse, uv).g;
      c.b = texture2D(tDiffuse, uv - d * uCA).b;

      // radial speed blur
      if (uBlur > 0.001) {
        vec2 dir = d * uBlur * 0.055;
        vec3 acc = c;
        acc += texture2D(tDiffuse, uv - dir).rgb;
        acc += texture2D(tDiffuse, uv - dir * 2.0).rgb;
        acc += texture2D(tDiffuse, uv - dir * 3.0).rgb;
        c = acc * 0.25;
      }

      // CAS: contrast-adaptive sharpen in source space (clamped => no ringing)
      vec3 nN = texture2D(tDiffuse, uv + vec2( 0.0, -1.0) * uTexelIn).rgb;
      vec3 nS = texture2D(tDiffuse, uv + vec2( 0.0,  1.0) * uTexelIn).rgb;
      vec3 nW = texture2D(tDiffuse, uv + vec2(-1.0,  0.0) * uTexelIn).rgb;
      vec3 nE = texture2D(tDiffuse, uv + vec2( 1.0,  0.0) * uTexelIn).rgb;
      vec3 mn = min(c, min(min(nN, nS), min(nW, nE)));
      vec3 mx = max(c, max(max(nN, nS), max(nW, nE)));
      float w = uSharpen;
      vec3 sharp = (c * (4.0 * w + 1.0) - (nN + nS + nW + nE) * w) / (4.0 * w + 1.0);
      c = clamp(sharp, mn, mx);

      // 3D LUT grade (display space)
      if (uLutMix > 0.001 && uLutSize > 1.0) {
        float pw = 1.0 / uLutSize;
        vec3 uvw = vec3(pw * 0.5) + clamp(c, 0.0, 1.0) * (1.0 - pw);
        c = mix(c, texture(uLut, uvw).rgb, uLutMix);
      }

      // vignette (deeper in photo mode)
      float v = smoothstep(mix(0.92, 0.86, uPhoto), mix(0.30, 0.22, uPhoto), length(d) * 1.35);
      c *= mix(mix(0.62, 0.5, uPhoto), 1.0, v);

      // fine film grain
      float n = hash(uv * uOutRes + fract(uTime) * 137.0);
      c += (n - 0.5) * uGrain * (1.0 + uPhoto * 0.6);

      gl_FragColor = vec4(c, 1.0);
    }`,
};

export class PresentPass extends Pass {
  constructor() {
    super();
    this.needsSwap = false;
    this.material = new THREE.ShaderMaterial(PRESENT_SHADER);
    this.fsq = new FullScreenQuad(this.material);
  }

  setSize(w, h) { this.material.uniforms.uOutRes.value.set(w, h); }

  setInternalSize(w, h) { this.material.uniforms.uTexelIn.value.set(1 / w, 1 / h); }

  render(renderer, writeBuffer, readBuffer) {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    drawQuad(renderer, this.fsq);
  }

  dispose() { this.material.dispose(); this.fsq.dispose(); }
}
