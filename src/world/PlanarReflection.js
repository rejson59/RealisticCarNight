import * as THREE from 'three';

/**
 * Planar reflection for the wet-asphalt look.
 * Renders the scene from a mirrored camera into an HDR target and blends it
 * over the road with a puddle mask + fresnel, so dry parts stay matte and
 * puddles mirror the neon city. Based on the classic reflector math.
 */
export class WetGroundReflection extends THREE.Mesh {
  constructor(width, height, res = 512, maskTexture = null) {
    const geometry = new THREE.PlaneGeometry(width, height);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        textureMatrix: { value: new THREE.Matrix4() },
        uMask: { value: maskTexture },
        uTime: { value: 0 },
        uStrength: { value: 1.0 },
        uRes: { value: new THREE.Vector2(res, res) },
      },
      vertexShader: /* glsl */`
        uniform mat4 textureMatrix;
        varying vec4 vUv;
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          vUv = textureMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D uMask;
        uniform float uTime;
        uniform float uStrength;
        uniform vec2 uRes;
        varying vec4 vUv;
        varying vec3 vWorld;

        void main() {
          vec2 m1 = texture2D(uMask, vWorld.xz * 0.016).rg;
          vec2 m2 = texture2D(uMask, vWorld.xz * 0.052 + 0.37).rg;
          float puddle = smoothstep(0.42, 0.66, m1.r * 0.7 + m2.r * 0.55);

          // animated micro-ripples, stronger inside puddles
          float w = sin(uTime * 1.6 + vWorld.x * 0.35 + vWorld.z * 0.27)
                  + sin(uTime * 1.1 - vWorld.z * 0.41 + vWorld.x * 0.13);
          vec2 ripple = (vec2(m1.g, m2.g) - 0.5) * (0.0035 + 0.011 * puddle) * (0.65 + 0.35 * w);

          vec4 uv = vUv;
          uv.xy += ripple * vUv.w;
          vec3 refl = texture2DProj(tDiffuse, uv).rgb;
          vec3 blur = texture2DProj(tDiffuse, uv + vec4(1.7 / uRes.x, 1.7 / uRes.y, 0.0, 0.0) * vUv.w).rgb;
          refl = mix(refl, blur, 0.4);

          vec3 V = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 2.6);

          // whole road is wet at night (reference look), puddles are mirrors
          float wet = mix(0.42, 1.0, puddle);
          float strength = uStrength * (0.20 + 0.80 * fres) * (0.35 + 0.65 * wet);
          strength = clamp(strength, 0.0, 0.94);

          gl_FragColor = vec4(refl * strength * 1.12, strength);
        }
      `,
      transparent: true,
      depthWrite: false,
    });

    super(geometry, material);
    this.renderTarget = new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });
    this.material.uniforms.tDiffuse.value = this.renderTarget.texture;

    this.virtualCamera = new THREE.PerspectiveCamera();
    this.clipBias = 0.003;
    this.enabled = true;
    this.frameInterval = 1; // re-render the mirror every N frames (perf)
    this._frame = 0;

    this._reflectorWorldPosition = new THREE.Vector3();
    this._cameraWorldPosition = new THREE.Vector3();
    this._rotationMatrix = new THREE.Matrix4();
    this._normal = new THREE.Vector3();
    this._view = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._lookAtPosition = new THREE.Vector3();
    this._clipPlane = new THREE.Vector4();
    this._q = new THREE.Vector4();
    this._reflectorPlane = new THREE.Plane();
  }

  setResolution(res) {
    this.renderTarget.setSize(res, res);
    this.material.uniforms.uRes.value.set(res, res);
  }

  onBeforeRender(renderer, scene, camera) {
    if (!this.enabled || !this.visible) return;
    this._frame += 1;
    const skipRender = this._frame % this.frameInterval !== 0;

    const rp = this._reflectorWorldPosition.setFromMatrixPosition(this.matrixWorld);
    const cp = this._cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
    const rotationMatrix = this._rotationMatrix.extractRotation(this.matrixWorld);
    const normal = this._normal.set(0, 0, 1).applyMatrix4(rotationMatrix);
    const view = this._view.subVectors(rp, cp);
    if (view.dot(normal) > 0) return;

    view.reflect(normal).negate();
    view.add(rp);

    rotationMatrix.extractRotation(camera.matrixWorld);
    const lookAtPosition = this._lookAtPosition.set(0, 0, -1).applyMatrix4(rotationMatrix).add(cp);
    const target = this._target.subVectors(rp, lookAtPosition);
    target.reflect(normal).negate();
    target.add(rp);

    const virtualCamera = this.virtualCamera;
    virtualCamera.position.copy(view);
    virtualCamera.up.set(0, 1, 0).applyMatrix4(rotationMatrix);
    virtualCamera.up.reflect(normal);
    virtualCamera.lookAt(target);
    virtualCamera.far = camera.far;
    virtualCamera.near = camera.near;
    virtualCamera.updateMatrixWorld();
    virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

    const textureMatrix = this.material.uniforms.textureMatrix.value;
    textureMatrix.set(
      0.5, 0.0, 0.0, 0.5,
      0.0, 0.5, 0.0, 0.5,
      0.0, 0.0, 0.5, 0.5,
      0.0, 0.0, 0.0, 1.0
    );
    textureMatrix.multiply(virtualCamera.projectionMatrix);
    textureMatrix.multiply(virtualCamera.matrixWorldInverse);
    textureMatrix.multiply(this.matrixWorld);

    // oblique near-plane clipping so nothing below the mirror plane leaks in
    const reflectorPlane = this._reflectorPlane.setFromNormalAndCoplanarPoint(normal, rp);
    reflectorPlane.applyMatrix4(camera.matrixWorldInverse);
    const clipPlane = this._clipPlane.set(
      reflectorPlane.normal.x, reflectorPlane.normal.y, reflectorPlane.normal.z,
      reflectorPlane.constant
    );
    const projectionMatrix = virtualCamera.projectionMatrix;
    const q = this._q;
    q.x = (Math.sign(clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
    q.y = (Math.sign(clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
    q.z = -1.0;
    q.w = (1.0 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];
    clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));
    projectionMatrix.elements[2] = clipPlane.x;
    projectionMatrix.elements[6] = clipPlane.y;
    projectionMatrix.elements[10] = clipPlane.z + 1.0 - this.clipBias;
    projectionMatrix.elements[14] = clipPlane.w;

    if (skipRender) return; // reuse the previous mirror frame
    this.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevClearColor = renderer.getClearColor(new THREE.Color());
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x05070d, 1);
    renderer.setRenderTarget(this.renderTarget);
    renderer.clear();
    renderer.render(scene, virtualCamera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    this.visible = true;
  }

  dispose() {
    this.renderTarget.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
